import dotenv from 'dotenv';
import { loadSecurityPolicy, type ScoutDeploymentMode } from './lib/securityPolicy';
import { resolveLicenseTierFromEnv, SELF_HOST_LICENSE_TIERS } from './lib/selfHostLicense';

dotenv.config({ path: process.env.SCOUT_ENV_PATH || undefined });
dotenv.config();

/** Customer tiers: free | basic | pro. paid/enterprise kept for legacy env keys. */
export type ScoutKeyTier = 'internal' | 'demo' | 'free' | 'basic' | 'pro' | 'paid' | 'enterprise';

export type ScoutApiKeyRecord = {
  key: string;
  tier: ScoutKeyTier;
  rateLimitPerMinute?: number;
  label?: string;
  webhookSecret?: string;
  /** Account-backed key pending platform authorize */
  accountBacked?: boolean;
};

function parseExternalKeys(raw: string | undefined): ScoutApiKeyRecord[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ScoutApiKeyRecord[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const key = typeof r.key === 'string' ? r.key.trim() : '';
      if (!key) continue;
      const tierRaw = typeof r.tier === 'string' ? r.tier : 'free';
      const tier: ScoutKeyTier =
        tierRaw === 'paid'
        || tierRaw === 'basic'
        || tierRaw === 'pro'
        || tierRaw === 'enterprise'
        || tierRaw === 'internal'
        || tierRaw === 'demo'
          ? (tierRaw as ScoutKeyTier)
          : 'free';
      const rateLimitPerMinute =
        typeof r.rateLimitPerMinute === 'number' && Number.isFinite(r.rateLimitPerMinute)
          ? Math.max(1, Math.floor(r.rateLimitPerMinute))
          : tier === 'demo'
            ? 12
            : tier === 'pro' || tier === 'enterprise'
            ? 250
            : tier === 'paid' || tier === 'basic'
              ? 120
              : 30;
      out.push({
        key,
        tier,
        rateLimitPerMinute,
        label: typeof r.label === 'string' ? r.label : undefined,
        webhookSecret: typeof r.webhookSecret === 'string' ? r.webhookSecret : undefined,
      });
    }
    return out;
  } catch {
    console.warn('[scout] SCOUT_API_KEYS is not valid JSON — ignoring');
    return [];
  }
}

const internalKey = (process.env.SCOUT_INTERNAL_API_KEY || '').trim();
const demoKey = (process.env.SCOUT_DEMO_API_KEY || '').trim();
const globalWebhookSecret = (process.env.SCOUT_WEBHOOK_SECRET || '').trim() || null;

const keys: ScoutApiKeyRecord[] = [];
if (demoKey && demoKey !== internalKey) {
  keys.push({
    key: demoKey,
    tier: 'demo',
    label: 'marketing-demo',
    rateLimitPerMinute: Number(process.env.SCOUT_DEMO_RATE_LIMIT_PER_MINUTE || 12),
    webhookSecret: globalWebhookSecret || undefined,
  });
}
if (internalKey) {
  keys.push({
    key: internalKey,
    tier: 'internal',
    label: 'macro-internal',
    webhookSecret: globalWebhookSecret || undefined,
  });
}
keys.push(...parseExternalKeys(process.env.SCOUT_API_KEYS));

export type { ScoutDeploymentMode } from './lib/securityPolicy';

const deploymentMode: ScoutDeploymentMode =
  process.env.SCOUT_DEPLOYMENT_MODE === 'self_hosted' ? 'self_hosted' : 'hosted';

const securityPolicy = loadSecurityPolicy(deploymentMode);
const licenseTier = deploymentMode === 'self_hosted' ? resolveLicenseTierFromEnv() : null;
const licenseLimits = licenseTier ? SELF_HOST_LICENSE_TIERS[licenseTier] : null;

export const scoutConfig = {
  deploymentMode,
  securityPolicy,
  licenseTier,
  licenseLimits,
  port: Number(process.env.SCOUT_PORT || process.env.PORT || 3009),
  keys,
  allowPrivateNetworks: securityPolicy.allowPrivateNetworks,
  requireDomainVerify: securityPolicy.requireDomainVerification,
  /** Commercial self-host license (`lic_scout_…`) — validated against platform or offline JWT (planned). */
  licenseKey: (process.env.SCOUT_LICENSE_KEY || '').trim() || null,
  respectRobotsDefault: process.env.SCOUT_RESPECT_ROBOTS !== 'false',
  resultCacheTtlSeconds: Number(process.env.SCOUT_RESULT_CACHE_TTL_SECONDS || 60),
  jobTtlSeconds: Number(process.env.SCOUT_JOB_TTL_SECONDS || 1800),
  redisUrl: (process.env.SCOUT_REDIS_URL || '').trim() || null,
  domainReverifyDays: Number(process.env.SCOUT_DOMAIN_REVERIFY_DAYS || 90),
  userAgent: process.env.SCOUT_USER_AGENT || 'MacroScout/0.5 (+https://api.scout.macrocontent.dev)',
  webhookSecret: globalWebhookSecret,
  /** Platform API for account-backed keys + credits (backend, not scout itself). */
  platformApiBaseUrl:
    (process.env.SCOUT_PLATFORM_API_BASE_URL || 'http://localhost:3000').trim(),
  platformSecret: (
    process.env.SCOUT_PLATFORM_SECRET
    || process.env.SCOUT_INTERNAL_API_KEY
    || ''
  ).trim() || null,
};

export function findApiKey(presented: string | undefined | null): ScoutApiKeyRecord | null {
  const key = presented?.trim();
  if (!key) return null;
  const envHit = scoutConfig.keys.find((k) => k.key === key);
  if (envHit) return envHit;
  if (key.startsWith('sk_scout_')) {
    return {
      key,
      tier: 'free',
      label: 'account',
      accountBacked: true,
      rateLimitPerMinute: 30,
    };
  }
  return null;
}
