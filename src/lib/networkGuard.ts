import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { scoutConfig } from '../config';
import { assertHostnamePolicy } from './securityPolicy';

function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, '').toLowerCase();
  if (v === '::1' || v === '0.0.0.0' || v === '::') return true;
  if (v.startsWith('127.') || v.startsWith('10.') || v.startsWith('192.168.')) return true;
  if (v.startsWith('169.254.')) return true;
  const cg = /^100\.(\d+)\./.exec(v);
  if (cg) {
    const n = Number(cg[1]);
    if (n >= 64 && n <= 127) return true;
  }
  const m = /^172\.(\d+)\./.exec(v);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true;
  return false;
}

export function normalizeHttpUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function assertPublicHttpUrl(raw: string): Promise<string> {
  const url = normalizeHttpUrl(raw);
  if (!url) throw new Error('Invalid URL');

  const hostname = new URL(url).hostname.toLowerCase();
  assertHostnamePolicy(hostname, scoutConfig.securityPolicy);

  if (scoutConfig.securityPolicy.allowPrivateNetworks) return url;

  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname === 'metadata.google.internal'
  ) {
    throw new Error('Private/loopback hosts are not allowed');
  }

  const ips: string[] = [];
  if (isIP(hostname)) {
    ips.push(hostname);
  } else {
    const records = await lookup(hostname, { all: true });
    for (const r of records) ips.push(r.address);
  }

  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new Error('Private/loopback hosts are not allowed');
    }
  }

  return url;
}
