export type ScoutDeploymentMode = 'hosted' | 'self_hosted';

export type ScoutSecurityPolicy = {
  requireDomainVerification: boolean;
  allowPrivateNetworks: boolean;
  allowedDomains: string[];
  blockedDomains: string[];
};

function parseDomainList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return undefined;
}

export function hostnameMatchesPattern(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === p;
}

export function assertHostnamePolicy(hostname: string, policy: ScoutSecurityPolicy): void {
  const host = hostname.toLowerCase();
  if (policy.blockedDomains.some((pattern) => hostnameMatchesPattern(host, pattern))) {
    throw new Error(`Blocked domain: ${hostname}`);
  }
  if (policy.allowedDomains.length > 0) {
    const allowed = policy.allowedDomains.some((pattern) => hostnameMatchesPattern(host, pattern));
    if (!allowed) {
      throw new Error(`Domain not in allowlist: ${hostname}`);
    }
  }
}

export function loadSecurityPolicy(
  deploymentMode: ScoutDeploymentMode,
  env: NodeJS.ProcessEnv = process.env,
): ScoutSecurityPolicy {
  const jsonRaw = env.SCOUT_SECURITY_POLICY?.trim();
  let jsonRequire: boolean | undefined;
  let jsonPrivate: boolean | undefined;
  let jsonAllowed: string[] | undefined;
  let jsonBlocked: string[] | undefined;
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw) as Record<string, unknown>;
      if (typeof parsed.requireDomainVerification === 'boolean') {
        jsonRequire = parsed.requireDomainVerification;
      }
      if (typeof parsed.allowPrivateNetworks === 'boolean') {
        jsonPrivate = parsed.allowPrivateNetworks;
      }
      if (Array.isArray(parsed.allowedDomains)) {
        jsonAllowed = parsed.allowedDomains.filter((d): d is string => typeof d === 'string');
      }
      if (Array.isArray(parsed.blockedDomains)) {
        jsonBlocked = parsed.blockedDomains.filter((d): d is string => typeof d === 'string');
      }
    } catch {
      console.warn('[scout] SCOUT_SECURITY_POLICY is not valid JSON — using env defaults');
    }
  }

  const requireExplicit = parseBool(env.SCOUT_REQUIRE_DOMAIN_VERIFY);
  const allowPrivateExplicit = parseBool(env.SCOUT_ALLOW_PRIVATE_NETWORKS);

  /** Self-hosted always skips DNS verify — the operator owns the box. */
  const requireDomainVerification =
    deploymentMode === 'self_hosted'
      ? false
      : (jsonRequire ?? requireExplicit ?? true);

  const allowPrivateNetworks =
    allowPrivateExplicit
    ?? jsonPrivate
    ?? (deploymentMode === 'self_hosted'
      ? false
      : env.NODE_ENV !== 'production');

  return {
    requireDomainVerification,
    allowPrivateNetworks,
    allowedDomains: jsonAllowed?.length ? jsonAllowed : parseDomainList(env.SCOUT_ALLOWED_DOMAINS),
    blockedDomains: jsonBlocked?.length ? jsonBlocked : parseDomainList(env.SCOUT_BLOCKED_DOMAINS),
  };
}
