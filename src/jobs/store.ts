import { randomUUID } from 'crypto';
import { scoutConfig } from '../config';
import { buildSignedWebhookHeaders } from '../lib/webhook';

export type ScoutJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type ScoutJob = {
  id: string;
  status: ScoutJobStatus;
  created_at: string;
  updated_at: string;
  /** ISO timestamp after which the job is deleted (short poll window, not archive). */
  expires_at: string;
  request: unknown;
  result?: unknown;
  error?: string;
  webhook_url?: string;
  /** HMAC secret for this job (never returned in API). */
  webhook_secret?: string;
};

const jobs = new Map<string, ScoutJob>();
const MAX_JOBS = 500;

function ttlMs(): number {
  return Math.max(60, scoutConfig.jobTtlSeconds) * 1000;
}

function trimJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (new Date(job.expires_at).getTime() < now) jobs.delete(id);
  }
  if (jobs.size <= MAX_JOBS) return;
  const ordered = [...jobs.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const job of ordered.slice(0, jobs.size - MAX_JOBS)) {
    jobs.delete(job.id);
  }
}

setInterval(() => trimJobs(), 60_000).unref?.();

export function createJob(
  request: unknown,
  webhookUrl?: string,
  webhookSecret?: string | null,
): ScoutJob {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const job: ScoutJob = {
    id: randomUUID(),
    status: 'queued',
    created_at: nowIso,
    updated_at: nowIso,
    expires_at: new Date(now + ttlMs()).toISOString(),
    request,
    webhook_url: webhookUrl,
    webhook_secret: webhookSecret?.trim() || undefined,
  };
  jobs.set(job.id, job);
  trimJobs();
  return job;
}

export function getJob(id: string): ScoutJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  if (new Date(job.expires_at).getTime() < Date.now()) {
    jobs.delete(id);
    return null;
  }
  return job;
}

export function updateJob(id: string, patch: Partial<ScoutJob>): ScoutJob | null {
  const job = getJob(id);
  if (!job) return null;
  Object.assign(job, patch, {
    updated_at: new Date().toISOString(),
    expires_at:
      patch.status === 'completed' || patch.status === 'failed'
        ? new Date(Date.now() + ttlMs()).toISOString()
        : job.expires_at,
  });
  return job;
}

export async function notifyWebhook(job: ScoutJob): Promise<void> {
  if (!job.webhook_url) return;
  const body = JSON.stringify({
    job_id: job.id,
    status: job.status,
    result: job.result,
    error: job.error,
    updated_at: job.updated_at,
    expires_at: job.expires_at,
  });

  const secret = job.webhook_secret || scoutConfig.webhookSecret;
  const headers = secret
    ? buildSignedWebhookHeaders(secret, body)
    : { 'Content-Type': 'application/json' };

  try {
    await fetch(job.webhook_url, {
      method: 'POST',
      headers,
      body,
    });
  } catch (err) {
    console.warn('[scout] webhook notify failed', job.id, err);
  }
}
