import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { scoutConfig } from '../config';
import type { SelfHostLicenseTierId } from './selfHostLicense';
import { applyWorkerLimitFromLicense, assertWorkerCountWithinLicense } from './workerLimits';

export type LicenseState = {
  valid: boolean;
  tier: SelfHostLicenseTierId | null;
  maxWorkers: number | null;
  maxDeployments: number | null;
  validUntil: string | null;
  offlineToken: string | null;
  lastCheckAt: number;
  lastError: string | null;
  instanceId: string;
};

const STATE_DIR = process.env.SCOUT_LICENSE_STATE_DIR?.trim() || join(process.cwd(), '.scout');
const INSTANCE_FILE = join(STATE_DIR, 'instance-id');
const OFFLINE_FILE = join(STATE_DIR, 'license-offline.jwt');

let state: LicenseState = {
  valid: false,
  tier: null,
  maxWorkers: null,
  maxDeployments: null,
  validUntil: null,
  offlineToken: null,
  lastCheckAt: 0,
  lastError: null,
  instanceId: resolveInstanceId(),
};

function resolveInstanceId(): string {
  const fromEnv = (process.env.SCOUT_INSTANCE_ID || '').trim();
  if (fromEnv) return fromEnv.slice(0, 80);

  try {
    if (existsSync(INSTANCE_FILE)) {
      const id = readFileSync(INSTANCE_FILE, 'utf8').trim();
      if (id) return id.slice(0, 80);
    }
    mkdirSync(STATE_DIR, { recursive: true });
    const id = randomUUID();
    writeFileSync(INSTANCE_FILE, id, 'utf8');
    return id;
  } catch {
    return randomUUID();
  }
}

function readOfflineToken(): string | null {
  try {
    if (!existsSync(OFFLINE_FILE)) return null;
    return readFileSync(OFFLINE_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeOfflineToken(token: string) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(OFFLINE_FILE, token, 'utf8');
  } catch (err) {
    console.warn('[scout/license] could not persist offline token', err);
  }
}

export function getLicenseState(): LicenseState {
  return { ...state };
}

export async function refreshLicenseFromPlatform(): Promise<LicenseState> {
  if (scoutConfig.deploymentMode !== 'self_hosted') {
    state = { ...state, valid: true, lastError: null, lastCheckAt: Date.now() };
    return state;
  }

  const licenseKey = scoutConfig.licenseKey;
  if (!licenseKey) {
    state = {
      ...state,
      valid: false,
      lastError: 'SCOUT_LICENSE_KEY is required in self_hosted mode',
      lastCheckAt: Date.now(),
    };
    return state;
  }

  const platformBase = scoutConfig.platformApiBaseUrl;
  if (!platformBase) {
    state = {
      ...state,
      valid: false,
      lastError: 'SCOUT_PLATFORM_API_BASE_URL required for license validation',
      lastCheckAt: Date.now(),
    };
    return state;
  }

  const workerCount = Number(process.env.SCOUT_WORKER_COUNT || '1');
  const hostname = (process.env.SCOUT_INSTANCE_HOSTNAME || process.env.HOSTNAME || '').trim() || undefined;
  const deploymentName = (process.env.SCOUT_DEPLOYMENT_NAME || '').trim() || undefined;
  const scoutVersion = process.env.SCOUT_VERSION || '0.7.0';

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // Optional: cloud-internal Scout may still send the service secret; self-host customers do not need it.
    if (scoutConfig.platformSecret) {
      headers['X-Scout-Platform-Secret'] = scoutConfig.platformSecret;
    }
    const res = await fetch(`${platformBase.replace(/\/$/, '')}/internal/scout/license/validate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        license_key: licenseKey,
        instance_id: state.instanceId,
        worker_count: Number.isFinite(workerCount) ? Math.max(1, workerCount) : 1,
        deployment_name: deploymentName,
        hostname,
        scout_version: scoutVersion,
      }),
      signal: AbortSignal.timeout(12_000),
    });

    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || data.ok === false) {
      const offline = readOfflineToken();
      if (offline && isOfflineTokenUsable(offline)) {
        applyOfflineClaims(offline);
        state = {
          ...state,
          valid: true,
          offlineToken: offline,
          lastError: String(data.error || 'Online validation failed — using offline grace token'),
          lastCheckAt: Date.now(),
        };
        applyWorkerLimitFromLicense();
        return state;
      }
      state = {
        ...state,
        valid: false,
        lastError: String(data.error || 'License validation failed'),
        lastCheckAt: Date.now(),
      };
      return state;
    }

    const offlineToken = typeof data.offline_token === 'string' ? data.offline_token : null;
    if (offlineToken) writeOfflineToken(offlineToken);

    const tierRaw = String(data.tier || 'developer');
    state = {
      ...state,
      valid: true,
      tier: tierRaw as SelfHostLicenseTierId,
      maxWorkers: typeof data.max_workers === 'number' ? data.max_workers : null,
      maxDeployments: typeof data.max_deployments === 'number' ? data.max_deployments : null,
      validUntil: typeof data.valid_until === 'string' ? data.valid_until : null,
      offlineToken,
      lastError: null,
      lastCheckAt: Date.now(),
    };
    applyWorkerLimitFromLicense();
    return state;
  } catch (err) {
    const offline = readOfflineToken();
    if (offline && isOfflineTokenUsable(offline)) {
      applyOfflineClaims(offline);
      state = {
        ...state,
        valid: true,
        offlineToken: offline,
        lastError: `Heartbeat failed (${err instanceof Error ? err.message : String(err)}) — offline grace`,
        lastCheckAt: Date.now(),
      };
      applyWorkerLimitFromLicense();
      return state;
    }
    state = {
      ...state,
      valid: false,
      lastError: err instanceof Error ? err.message : String(err),
      lastCheckAt: Date.now(),
    };
    return state;
  }
}

function parseOfflineClaims(token: string): {
  max_workers?: number;
  tier?: SelfHostLicenseTierId;
} | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (payload.type !== 'scout_license') return null;
    return {
      max_workers: typeof payload.max_workers === 'number' ? payload.max_workers : undefined,
      tier: typeof payload.tier === 'string' ? (payload.tier as SelfHostLicenseTierId) : undefined,
    };
  } catch {
    return null;
  }
}

function applyOfflineClaims(token: string) {
  const claims = parseOfflineClaims(token);
  if (!claims) return;
  if (claims.tier) state = { ...state, tier: claims.tier };
  if (claims.max_workers != null) state = { ...state, maxWorkers: claims.max_workers };
}

function isOfflineTokenUsable(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
    if (!payload.exp) return false;
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startLicenseHeartbeat(intervalMs = 5 * 60 * 1000) {
  if (scoutConfig.deploymentMode !== 'self_hosted') return;
  if (heartbeatTimer) return;

  void refreshLicenseFromPlatform();
  heartbeatTimer = setInterval(() => {
    void refreshLicenseFromPlatform();
  }, intervalMs);
  heartbeatTimer.unref?.();
}

export async function ensureLicenseOnStartup(): Promise<void> {
  if (scoutConfig.deploymentMode !== 'self_hosted') return;

  const result = await refreshLicenseFromPlatform();
  if (!result.valid) {
    console.error(`[scout/license] FATAL: ${result.lastError || 'Invalid license'}`);
    console.error('[scout/license] Self-hosted Scout cannot start without a valid SCOUT_LICENSE_KEY.');
    process.exit(1);
  }
  const workerErr = assertWorkerCountWithinLicense();
  if (workerErr) {
    console.error(`[scout/license] FATAL: ${workerErr}`);
    process.exit(1);
  }

  const limit = applyWorkerLimitFromLicense();
  console.log(
    `[scout/license] OK tier=${result.tier} max_workers=${result.maxWorkers} concurrent=${limit} instance=${result.instanceId}`,
  );
  startLicenseHeartbeat();
}
