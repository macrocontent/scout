import { resolve as dnsResolve, resolve4, resolve6, resolveCname, resolveMx, resolveNs, resolveTxt, resolveSoa } from 'dns/promises';
import { cacheKey, getOrCompute } from '../cache/store';

export type DnsRecordType = 'A' | 'AAAA' | 'TXT' | 'CNAME' | 'MX' | 'NS' | 'SOA';

export type DnsLookupResult = {
  hostname: string;
  records: Partial<Record<DnsRecordType, unknown>>;
  errors: Partial<Record<DnsRecordType, string>>;
  response_time_ms: number;
  cache?: 'HIT' | 'MISS' | 'COALESCE';
};

function normalizeHostname(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) throw new Error('hostname is required');
  if (s.includes('://')) {
    try {
      s = new URL(s).hostname;
    } catch {
      throw new Error('Invalid hostname');
    }
  }
  s = s.replace(/\.$/, '').split('/')[0].split(':')[0];
  if (!s || s.includes(' ')) throw new Error('Invalid hostname');
  return s;
}

async function safe<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: string }).code) : '';
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: code ? `${code}: ${message}` : message };
  }
}

async function lookupDnsUncached(
  hostname: string,
  types: DnsRecordType[],
): Promise<Omit<DnsLookupResult, 'cache'>> {
  const started = Date.now();
  const records: DnsLookupResult['records'] = {};
  const errors: DnsLookupResult['errors'] = {};
  const unique = [...new Set(types)];

  await Promise.all(
    unique.map(async (type) => {
      if (type === 'A') {
        const r = await safe(() => resolve4(hostname));
        if (r.ok) records.A = r.value;
        else errors.A = r.error;
      } else if (type === 'AAAA') {
        const r = await safe(() => resolve6(hostname));
        if (r.ok) records.AAAA = r.value;
        else errors.AAAA = r.error;
      } else if (type === 'TXT') {
        const r = await safe(() => resolveTxt(hostname));
        if (r.ok) records.TXT = r.value.map((chunks) => chunks.join(''));
        else errors.TXT = r.error;
      } else if (type === 'CNAME') {
        const r = await safe(() => resolveCname(hostname));
        if (r.ok) records.CNAME = r.value;
        else errors.CNAME = r.error;
      } else if (type === 'MX') {
        const r = await safe(() => resolveMx(hostname));
        if (r.ok) records.MX = r.value;
        else errors.MX = r.error;
      } else if (type === 'NS') {
        const r = await safe(() => resolveNs(hostname));
        if (r.ok) records.NS = r.value;
        else errors.NS = r.error;
      } else if (type === 'SOA') {
        const r = await safe(() => resolveSoa(hostname));
        if (r.ok) records.SOA = r.value;
        else errors.SOA = r.error;
      } else {
        const r = await safe(() => dnsResolve(hostname, type));
        if (r.ok) (records as Record<string, unknown>)[type] = r.value;
        else (errors as Record<string, string>)[type] = r.error;
      }
    }),
  );

  return {
    hostname,
    records,
    errors,
    response_time_ms: Date.now() - started,
  };
}

export async function lookupDns(
  hostnameRaw: string,
  types: DnsRecordType[] = ['A', 'AAAA', 'TXT', 'CNAME', 'MX', 'NS'],
): Promise<DnsLookupResult> {
  const hostname = normalizeHostname(hostnameRaw);
  const sortedTypes = [...new Set(types)].sort();
  const { value, cache } = await getOrCompute({
    key: cacheKey(['dns', hostname, sortedTypes.join(',')]),
    ttlSeconds: 300,
    compute: () => lookupDnsUncached(hostname, sortedTypes),
  });
  return { ...value, cache };
}

/** TXT at hostname and at `_scout-verify.hostname` */
export async function lookupTxtCandidates(hostnameRaw: string): Promise<string[]> {
  const hostname = normalizeHostname(hostnameRaw);
  const names = [hostname, `_scout-verify.${hostname}`];
  const values: string[] = [];
  for (const name of names) {
    try {
      const rows = await resolveTxt(name);
      for (const chunks of rows) values.push(chunks.join(''));
    } catch {
      // ignore NXDOMAIN etc.
    }
  }
  return values;
}

export { normalizeHostname };
