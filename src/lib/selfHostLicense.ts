/**
 * Self-hosted license tiers — annual, worker-based, no per-request credits.
 * Keep in sync with backend/src/lib/scout/selfHostPricing.ts
 */

export type SelfHostLicenseTierId = 'developer' | 'developer_plus' | 'team' | 'business';

export type SelfHostLicenseTier = {
  id: SelfHostLicenseTierId;
  name: string;
  priceEurYearly: number;
  maxDeployments: number;
  maxWorkers: number;
  unlimitedApiCalls: boolean;
  support: string;
  deploymentLabel: string;
  usageTerms: string;
  notes?: string;
};

export const BROWSER_WORKER_DEFINITION =
  'One browser worker can run one active browser job at a time.';

export const DEVELOPER_LICENSE_TERMS =
  'Free Developer: development, evaluation, and personal projects only. Commercial use requires Developer+ or higher.';

export const SELF_HOST_LICENSE_TIERS: Record<SelfHostLicenseTierId, SelfHostLicenseTier> = {
  developer: {
    id: 'developer',
    name: 'Developer',
    priceEurYearly: 0,
    maxDeployments: 1,
    maxWorkers: 2,
    unlimitedApiCalls: true,
    support: 'Self-serve',
    deploymentLabel: '1 non-production deployment',
    usageTerms: DEVELOPER_LICENSE_TERMS,
    notes: 'One free license per account — not for commercial production. You operate the stack.',
  },
  developer_plus: {
    id: 'developer_plus',
    name: 'Developer+',
    priceEurYearly: 490,
    maxDeployments: 1,
    maxWorkers: 2,
    unlimitedApiCalls: true,
    support: 'Self-serve',
    deploymentLabel: '1 production deployment',
    usageTerms: 'Commercial use allowed — same worker limits as Developer.',
    notes: 'Entry paid tier — ~€41/mo billed yearly. Freelancers and small commercial projects. You operate the stack.',
  },
  team: {
    id: 'team',
    name: 'Team',
    priceEurYearly: 1_490,
    maxDeployments: 1,
    maxWorkers: 10,
    unlimitedApiCalls: true,
    support: 'Self-serve',
    deploymentLabel: '1 production deployment',
    usageTerms: 'Commercial production with higher parallel throughput.',
    notes: '~€149 per worker/year (~€124/mo) — best value for most teams. You operate the stack.',
  },
  business: {
    id: 'business',
    name: 'Business',
    priceEurYearly: 3_990,
    maxDeployments: 5,
    maxWorkers: 30,
    unlimitedApiCalls: true,
    support: 'Self-serve',
    deploymentLabel: '5 production deployments',
    usageTerms: 'Multiple clusters and environments under one license.',
    notes: '~€133 per worker/year (~€333/mo) — multi-env volume tier. You operate the stack.',
  },
};

export function formatYearlyPrice(tier: SelfHostLicenseTier): string {
  if (tier.priceEurYearly === 0) return 'Free';
  return `€${tier.priceEurYearly.toLocaleString('en-EU')}/year`;
}

export function resolveLicenseTierFromEnv(): SelfHostLicenseTierId {
  const raw = (process.env.SCOUT_LICENSE_TIER || 'developer').trim().toLowerCase();
  if (raw in SELF_HOST_LICENSE_TIERS) return raw as SelfHostLicenseTierId;
  return 'developer';
}
