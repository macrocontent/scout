import type { ConsoleMessage, Page, Request, Response } from 'playwright';
import {
  DEFAULT_AD_TRACKER_PATTERNS,
  type ResourceType,
  withPageValue,
  type WithPageOptions,
} from '../browser/pool';
import { pageEvaluate } from '../browser/playwrightEvaluate';
import { maybeDismissCookieBanner } from '../lib/cookieBanner';
import { applyWaitForSelector } from '../lib/pageWait';
import { assertPublicHttpUrl } from '../lib/networkGuard';
import { domSerializeScript, diffDomTrees, type DomTreeNode } from './domDiff';

export type FactsCollect =
  | 'cookies'
  | 'console'
  | 'network'
  | 'assets'
  | 'json_ld'
  | 'canonical'
  | 'images'
  | 'resources'
  | 'a11y_snapshot'
  | 'forms'
  | 'opengraph'
  | 'links';

export type PageFactsOptions = {
  url: string;
  collect: FactsCollect[];
  settleMs?: number;
  gotoTimeoutMs?: number;
  width?: number;
  height?: number;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  locale?: string;
  userAgent?: string;
  extraHTTPHeaders?: Record<string, string>;
  blockResourceTypes?: ResourceType[];
  blockUrlPatterns?: string[];
  blockAds?: boolean;
  httpCredentials?: { username: string; password: string };
  clientCertificates?: WithPageOptions['clientCertificates'];
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  waitForSelector?: string;
  waitTimeoutMs?: number;
  waitForSelectorRequired?: boolean;
  dismissCookieBanner?: boolean;
  runtime?: WithPageOptions['runtime'];
  /** Include top_slowest in network summary (up to 20). */
  topSlowest?: boolean;
  /** Capture viewport JPEG base64 for opengraph check. */
  screenshot?: boolean;
};

type ConsoleEntry = {
  type: string;
  message: string;
  url: string | null;
  line: number | null;
  column: number | null;
};

type NetworkEntry = {
  url: string;
  method: string;
  status: number | null;
  duration_ms: number | null;
  resource_type: string;
  failed: boolean;
  failure_text: string | null;
  cors_error: boolean;
};

type FailedAsset = {
  url: string;
  resource_type: string;
  status: number | null;
  error: string | null;
};

const CONSOLE_CAP = 200;
const IMAGES_CAP = 200;
const FORMS_CAP = 50;
const LINKS_CAP = 100;

function cookieDomainMatchesHost(cookieDomain: string | undefined, pageHost: string): boolean {
  if (!cookieDomain) return true;
  const d = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  return pageHost === d || pageHost.endsWith(`.${d}`);
}

function statusClass(status: number | null): '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
  if (status == null) return 'other';
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500) return '5xx';
  return 'other';
}

function jsonLdTypes(node: unknown): string[] {
  const types = new Set<string>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    const obj = v as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') types.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
    for (const val of Object.values(obj)) walk(val);
  };
  walk(node);
  return [...types];
}

function missingJsonLdFields(types: string[], data: unknown): string[] {
  const missing: string[] = [];
  if (!data || typeof data !== 'object') return missing;
  const obj = data as Record<string, unknown>;
  const has = (k: string) => obj[k] != null && obj[k] !== '';

  if (types.includes('Product')) {
    if (!has('name')) missing.push('name');
    if (!has('image')) missing.push('image');
    if (!has('description')) missing.push('description');
  }
  if (types.includes('Organization')) {
    if (!has('name')) missing.push('name');
    if (!has('url')) missing.push('url');
  }
  if (types.includes('WebSite')) {
    if (!has('name')) missing.push('name');
    if (!has('url')) missing.push('url');
  }
  if (types.includes('Article')) {
    if (!has('headline')) missing.push('headline');
    if (!has('author')) missing.push('author');
    if (!has('datePublished')) missing.push('datePublished');
  }
  if (types.includes('BreadcrumbList')) {
    if (!obj.itemListElement) missing.push('itemListElement');
  }
  return missing;
}

async function buildRedirectChain(
  response: Response | null,
): Promise<Array<{ url: string; status: number }>> {
  if (!response) return [];
  const hops: Array<{ url: string; status: number }> = [];
  let req: Request | null = response.request();
  const stack: Request[] = [];
  while (req) {
    stack.unshift(req);
    req = req.redirectedFrom();
  }
  for (const r of stack) {
    const resp = await r.response();
    hops.push({
      url: r.url(),
      status: resp?.status() ?? 0,
    });
  }
  return hops;
}

async function evaluateDomPack(page: Page, collect: Set<FactsCollect>) {
  const need = [
    'json_ld',
    'canonical',
    'images',
    'a11y_snapshot',
    'forms',
    'opengraph',
    'links',
  ].some((k) => collect.has(k as FactsCollect));

  if (!need) return {};

  return pageEvaluate(page, (keys: string[]) => {
    const out: Record<string, unknown> = {};
    const has = (k: string) => keys.includes(k);

    if (has('opengraph')) {
      const meta: Record<string, string | null> = {};
      document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]').forEach((el) => {
        const key = el.getAttribute('property') || el.getAttribute('name');
        if (key) meta[key] = el.getAttribute('content');
      });
      out.opengraph = meta;
    }

    if (has('canonical')) {
      out.canonical_href =
        document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;
    }

    if (has('json_ld')) {
      out.json_ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(
        (el) => el.textContent || '',
      );
    }

    if (has('images')) {
      out.images = Array.from(document.querySelectorAll('img')).slice(0, 200).map((img) => ({
        src: img.currentSrc || img.getAttribute('src'),
        alt: img.getAttribute('alt'),
        width: img.getAttribute('width'),
        height: img.getAttribute('height'),
        loading: img.getAttribute('loading'),
        decoding: img.getAttribute('decoding'),
        fetchpriority: img.getAttribute('fetchpriority'),
        natural_width: img.naturalWidth || null,
        natural_height: img.naturalHeight || null,
      }));
    }

    if (has('a11y_snapshot')) {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .slice(0, 80)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          name: (
            el.getAttribute('aria-label')
            || (el as HTMLInputElement).labels?.[0]?.textContent
            || el.textContent
            || ''
          )
            .trim()
            .slice(0, 120),
        }));
      const headings: Array<{ level: number; text: string }> = [];
      for (let level = 1; level <= 6; level++) {
        document.querySelectorAll(`h${level}`).forEach((el) => {
          headings.push({ level, text: (el.textContent || '').trim().slice(0, 200) });
        });
      }
      const landmarks = Array.from(
        document.querySelectorAll(
          '[role=banner], [role=navigation], [role=main], [role=contentinfo], header, nav, main, footer',
        ),
      )
        .slice(0, 40)
        .map((el) => ({
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          label: el.getAttribute('aria-label'),
        }));
      const ariaElements = Array.from(document.querySelectorAll('*'))
        .filter((el) => el.getAttributeNames().some((n) => n.startsWith('aria-') || n === 'role'))
        .slice(0, 500);
      const attrCounts: Record<string, number> = {};
      for (const el of ariaElements) {
        for (const attr of el.getAttributeNames()) {
          if (attr.startsWith('aria-') || attr === 'role') {
            attrCounts[attr] = (attrCounts[attr] ?? 0) + 1;
          }
        }
      }
      out.a11y_snapshot = {
        buttons,
        links_count: document.querySelectorAll('a[href]').length,
        headings: headings.slice(0, 80),
        landmarks,
        aria: {
          elements_with_aria: ariaElements.length,
          attribute_counts: attrCounts,
        },
      };
    }

    if (has('forms')) {
      out.forms = Array.from(document.querySelectorAll('form'))
        .slice(0, 50)
        .map((form) => {
          let actionAbs = form.getAttribute('action') || '';
          try {
            actionAbs = new URL(actionAbs || '', location.href).toString();
          } catch {
            // keep raw
          }
          const inputs = Array.from(form.querySelectorAll('input, select, textarea')).map((input) => ({
            name: input.getAttribute('name'),
            type: input.getAttribute('type') || input.tagName.toLowerCase(),
            required: input.hasAttribute('required'),
          }));
          return {
            method: (form.getAttribute('method') || 'get').toLowerCase(),
            action: actionAbs,
            enctype: form.getAttribute('enctype'),
            inputs,
          };
        });
    }

    if (has('links')) {
      const origin = location.origin;
      const pageUrl = location.href;
      const seen = new Set<string>();
      const nodes: Array<{ url: string; text: string }> = [];
      const edges: Array<{ from: string; to: string }> = [];
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href') || '';
        let absolute = href;
        try {
          absolute = new URL(href, location.href).toString();
        } catch {
          continue;
        }
        if (!absolute.startsWith(origin)) continue;
        if (seen.has(absolute)) continue;
        seen.add(absolute);
        nodes.push({ url: absolute, text: (a.textContent || '').trim().slice(0, 200) });
        edges.push({ from: pageUrl, to: absolute });
        if (nodes.length >= 100) break;
      }
      out.links_graph = { nodes, edges };
    }

    return out;
  }, Array.from(collect));
}

export async function collectPageFacts(options: PageFactsOptions) {
  const started = Date.now();
  const collect = new Set(options.collect);
  const blockPatterns = [
    ...(options.blockUrlPatterns ?? []),
    ...(options.blockAds ? DEFAULT_AD_TRACKER_PATTERNS : []),
  ];

  const consoleEntries: ConsoleEntry[] = [];
  const networkEntries: NetworkEntry[] = [];
  const failedAssets: FailedAsset[] = [];
  const requestStart = new Map<string, number>();
  let mixedContentCount = 0;
  let corsErrors = 0;
  let timeouts = 0;
  let failures = 0;

  const assetTypes = new Set(['stylesheet', 'image', 'font', 'script']);

  return withPageValue(
    {
      width: options.width,
      height: options.height,
      colorScheme: options.colorScheme,
      locale: options.locale,
      userAgent: options.userAgent,
      extraHTTPHeaders: options.extraHTTPHeaders,
      blockResourceTypes: options.blockResourceTypes,
      blockUrlPatterns: blockPatterns,
      httpCredentials: options.httpCredentials,
      clientCertificates: options.clientCertificates,
      deviceScaleFactor: options.deviceScaleFactor,
      isMobile: options.isMobile,
      hasTouch: options.hasTouch,
      runtime: options.runtime,
    },
    async (page, session) => {
      page.on('console', (msg: ConsoleMessage) => {
        if (!collect.has('console') || consoleEntries.length >= CONSOLE_CAP) return;
        const loc = msg.location();
        consoleEntries.push({
          type: msg.type(),
          message: msg.text().slice(0, 2000),
          url: loc.url || null,
          line: loc.lineNumber ?? null,
          column: loc.columnNumber ?? null,
        });
      });

      page.on('request', (req) => {
        if (!collect.has('network') && !collect.has('resources') && !collect.has('assets')) return;
        requestStart.set(req.url() + req.method(), Date.now());
        try {
          const pageUrl = new URL(options.url);
          if (pageUrl.protocol === 'https:' && req.url().startsWith('http://')) {
            mixedContentCount++;
          }
        } catch {
          // ignore
        }
      });

      page.on('requestfailed', (req) => {
        if (!collect.has('network') && !collect.has('assets')) return;
        failures++;
        const rt = req.resourceType();
        const failure = req.failure()?.errorText ?? 'failed';
        if (failure.toLowerCase().includes('cors')) corsErrors++;
        if (failure.toLowerCase().includes('timeout')) timeouts++;

        networkEntries.push({
          url: req.url(),
          method: req.method(),
          status: null,
          duration_ms: null,
          resource_type: rt,
          failed: true,
          failure_text: failure,
          cors_error: failure.toLowerCase().includes('cors'),
        });

        if (collect.has('assets') && assetTypes.has(rt)) {
          failedAssets.push({
            url: req.url(),
            resource_type: rt,
            status: null,
            error: failure,
          });
        }
      });

      const responseSizes = new Map<string, number>();

      page.on('response', async (resp: Response) => {
        if (!collect.has('network') && !collect.has('resources') && !collect.has('assets')) return;
        const req = resp.request();
        const key = req.url() + req.method();
        const start = requestStart.get(key);
        const duration = start != null ? Date.now() - start : null;
        const status = resp.status();
        const rt = req.resourceType();
        const failed = status >= 400;
        if (collect.has('resources')) {
          const len = resp.headers()['content-length'];
          if (len) responseSizes.set(key, Number(len) || 0);
        }
        if (failed && collect.has('assets') && assetTypes.has(rt)) {
          failedAssets.push({
            url: req.url(),
            resource_type: rt,
            status,
            error: resp.statusText() || null,
          });
        }
        networkEntries.push({
          url: req.url(),
          method: req.method(),
          status,
          duration_ms: duration,
          resource_type: rt,
          failed: status >= 400,
          failure_text: failed ? resp.statusText() : null,
          cors_error: false,
        });
      });

      const response = await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: options.gotoTimeoutMs ?? 45_000,
      });

      const cookieBanner = await maybeDismissCookieBanner(page, options.dismissCookieBanner);
      await applyWaitForSelector(page, {
        waitForSelector: options.waitForSelector,
        waitTimeoutMs: options.waitTimeoutMs,
        required: options.waitForSelectorRequired,
      });
      if ((options.settleMs ?? 0) > 0) await page.waitForTimeout(options.settleMs!);

      const finalUrl = page.url();
      const pageHost = new URL(finalUrl).hostname;
      const dom = await evaluateDomPack(page, collect);

      const result: Record<string, unknown> = {
        status: 'success' as const,
        url: options.url,
        final_url: finalUrl,
        response_time_ms: Date.now() - started,
        timestamp: new Date().toISOString(),
      };

      if (cookieBanner) {
        result.cookie_banner_detected = cookieBanner.cookie_banner_detected;
        result.cookie_banner_dismissed = cookieBanner.cookie_banner_dismissed;
        result.cookie_banner_vendor = cookieBanner.cookie_banner_vendor;
      }

      if (collect.has('cookies')) {
        const rawCookies = await session.context.cookies();
        result.cookies = rawCookies.map((c) => ({
          name: c.name,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expires: c.expires,
          expires_at: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
          size: new TextEncoder().encode(c.value).length,
          first_party: cookieDomainMatchesHost(c.domain, pageHost),
        }));
      }

      if (collect.has('console')) {
        result.console = consoleEntries.slice(0, CONSOLE_CAP);
      }

      if (collect.has('network')) {
        const counts = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
        for (const e of networkEntries) {
          counts[statusClass(e.status)]++;
          if (e.cors_error) corsErrors++;
        }
        const summary: Record<string, unknown> = {
          counts,
          cors_errors: corsErrors,
          mixed_content: mixedContentCount,
          timeouts,
          failures,
        };
        if (options.topSlowest) {
          summary.top_slowest = [...networkEntries]
            .filter((e) => e.duration_ms != null)
            .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
            .slice(0, 20)
            .map((e) => ({
              url: e.url,
              method: e.method,
              status: e.status,
              duration_ms: e.duration_ms,
              resource_type: e.resource_type,
            }));
        }
        result.network = summary;
      }

      if (collect.has('assets')) {
        result.assets = failedAssets;
      }

      if (collect.has('resources')) {
        const counts: Record<string, number> = {
          stylesheet: 0,
          script: 0,
          image: 0,
          font: 0,
          media: 0,
          xhr_fetch: 0,
          other: 0,
        };
        let transferEstimate = 0;
        for (const e of networkEntries) {
          const rt = e.resource_type;
          if (rt === 'stylesheet') counts.stylesheet++;
          else if (rt === 'script') counts.script++;
          else if (rt === 'image') counts.image++;
          else if (rt === 'font') counts.font++;
          else if (rt === 'media') counts.media++;
          else if (rt === 'xhr' || rt === 'fetch') counts.xhr_fetch++;
          else counts.other++;
          transferEstimate += responseSizes.get(e.url + e.method) ?? 0;
        }
        result.resources = {
          counts,
          request_count: networkEntries.length,
          transfer_size_estimate_bytes: transferEstimate,
        };
      }

      if (collect.has('json_ld') && dom.json_ld) {
        result.json_ld = (dom.json_ld as string[]).map((raw) => {
          try {
            const parsed = JSON.parse(raw);
            const types = jsonLdTypes(parsed);
            return {
              valid: true,
              types,
              missing_fields: missingJsonLdFields(types, parsed),
              parse_error: null,
            };
          } catch (err) {
            return {
              valid: false,
              types: [] as string[],
              missing_fields: [] as string[],
              parse_error: err instanceof Error ? err.message : String(err),
            };
          }
        });
      }

      if (collect.has('canonical')) {
        const rawHref = dom.canonical_href as string | null;
        let canonicalAbsolute: string | null = null;
        const notes: string[] = [];
        if (rawHref) {
          try {
            canonicalAbsolute = new URL(rawHref, finalUrl).toString();
            if (canonicalAbsolute !== finalUrl) {
              notes.push('Canonical href points to a different URL than final_url');
            }
          } catch {
            notes.push('Canonical href is not a valid absolute/relative URL');
          }
        } else {
          notes.push('No canonical link element found');
        }
        result.canonical = {
          request_url: options.url,
          redirect_chain: await buildRedirectChain(response),
          final_url: finalUrl,
          canonical_href: rawHref,
          canonical_absolute: canonicalAbsolute,
          notes,
        };
      }

      if (collect.has('images') && dom.images) {
        result.images = (dom.images as unknown[]).slice(0, IMAGES_CAP);
      }

      if (collect.has('a11y_snapshot') && dom.a11y_snapshot) {
        result.a11y_snapshot = dom.a11y_snapshot;
      }

      if (collect.has('forms') && dom.forms) {
        result.forms = (dom.forms as unknown[]).slice(0, FORMS_CAP);
      }

      if (collect.has('opengraph')) {
        result.opengraph = dom.opengraph ?? {};
        if (options.screenshot) {
          const buf = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
          result.screenshot_base64 = buf.toString('base64');
        }
      }

      if (collect.has('links') && dom.links_graph) {
        const graph = dom.links_graph as { nodes: unknown[]; edges: unknown[] };
        result.links = {
          nodes: graph.nodes.slice(0, LINKS_CAP),
          edges: graph.edges.slice(0, LINKS_CAP),
        };
      }

      return result;
    },
  );
}

export type BrowseFactsOpts = Omit<PageFactsOptions, 'url' | 'collect'>;

function pickBrowse(opts: BrowseFactsOpts): Partial<PageFactsOptions> {
  return opts;
}

export async function checkCookies(url: string, opts: BrowseFactsOpts = {}) {
  return collectPageFacts({ url, collect: ['cookies'], ...pickBrowse(opts) });
}

export async function checkConsole(url: string, opts: BrowseFactsOpts = {}) {
  return collectPageFacts({ url, collect: ['console'], ...pickBrowse(opts) });
}

export async function checkNetwork(url: string, opts: BrowseFactsOpts & { top_slowest?: boolean } = {}) {
  return collectPageFacts({
    url,
    collect: ['network'],
    topSlowest: opts.top_slowest,
    ...pickBrowse(opts),
  });
}

export async function checkAssets(url: string, opts: BrowseFactsOpts = {}) {
  return collectPageFacts({ url, collect: ['network', 'assets'], ...pickBrowse(opts) });
}

export async function checkJsonLd(url: string, opts: BrowseFactsOpts = {}) {
  return collectPageFacts({ url, collect: ['json_ld'], ...pickBrowse(opts) });
}

export async function checkCanonical(url: string, opts: BrowseFactsOpts = {}) {
  return collectPageFacts({ url, collect: ['canonical'], ...pickBrowse(opts) });
}

export async function checkImages(url: string, opts: BrowseFactsOpts = {}) {
  return collectPageFacts({ url, collect: ['images'], ...pickBrowse(opts) });
}

export async function checkResources(url: string, opts: BrowseFactsOpts = {}) {
  return collectPageFacts({ url, collect: ['network', 'resources'], ...pickBrowse(opts) });
}

export async function checkA11ySnapshot(url: string, opts: BrowseFactsOpts = {}) {
  return collectPageFacts({ url, collect: ['a11y_snapshot'], ...pickBrowse(opts) });
}

export async function checkForms(url: string, opts: BrowseFactsOpts = {}) {
  return collectPageFacts({ url, collect: ['forms'], ...pickBrowse(opts) });
}

export async function checkOpenGraph(
  url: string,
  opts: BrowseFactsOpts & { screenshot?: boolean } = {},
) {
  return collectPageFacts({
    url,
    collect: ['opengraph'],
    screenshot: opts.screenshot,
    ...pickBrowse(opts),
  });
}

export async function checkLinks(url: string, opts: BrowseFactsOpts = {}) {
  return collectPageFacts({ url, collect: ['links'], ...pickBrowse(opts) });
}

export async function diffDomUrls(
  urlA: string,
  urlB: string,
  opts: BrowseFactsOpts = {},
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const blockPatterns = [
    ...(opts.blockUrlPatterns ?? []),
    ...(opts.blockAds ? DEFAULT_AD_TRACKER_PATTERNS : []),
  ];

  async function loadTree(url: string): Promise<{ finalUrl: string; tree: DomTreeNode | null }> {
    return withPageValue(
      {
        width: opts.width,
        height: opts.height,
        colorScheme: opts.colorScheme,
        locale: opts.locale,
        userAgent: opts.userAgent,
        extraHTTPHeaders: opts.extraHTTPHeaders,
        blockResourceTypes: opts.blockResourceTypes,
        blockUrlPatterns: blockPatterns,
        httpCredentials: opts.httpCredentials,
        clientCertificates: opts.clientCertificates,
        runtime: opts.runtime,
      },
      async (page) => {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: opts.gotoTimeoutMs ?? 45_000,
        });
        await maybeDismissCookieBanner(page, opts.dismissCookieBanner);
        await applyWaitForSelector(page, {
          waitForSelector: opts.waitForSelector,
          waitTimeoutMs: opts.waitTimeoutMs,
          required: opts.waitForSelectorRequired,
        });
        if ((opts.settleMs ?? 0) > 0) await page.waitForTimeout(opts.settleMs!);
        // Evaluate IIFE string as page expression (Playwright accepts string expressions).
        const tree = (await page.evaluate(domSerializeScript(8, 120) as unknown as () => DomTreeNode | null)) as DomTreeNode | null;
        return { finalUrl: page.url(), tree };
      },
    );
  }

  const [a, b] = await Promise.all([loadTree(urlA), loadTree(urlB)]);
  const diff = diffDomTrees(a.tree, b.tree);

  return {
    status: 'success',
    url_a: urlA,
    url_b: urlB,
    final_url_a: a.finalUrl,
    final_url_b: b.finalUrl,
    diff,
    response_time_ms: Date.now() - started,
    timestamp: new Date().toISOString(),
  };
}

export async function diffHeaders(urlA: string, urlB: string): Promise<Record<string, unknown>> {
  const started = Date.now();
  const aUrl = await assertPublicHttpUrl(urlA);
  const bUrl = await assertPublicHttpUrl(urlB);

  async function fetchHeaders(url: string): Promise<Record<string, string>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'MacroScout/0.6' },
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return headers;
    } finally {
      clearTimeout(timer);
    }
  }

  const [headersA, headersB] = await Promise.all([fetchHeaders(aUrl), fetchHeaders(bUrl)]);
  const keysA = new Set(Object.keys(headersA));
  const keysB = new Set(Object.keys(headersB));

  const onlyA: Record<string, string> = {};
  const onlyB: Record<string, string> = {};
  const changed: Array<{ key: string; a: string; b: string }> = [];

  for (const k of keysA) {
    if (!keysB.has(k)) onlyA[k] = headersA[k]!;
    else if (headersA[k] !== headersB[k]) {
      changed.push({ key: k, a: headersA[k]!, b: headersB[k]! });
    }
  }
  for (const k of keysB) {
    if (!keysA.has(k)) onlyB[k] = headersB[k]!;
  }

  return {
    status: 'success',
    url_a: aUrl,
    url_b: bUrl,
    only_a: onlyA,
    only_b: onlyB,
    changed,
    response_time_ms: Date.now() - started,
    timestamp: new Date().toISOString(),
  };
}

export { inspectSitemap } from './sitemapInspect';
