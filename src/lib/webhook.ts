import { createHmac, timingSafeEqual } from 'crypto';
import type { ScoutApiKeyRecord } from '../config';
import { scoutConfig } from '../config';

export function resolveWebhookSecret(
  apiKey: ScoutApiKeyRecord | undefined,
  jobOverride?: string | null,
): string | null {
  if (jobOverride?.trim()) return jobOverride.trim();
  if (apiKey?.webhookSecret?.trim()) return apiKey.webhookSecret.trim();
  if (scoutConfig.webhookSecret?.trim()) return scoutConfig.webhookSecret.trim();
  return null;
}

export function signWebhookBody(secret: string, timestamp: string, rawBody: string): string {
  const payload = `${timestamp}.${rawBody}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function buildSignedWebhookHeaders(
  secret: string,
  rawBody: string,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signWebhookBody(secret, timestamp, rawBody);
  return {
    'Content-Type': 'application/json',
    'X-Scout-Timestamp': timestamp,
    'X-Scout-Signature': `sha256=${signature}`,
  };
}

/** Customer-side verification helper (also used in docs examples). */
export function verifyWebhookSignature(options: {
  secret: string;
  timestamp: string;
  signatureHeader: string;
  rawBody: string;
  /** Max age in seconds (default 300). */
  maxAgeSeconds?: number;
}): boolean {
  const maxAge = options.maxAgeSeconds ?? 300;
  const ts = Number(options.timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > maxAge) return false;

  const expected = `sha256=${signWebhookBody(options.secret, options.timestamp, options.rawBody)}`;
  const provided = options.signatureHeader.trim();
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
