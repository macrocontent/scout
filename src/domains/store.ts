import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { scoutConfig } from '../config';
import { lookupTxtCandidates, normalizeHostname } from '../lib/dnsLookup';

export type DomainStatus = 'pending' | 'verified';

export type ScoutDomain = {
  id: string;
  /** sha256 of API key — never store raw key */
  owner_key_hash: string;
  hostname: string;
  status: DomainStatus;
  challenge: {
    type: 'dns_txt';
    /** Preferred DNS name for the TXT record */
    name: string;
    /** Full TXT value to set */
    value: string;
    /** Token portion after scout-verify= */
    token: string;
  };
  created_at: string;
  verified_at: string | null;
  last_check_at: string | null;
  last_error: string | null;
};

type StoreFile = { domains: ScoutDomain[] };

function dataDir(): string {
  return process.env.SCOUT_DATA_DIR || path.join(process.cwd(), 'data');
}

function storePath(): string {
  return path.join(dataDir(), 'domains.json');
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function readStore(): StoreFile {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed.domains || !Array.isArray(parsed.domains)) return { domains: [] };
    return parsed;
  } catch {
    return { domains: [] };
  }
}

function writeStore(store: StoreFile): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

function newId(): string {
  return `dom_${randomBytes(12).toString('hex')}`;
}

function newToken(): string {
  return randomBytes(24).toString('hex');
}

export function listDomainsForKey(apiKey: string): ScoutDomain[] {
  const hash = hashApiKey(apiKey);
  return readStore().domains.filter((d) => d.owner_key_hash === hash);
}

export function getDomainForKey(apiKey: string, id: string): ScoutDomain | null {
  const hash = hashApiKey(apiKey);
  return readStore().domains.find((d) => d.id === id && d.owner_key_hash === hash) ?? null;
}

export function createDomain(apiKey: string, hostnameRaw: string): ScoutDomain {
  const hostname = normalizeHostname(hostnameRaw);
  const hash = hashApiKey(apiKey);
  const store = readStore();

  const existing = store.domains.find((d) => d.owner_key_hash === hash && d.hostname === hostname);
  if (existing) return existing;

  const token = newToken();
  const value = `scout-verify=${token}`;
  const domain: ScoutDomain = {
    id: newId(),
    owner_key_hash: hash,
    hostname,
    status: 'pending',
    challenge: {
      type: 'dns_txt',
      name: `_scout-verify.${hostname}`,
      value,
      token,
    },
    created_at: new Date().toISOString(),
    verified_at: null,
    last_check_at: null,
    last_error: null,
  };
  store.domains.push(domain);
  writeStore(store);
  return domain;
}

export function deleteDomain(apiKey: string, id: string): boolean {
  const hash = hashApiKey(apiKey);
  const store = readStore();
  const before = store.domains.length;
  store.domains = store.domains.filter((d) => !(d.id === id && d.owner_key_hash === hash));
  if (store.domains.length === before) return false;
  writeStore(store);
  return true;
}

function hostMatchesVerified(hostname: string, verifiedHostname: string): boolean {
  const h = hostname.toLowerCase();
  const v = verifiedHostname.toLowerCase();
  return h === v || h.endsWith(`.${v}`);
}

/** Internal keys bypass ownership checks; self-hosted policy can disable verify entirely. */
export function bypassesDomainVerify(tier: string | undefined): boolean {
  if (tier === 'internal') return true;
  if (!scoutConfig.securityPolicy.requireDomainVerification) return true;
  return false;
}

export function domainNeedsReverify(d: ScoutDomain): boolean {
  if (d.status !== 'verified' || !d.verified_at) return false;
  const days = scoutConfig.domainReverifyDays;
  const ageMs = Date.now() - new Date(d.verified_at).getTime();
  return ageMs > days * 86_400_000;
}

export function isHostnameVerifiedForKey(apiKey: string, hostnameRaw: string): boolean {
  let hostname: string;
  try {
    hostname = normalizeHostname(hostnameRaw);
  } catch {
    return false;
  }
  const hash = hashApiKey(apiKey);
  const verified = readStore().domains.filter(
    (d) => d.owner_key_hash === hash && d.status === 'verified' && !domainNeedsReverify(d),
  );
  return verified.some((d) => hostMatchesVerified(hostname, d.hostname));
}

export function assertUrlHostVerified(
  apiKey: string,
  tier: string | undefined,
  urlRaw: string,
  accountVerifiedHostnames?: string[],
): { ok: true } | { ok: false; error: string; hostname?: string } {
  if (bypassesDomainVerify(tier) || tier === 'internal') return { ok: true };
  let hostname: string;
  try {
    const u = new URL(urlRaw.includes('://') ? urlRaw : `https://${urlRaw}`);
    hostname = u.hostname;
  } catch {
    return { ok: false, error: 'Invalid URL for domain verification check' };
  }

  if (accountVerifiedHostnames?.length) {
    const h = hostname.toLowerCase();
    const ok = accountVerifiedHostnames.some(
      (v) => h === v.toLowerCase() || h.endsWith(`.${v.toLowerCase()}`),
    );
    if (ok) return { ok: true };
    return {
      ok: false,
      error: `Domain not verified for this account: ${hostname}. Manage domains in My Account → Scout.`,
      hostname,
    };
  }

  if (isHostnameVerifiedForKey(apiKey, hostname)) return { ok: true };

  const hash = hashApiKey(apiKey);
  const any = readStore().domains.find(
    (d) => d.owner_key_hash === hash && d.status === 'verified' && hostMatchesVerified(hostname, d.hostname),
  );
  if (any && domainNeedsReverify(any)) {
    return {
      ok: false,
      error: `Domain verification expired for ${hostname}. Re-verify via POST /v1/domains/${any.id}/verify`,
      hostname,
    };
  }
  return {
    ok: false,
    error: `Domain not verified for this API key: ${hostname}. Register and verify via POST /v1/domains`,
    hostname,
  };
}

async function checkWellKnownFile(hostname: string, expectedValue: string): Promise<boolean> {
  const urls = [
    `https://${hostname}/.well-known/scout-verify.txt`,
    `http://${hostname}/.well-known/scout-verify.txt`,
  ];
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (text === expectedValue || text.includes(expectedValue)) return true;
    } catch {
      // try next
    }
  }
  return false;
}

export async function verifyDomain(apiKey: string, id: string): Promise<ScoutDomain> {
  const domain = getDomainForKey(apiKey, id);
  if (!domain) throw new Error('Domain not found');

  const expected = domain.challenge.value;
  const now = new Date().toISOString();

  const txtValues = await lookupTxtCandidates(domain.hostname);
  const dnsOk = txtValues.some((v) => v === expected || v.includes(domain.challenge.token));

  let httpOk = false;
  if (!dnsOk) {
    httpOk = await checkWellKnownFile(domain.hostname, expected);
  }

  const store = readStore();
  const idx = store.domains.findIndex((d) => d.id === domain.id);
  if (idx < 0) throw new Error('Domain not found');

  if (dnsOk || httpOk) {
    store.domains[idx] = {
      ...store.domains[idx],
      status: 'verified',
      verified_at: now,
      last_check_at: now,
      last_error: null,
    };
  } else {
    store.domains[idx] = {
      ...store.domains[idx],
      status: store.domains[idx].status === 'verified' ? 'verified' : 'pending',
      last_check_at: now,
      last_error:
        `Challenge not found. Set TXT on ${domain.challenge.name} (or ${domain.hostname}) to "${expected}", `
        + `or serve it at https://${domain.hostname}/.well-known/scout-verify.txt`,
    };
  }

  writeStore(store);
  const updated = store.domains[idx];
  if (updated.status !== 'verified') {
    throw new Error(updated.last_error || 'Domain verification failed');
  }
  return updated;
}

/** Public JSON without owner hash */
export function serializeDomain(d: ScoutDomain) {
  const needs_reverify = domainNeedsReverify(d);
  return {
    id: d.id,
    hostname: d.hostname,
    status: d.status,
    needs_reverify,
    reverify_after_days: scoutConfig.domainReverifyDays,
    challenge: {
      type: d.challenge.type,
      name: d.challenge.name,
      value: d.challenge.value,
      instructions: [
        `Add a DNS TXT record at ${d.challenge.name} with value: ${d.challenge.value}`,
        `Alternatively add TXT on ${d.hostname} with the same value`,
        `Or host a file at https://${d.hostname}/.well-known/scout-verify.txt containing: ${d.challenge.value}`,
      ],
    },
    created_at: d.created_at,
    verified_at: d.verified_at,
    last_check_at: d.last_check_at,
    last_error: d.last_error,
  };
}
