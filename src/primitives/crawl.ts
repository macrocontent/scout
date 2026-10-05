import { withPageValue } from '../browser/pool';
import { pageEvaluateNoArg } from '../browser/playwrightEvaluate';
import { checkRobotsTxt } from '../lib/robots';
import { assertPublicHttpUrl } from '../lib/networkGuard';

export type CrawlOptions = {
  startUrl: string;
  maxDepth?: number;
  maxPages?: number;
  /** Restrict to same registrable host as start (default true). */
  sameOrigin?: boolean;
  /** Extra allowed hostnames (exact or subdomain). */
  allowHosts?: string[];
  /** Seed URLs from robots sitemap_urls when available. */
  seedFromSitemap?: boolean;
  respectRobots?: boolean;
  settleMs?: number;
  gotoTimeoutMs?: number;
};

export type CrawlPageResult = {
  url: string;
  depth: number;
  status: 'ok' | 'skipped' | 'error';
  http_status: number | null;
  final_url: string | null;
  links_found: number;
  error: string | null;
  robots_allowed: boolean;
};

export type CrawlResult = {
  status: 'success' | 'partial';
  start_url: string;
  pages: CrawlPageResult[];
  discovered_urls: string[];
  truncated: boolean;
  response_time_ms: number;
};

function normalizePageUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    // Drop common tracking-only fragments already cleared; keep query
    return u.toString();
  } catch {
    return null;
  }
}

function hostAllowed(
  hostname: string,
  startHost: string,
  sameOrigin: boolean,
  allowHosts: string[],
): boolean {
  const h = hostname.toLowerCase();
  if (sameOrigin && (h === startHost || h.endsWith(`.${startHost}`))) return true;
  for (const a of allowHosts) {
    const ah = a.toLowerCase();
    if (h === ah || h.endsWith(`.${ah}`)) return true;
  }
  if (sameOrigin) return false;
  // same_origin=false and no allow_hosts → any public host
  return allowHosts.length === 0;
}

async function collectLinksFromUrl(
  url: string,
  opts: { settleMs: number; gotoTimeoutMs: number },
): Promise<{ finalUrl: string; httpStatus: number | null; links: string[] }> {
  return withPageValue({ width: 1280, height: 800 }, async (page) => {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.gotoTimeoutMs,
    });
    if (opts.settleMs > 0) await page.waitForTimeout(opts.settleMs);
    const links = await pageEvaluateNoArg(page, () => {
      const out: string[] = [];
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        if (href) out.push(href);
      });
      return out;
    });
    return {
      finalUrl: page.url(),
      httpStatus: response?.status() ?? null,
      links,
    };
  });
}

async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  try {
    const res = await fetch(sitemapUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const text = await res.text();
    const locs = [...text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
    return locs.slice(0, 500);
  } catch {
    return [];
  }
}

/**
 * BFS link discovery from a start URL. Does not archive page content —
 * returns URL list + lightweight per-page metadata only.
 */
export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const started = Date.now();
  const startUrl = await assertPublicHttpUrl(options.startUrl);
  const maxDepth = Math.min(Math.max(options.maxDepth ?? 2, 0), 5);
  const maxPages = Math.min(Math.max(options.maxPages ?? 25, 1), 100);
  const sameOrigin = options.sameOrigin !== false;
  const allowHosts = options.allowHosts ?? [];
  const settleMs = options.settleMs ?? 200;
  const gotoTimeoutMs = options.gotoTimeoutMs ?? 20_000;

  const startHost = new URL(startUrl).hostname.toLowerCase();
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const seen = new Set<string>();
  const pages: CrawlPageResult[] = [];
  let truncated = false;

  if (options.seedFromSitemap) {
    const robots = await checkRobotsTxt(startUrl, { respect: true });
    for (const sm of robots.sitemap_urls.slice(0, 3)) {
      const urls = await fetchSitemapUrls(sm);
      for (const u of urls) {
        const normalized = normalizePageUrl(u, startUrl);
        if (!normalized) continue;
        try {
          await assertPublicHttpUrl(normalized);
        } catch {
          continue;
        }
        const host = new URL(normalized).hostname;
        if (!hostAllowed(host, startHost, sameOrigin, allowHosts)) continue;
        if (!seen.has(normalized)) {
          queue.push({ url: normalized, depth: 0 });
        }
      }
    }
  }

  while (queue.length > 0 && pages.length < maxPages) {
    const item = queue.shift()!;
    if (seen.has(item.url)) continue;
    seen.add(item.url);

    let robotsAllowed = true;
    try {
      const decision = await checkRobotsTxt(item.url, { respect: options.respectRobots });
      robotsAllowed = decision.allowed;
      if (!decision.allowed) {
        pages.push({
          url: item.url,
          depth: item.depth,
          status: 'skipped',
          http_status: null,
          final_url: null,
          links_found: 0,
          error: `robots: ${decision.matched_rule || 'Disallow'}`,
          robots_allowed: false,
        });
        continue;
      }
    } catch {
      // fail open on robots check errors
    }

    try {
      const { finalUrl, httpStatus, links } = await collectLinksFromUrl(item.url, {
        settleMs,
        gotoTimeoutMs,
      });
      const absoluteLinks = links
        .map((l) => normalizePageUrl(l, finalUrl))
        .filter((u): u is string => Boolean(u));

      pages.push({
        url: item.url,
        depth: item.depth,
        status: 'ok',
        http_status: httpStatus,
        final_url: finalUrl,
        links_found: absoluteLinks.length,
        error: null,
        robots_allowed: robotsAllowed,
      });

      if (item.depth < maxDepth) {
        for (const link of absoluteLinks) {
          if (seen.has(link) || queue.some((q) => q.url === link)) continue;
          try {
            await assertPublicHttpUrl(link);
          } catch {
            continue;
          }
          const host = new URL(link).hostname;
          if (!hostAllowed(host, startHost, sameOrigin, allowHosts)) continue;
          if (pages.length + queue.length >= maxPages) {
            truncated = true;
            break;
          }
          queue.push({ url: link, depth: item.depth + 1 });
        }
      }
    } catch (err) {
      pages.push({
        url: item.url,
        depth: item.depth,
        status: 'error',
        http_status: null,
        final_url: null,
        links_found: 0,
        error: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
        robots_allowed: robotsAllowed,
      });
    }

    if (pages.length >= maxPages && queue.length > 0) truncated = true;
  }

  const discovered = pages
    .filter((p) => p.status === 'ok')
    .map((p) => p.final_url || p.url);

  return {
    status: pages.some((p) => p.status === 'error') ? 'partial' : 'success',
    start_url: startUrl,
    pages,
    discovered_urls: [...new Set(discovered)],
    truncated,
    response_time_ms: Date.now() - started,
  };
}
