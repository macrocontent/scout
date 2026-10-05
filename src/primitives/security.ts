import type { Page, Response } from 'playwright';
import { createHash } from 'crypto';
import tls from 'tls';
import { pageEvaluateNoArg } from '../browser/playwrightEvaluate';

const SECURITY_HEADER_NAMES = [
  'strict-transport-security',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
] as const;

export type SecurityReport = {
  tls: {
    protocol: string | null;
    authorized: boolean | null;
    fingerprint_sha256: string | null;
    subject: string | null;
    issuer: string | null;
    valid_from: string | null;
    valid_to: string | null;
    days_remaining: number | null;
    error: string | null;
  };
  security_headers: Record<string, string | null>;
  mixed_content: Array<{ url: string; type: string }>;
  cmp_signals: Array<{ id: string; evidence: string }>;
};

export async function fetchTlsInfo(hostname: string, port = 443): Promise<SecurityReport['tls']> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: 8_000 },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          const protocol = socket.getProtocol();
          const authorized = socket.authorized;
          const raw = cert?.raw as Buffer | undefined;
          const fingerprint = raw
            ? createHash('sha256').update(raw).digest('hex')
            : null;
          const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
          const daysRemaining = validTo
            ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
            : null;
          socket.end();
          resolve({
            protocol: protocol ?? null,
            authorized,
            fingerprint_sha256: fingerprint,
            subject: typeof cert?.subject?.CN === 'string'
              ? cert.subject.CN
              : Array.isArray(cert?.subject?.CN)
                ? cert.subject.CN.join(', ')
                : null,
            issuer: typeof cert?.issuer?.CN === 'string'
              ? cert.issuer.CN
              : Array.isArray(cert?.issuer?.CN)
                ? cert.issuer.CN.join(', ')
                : null,
            valid_from: cert?.valid_from ?? null,
            valid_to: cert?.valid_to ?? null,
            days_remaining: daysRemaining,
            error: null,
          });
        } catch (err) {
          socket.destroy();
          resolve({
            protocol: null,
            authorized: null,
            fingerprint_sha256: null,
            subject: null,
            issuer: null,
            valid_from: null,
            valid_to: null,
            days_remaining: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    socket.on('error', (err) => {
      resolve({
        protocol: null,
        authorized: null,
        fingerprint_sha256: null,
        subject: null,
        issuer: null,
        valid_from: null,
        valid_to: null,
        days_remaining: null,
        error: err.message,
      });
    });
  });
}

export function extractSecurityHeaders(headers: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of SECURITY_HEADER_NAMES) {
    out[name] = headers[name] ?? headers[name.toLowerCase()] ?? null;
  }
  return out;
}

export async function collectMixedContent(page: Page): Promise<Array<{ url: string; type: string }>> {
  return pageEvaluateNoArg(page, () => {
    if (location.protocol !== 'https:') return [];
    const hits: Array<{ url: string; type: string }> = [];
    document.querySelectorAll('img[src], script[src], link[href], iframe[src], video[src], audio[src], source[src]').forEach((el) => {
      const attr = el.getAttribute('src') || el.getAttribute('href') || '';
      if (attr.startsWith('http://')) {
        hits.push({ url: attr, type: el.tagName.toLowerCase() });
      }
    });
    return hits.slice(0, 100);
  });
}

export async function detectCmpSignals(page: Page): Promise<Array<{ id: string; evidence: string }>> {
  return pageEvaluateNoArg(page, () => {
    const signals: Array<{ id: string; evidence: string }> = [];
    const html = document.documentElement.innerHTML.slice(0, 200_000).toLowerCase();
    const checks: Array<[string, RegExp]> = [
      ['onetrust', /onetrust|optanon/],
      ['cookiebot', /cookiebot|cybot/],
      ['usercentrics', /usercentrics/],
      ['quantcast', /quantcast|__tcfapi/],
      ['didomi', /didomi/],
      ['cookieyes', /cookieyes/],
      ['iubenda', /iubenda/],
      ['tcf_api', /__tcfapi|window\.__tcfapi/],
    ];
    for (const [id, re] of checks) {
      if (re.test(html) || (window as unknown as Record<string, unknown>)[id]) {
        signals.push({ id, evidence: `matched ${re}` });
      }
    }
    if (typeof (window as unknown as { __tcfapi?: unknown }).__tcfapi === 'function') {
      signals.push({ id: 'tcf_api_fn', evidence: 'window.__tcfapi is a function' });
    }
    return signals;
  });
}

export async function buildSecurityReport(page: Page, response: Response | null, url: string): Promise<SecurityReport> {
  const headers = response?.headers() ?? {};
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = '';
  }
  const [tlsInfo, mixed, cmp] = await Promise.all([
    hostname ? fetchTlsInfo(hostname) : Promise.resolve({
      protocol: null,
      authorized: null,
      fingerprint_sha256: null,
      subject: null,
      issuer: null,
      valid_from: null,
      valid_to: null,
      days_remaining: null,
      error: 'no hostname',
    } as SecurityReport['tls']),
    collectMixedContent(page),
    detectCmpSignals(page),
  ]);
  return {
    tls: tlsInfo,
    security_headers: extractSecurityHeaders(headers),
    mixed_content: mixed,
    cmp_signals: cmp,
  };
}
