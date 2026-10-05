import { assertPublicHttpUrl } from '../lib/networkGuard';

export type SitemapReport = {
  status: 'success';
  url: string;
  sitemaps: Array<{
    url: string;
    valid_xml: boolean;
    url_count: number;
    lastmod_min: string | null;
    lastmod_max: string | null;
    robots_referenced: boolean;
    errors: string[];
  }>;
  robots_referenced_urls: string[];
  errors: string[];
  response_time_ms: number;
  timestamp: string;
};

const MAX_SITEMAPS = 3;
const FETCH_TIMEOUT_MS = 15_000;

function extractLocTags(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
    if (text) locs.push(text);
  }
  return locs;
}

function extractLastmods(xml: string): string[] {
  const mods: string[] = [];
  const re = /<lastmod[^>]*>([\s\S]*?)<\/lastmod>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = m[1].trim();
    if (text) mods.push(text);
  }
  return mods;
}

function looksLikeXmlSitemap(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith('<?xml') || trimmed.includes('<urlset') || trimmed.includes('<sitemapindex');
}

async function fetchText(url: string): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/xml,text/xml,text/plain,*/*', 'User-Agent': 'MacroScout/0.6' },
      redirect: 'follow',
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 5_000_000) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: '', error: message.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

function parseRobotsSitemapLines(body: string): string[] {
  const urls: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!/^sitemap:/i.test(trimmed)) continue;
    const url = trimmed.replace(/^sitemap:\s*/i, '').trim();
    if (url) urls.push(url);
  }
  return urls;
}

function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

export async function inspectSitemap(rawUrl: string): Promise<SitemapReport> {
  const started = Date.now();
  const url = await assertPublicHttpUrl(rawUrl);
  const origin = originOf(url);
  const errors: string[] = [];
  const robotsReferenced: string[] = [];

  const robotsUrl = `${origin}/robots.txt`;
  const robotsRes = await fetchText(robotsUrl);
  if (robotsRes.ok) {
    robotsReferenced.push(...parseRobotsSitemapLines(robotsRes.body));
  }

  const candidateSet = new Set<string>();
  for (const s of robotsReferenced) {
    try {
      candidateSet.add(await assertPublicHttpUrl(s));
    } catch {
      // skip invalid sitemap URLs from robots
    }
  }

  const parsed = new URL(url);
  const isLikelySitemap =
    parsed.pathname.endsWith('.xml')
    || parsed.pathname.includes('sitemap')
    || parsed.pathname.endsWith('.xml.gz');

  if (isLikelySitemap) {
    candidateSet.add(url);
  } else {
    candidateSet.add(`${origin}/sitemap.xml`);
    candidateSet.add(`${origin}/sitemap_index.xml`);
  }

  const candidates = [...candidateSet].slice(0, MAX_SITEMAPS);
  const sitemaps: SitemapReport['sitemaps'] = [];

  for (const smUrl of candidates) {
    const smErrors: string[] = [];
    let validXml = false;
    let urlCount = 0;
    let lastmodMin: string | null = null;
    let lastmodMax: string | null = null;

    const res = await fetchText(smUrl);
    if (!res.ok || res.error) {
      smErrors.push(res.error ?? `HTTP ${res.status}`);
    } else {
      validXml = looksLikeXmlSitemap(res.body);
      if (!validXml) smErrors.push('Body does not look like XML sitemap');
      const locs = extractLocTags(res.body);
      urlCount = locs.length;
      const lastmods = extractLastmods(res.body);
      if (lastmods.length) {
        const sorted = [...lastmods].sort();
        lastmodMin = sorted[0] ?? null;
        lastmodMax = sorted[sorted.length - 1] ?? null;
      }
    }

    sitemaps.push({
      url: smUrl,
      valid_xml: validXml,
      url_count: urlCount,
      lastmod_min: lastmodMin,
      lastmod_max: lastmodMax,
      robots_referenced: robotsReferenced.includes(smUrl),
      errors: smErrors,
    });
  }

  if (!sitemaps.length) errors.push('No sitemap candidates resolved');

  return {
    status: 'success',
    url,
    sitemaps,
    robots_referenced_urls: robotsReferenced,
    errors,
    response_time_ms: Date.now() - started,
    timestamp: new Date().toISOString(),
  };
}
