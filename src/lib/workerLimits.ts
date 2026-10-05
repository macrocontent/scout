import { scoutConfig } from '../config';
import { setBrowserConcurrencyLimit } from '../browser/concurrency';
import { getLicenseState } from './licenseClient';

function configuredWorkerCount(): number {
  const n = Number(process.env.SCOUT_WORKER_COUNT || '1');
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
}

/**
 * Effective parallel browser slots for this process.
 * Self-hosted: min(SCOUT_WORKER_COUNT, license max_workers).
 */
export function resolveEffectiveWorkerLimit(): number {
  const configured = configuredWorkerCount();

  if (scoutConfig.deploymentMode === 'self_hosted') {
    const licensed = getLicenseState().maxWorkers;
    if (licensed != null && licensed > 0) {
      return Math.min(configured, licensed);
    }
    return configured;
  }

  const hostedCap = Number(process.env.SCOUT_HOSTED_MAX_WORKERS || '8');
  return Math.min(Math.max(configured, 1), Number.isFinite(hostedCap) ? hostedCap : 8);
}

export function applyWorkerLimitFromLicense() {
  const limit = resolveEffectiveWorkerLimit();
  setBrowserConcurrencyLimit(limit);
  return limit;
}

export function assertWorkerCountWithinLicense(): string | null {
  if (scoutConfig.deploymentMode !== 'self_hosted') return null;
  const licensed = getLicenseState().maxWorkers;
  if (licensed == null) return null;
  const configured = configuredWorkerCount();
  if (configured > licensed) {
    return `SCOUT_WORKER_COUNT (${configured}) exceeds license limit (${licensed}). Lower SCOUT_WORKER_COUNT or upgrade your plan.`;
  }
  return null;
}
