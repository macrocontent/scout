import { scoutConfig } from '../config';
import { cacheKey, getCacheStore } from '../cache/store';
import { normalizeHostname } from './dnsLookup';

export type RobotsDecision = {
  allowed: boolean;
  matched_rule: string | null;
  robots_url: string;
  cached: boolean;
  sitemap_urls: string[];
};

type RobotsGroup = { agents: string[]; allow: string[]; disallow: string[] };

function parseRobots(text: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.allow.length || current.disallow.length) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'allow' && current) {
      current.allow.push(value);
    } else if (key === 'disallow' && current) {
      current.disallow.push(value);
    } else if (key === 'sitemap') {
      sitemaps.push(value);
    }
  }
  return { groups, sitemaps };
}

function pathMatches(pattern: string, pathName: string): boolean {
  if (!pattern) return false;
  if (pattern === '/') return true;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const re = new RegExp(`^${escaped}`);
  return re.test(pathName);
}

function decideForAgent(
  groups: RobotsGroup[],
  agent: string,
  pathName: string,
): { allowed: boolean; matched_rule: string | null } {
  const ua = agent.toLowerCase();
  let matching = groups.filter((g) =>
    g.agents.some((a) => a === '*' || ua.includes(a) || a.includes('macroscout')),
  );
  if (matching.length === 0) {
    matching = groups.filter((g) => g.agents.includes('*'));
  }

  let best: { len: number; allow: boolean; rule: string } | null = null;
  for (const g of matching) {
    for (const rule of g.allow) {
      if (pathMatches(rule, pathName) && rule.length >= (best?.len ?? -1)) {
        best = { len: rule.length, allow: true, rule: `Allow: ${rule}` };
      }
    }
    for (const rule of g.disallow) {
      if (pathMatches(rule, pathName) && rule.length >= (best?.len ?? -1)) {
        best = { len: rule.length, allow: false, rule: `Disallow: ${rule}` };
      }
    }
  }
  if (!best) return { allowed: true, matched_rule: null };
  return { allowed: best.allow, matched_rule: best.rule };
}

export async function checkRobotsTxt(targetUrl: string, options?: {
  respect?: boolean;
  userAgent?: string;
}): Promise<RobotsDecision> {
  const respect = options?.respect ?? scoutConfig.respectRobotsDefault;
  const parsed = new URL(targetUrl);
  const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
  if (!respect) {
    return {
      allowed: true,
      matched_rule: null,
      robots_url: robotsUrl,
      cached: false,
      sitemap_urls: [],
    };
  }

  const host = normalizeHostname(parsed.hostname);
  const key = cacheKey(['robots', host]);
  const store = await getCacheStore();
  let text: string | null = await store.get(key);
  let cached = Boolean(text);
  if (text === null) {
    try {
      const res = await fetch(robotsUrl, {
        headers: { 'User-Agent': options?.userAgent || scoutConfig.userAgent },
        signal: AbortSignal.timeout(8_000),
      });
      text = res.ok ? await res.text() : '';
      await store.set(key, text, 6 * 3600);
      cached = false;
    } catch {
      return {
        allowed: true,
        matched_rule: null,
        robots_url: robotsUrl,
        cached: false,
        sitemap_urls: [],
      };
    }
  }

  const { groups, sitemaps } = parseRobots(text || '');
  const decision = decideForAgent(
    groups,
    options?.userAgent || scoutConfig.userAgent,
    parsed.pathname || '/',
  );
  return {
    ...decision,
    robots_url: robotsUrl,
    cached,
    sitemap_urls: sitemaps,
  };
}

export async function assertRobotsAllowed(url: string, respect?: boolean): Promise<RobotsDecision> {
  const decision = await checkRobotsTxt(url, { respect });
  if (!decision.allowed) {
    throw new Error(`Blocked by robots.txt (${decision.matched_rule || 'Disallow'}) for ${url}`);
  }
  return decision;
}
