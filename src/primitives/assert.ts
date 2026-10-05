import type { Page } from 'playwright';
import {
  DEFAULT_AD_TRACKER_PATTERNS,
  type ResourceType,
  withPageValue,
  type WithPageOptions,
} from '../browser/pool';
import { pageEvaluate } from '../browser/playwrightEvaluate';
import { maybeDismissCookieBanner } from '../lib/cookieBanner';
import { applyWaitForSelector } from '../lib/pageWait';
import { maybeSolveCaptcha } from '../lib/solveCaptcha';
import { attachXhrCapture } from '../lib/xhrCapture';

export type AssertRule = {
  selector: string;
  /** Expect element to exist (default true when other operators need a node). */
  exists?: boolean;
  visible?: boolean;
  not_covered?: boolean;
  /** Exact match count for querySelectorAll. */
  count?: number;
  count_min?: number;
  count_max?: number;
  /** Substring of textContent (trimmed, whitespace-collapsed). */
  contains?: string;
  /** Exact textContent match (trimmed, whitespace-collapsed). */
  text?: string;
  /** RegExp source tested against textContent. */
  matches?: string;
  href_contains?: string;
  attr?: { name: string; value: string };
  /** Failures with soft:true do not flip overall `passed`. */
  soft?: boolean;
  /** If the selector misses, relocate by class/text similarity. */
  adaptive?: boolean;
  match_text?: string;
};

export type AssertOptions = {
  url: string;
  assert: AssertRule[];
  settleMs?: number;
  gotoTimeoutMs?: number;
  waitForSelector?: string;
  waitTimeoutMs?: number;
  waitForSelectorRequired?: boolean;
  scrollIntoView?: boolean;
  ignoreSelectors?: string[];
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
  dismissCookieBanner?: boolean;
  solveCaptcha?: boolean;
  captureXhr?: string;
  javaScriptEnabled?: boolean;
  runtime?: WithPageOptions['runtime'];
};

export type AssertCheckDetail = {
  name: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
};

export type AssertResultItem = {
  selector: string;
  used_selector?: string;
  selector_relocated?: boolean;
  ok: boolean;
  soft: boolean;
  checks: AssertCheckDetail[];
  evidence: {
    count: number;
    text: string | null;
    href: string | null;
    visible: boolean | null;
    in_viewport: boolean | null;
    not_covered: boolean | null;
    overlap_detected_by: string | null;
  };
  error: string | null;
};

export type AssertPageResult = {
  status: 'success';
  url: string;
  final_url: string;
  passed: boolean;
  results: AssertResultItem[];
  failed_count: number;
  soft_failed_count: number;
  response_time_ms: number;
  timestamp: string;
  cookie_banner_detected?: boolean;
  cookie_banner_dismissed?: boolean;
  cookie_banner_vendor?: string | null;
  captured_xhr?: import('../lib/xhrCapture').CapturedXhr[];
  captcha_detected?: boolean;
  captcha_solved?: boolean;
  fetch_mode?: 'browser' | 'http';
};

type BrowserAssertItem = AssertResultItem;

/**
 * Run all assert rules in one page.evaluate after a single navigation.
 */
export async function runAsserts(options: AssertOptions): Promise<AssertPageResult> {
  const started = Date.now();
  const blockPatterns = [
    ...(options.blockUrlPatterns ?? []),
    ...(options.blockAds ? DEFAULT_AD_TRACKER_PATTERNS : []),
  ];

  const pageResult = await withPageValue(
    {
      width: options.width ?? 1280,
      height: options.height ?? 800,
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
      javaScriptEnabled: options.javaScriptEnabled,
      runtime: options.runtime,
    },
    async (page: Page) => {
      const xhr = attachXhrCapture(page, options.captureXhr);
      await page.goto(options.url, {
        waitUntil: options.javaScriptEnabled === false ? 'commit' : 'domcontentloaded',
        timeout: options.gotoTimeoutMs ?? 45_000,
      });
      const cookie = await maybeDismissCookieBanner(page, options.dismissCookieBanner);
      const solved = await maybeSolveCaptcha(page, options.solveCaptcha);
      await applyWaitForSelector(page, {
        waitForSelector: options.waitForSelector,
        waitTimeoutMs: options.waitTimeoutMs,
        required: options.waitForSelectorRequired,
      });
      if ((options.settleMs ?? 0) > 0) await page.waitForTimeout(options.settleMs!);

      const results = (await pageEvaluate(
        page,
        ({ rules, scrollIntoView, ignoreSelectors }) => {
          const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

          const measureVisibility = (target: HTMLElement, ignoreList: string[]) => {
            const style = window.getComputedStyle(target);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              parseFloat(style.opacity) < 0.05
            ) {
              return {
                visible: false,
                in_viewport: false,
                not_covered: false,
                overlap_detected_by: null as string | null,
                reason: 'Element is hidden by CSS',
              };
            }

            if (scrollIntoView && typeof target.scrollIntoView === 'function') {
              target.scrollIntoView({ block: 'center', inline: 'nearest' });
            }

            const rect = target.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) {
              return {
                visible: false,
                in_viewport: false,
                not_covered: false,
                overlap_detected_by: null as string | null,
                reason: 'Element has no visible size',
              };
            }

            const vw = window.innerWidth || document.documentElement.clientWidth;
            const vh = window.innerHeight || document.documentElement.clientHeight;
            const in_viewport =
              rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;

            const isIgnorable = (node: Element): boolean => {
              if (node === document.documentElement || node === document.body) return true;
              if (node === target || target.contains(node)) return true;
              for (let i = 0; i < ignoreList.length; i++) {
                if (node.closest && node.closest(ignoreList[i])) return true;
              }
              const s = window.getComputedStyle(node);
              if (s.pointerEvents === 'none' || parseFloat(s.opacity) < 0.02) return true;
              return false;
            };

            const isOccluded = (x: number, y: number): string | null => {
              if (typeof document.elementsFromPoint !== 'function') return null;
              const stack = document.elementsFromPoint(x, y);
              for (let i = 0; i < stack.length; i++) {
                const node = stack[i];
                if (node === target || target.contains(node)) return null;
                if (isIgnorable(node)) continue;
                const id = node.id ? `#${node.id}` : '';
                const cls =
                  typeof node.className === 'string' && node.className.trim()
                    ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}`
                    : '';
                return `${node.tagName.toLowerCase()}${id}${cls}`;
              }
              return null;
            };

            const points: Array<[number, number]> = [
              [rect.left + rect.width * 0.5, rect.top + rect.height * 0.5],
              [rect.left + Math.min(8, rect.width * 0.25), rect.top + rect.height * 0.5],
              [rect.left + rect.width - Math.min(8, rect.width * 0.25), rect.top + rect.height * 0.5],
              [rect.left + rect.width * 0.5, rect.top + Math.min(6, rect.height * 0.25)],
              [rect.left + rect.width * 0.5, rect.top + rect.height - Math.min(6, rect.height * 0.25)],
            ];

            for (let p = 0; p < points.length; p++) {
              const overlap = isOccluded(points[p][0], points[p][1]);
              if (overlap) {
                return {
                  visible: true,
                  in_viewport,
                  not_covered: false,
                  overlap_detected_by: overlap,
                  reason: 'Element is covered by another element',
                };
              }
            }

            return {
              visible: true,
              in_viewport,
              not_covered: true,
              overlap_detected_by: null as string | null,
              reason: null as string | null,
            };
          };

          const out: BrowserAssertItem[] = [];

          for (const rule of rules) {
            const checks: AssertCheckDetail[] = [];
            const soft = Boolean(rule.soft);
            let error: string | null = null;

            let nodes: Element[] = [];
            let usedSelector = rule.selector;
            let relocated = false;
            try {
              nodes = Array.from(document.querySelectorAll(rule.selector));
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              out.push({
                selector: rule.selector,
                ok: false,
                soft,
                checks: [],
                evidence: {
                  count: 0,
                  text: null,
                  href: null,
                  visible: null,
                  in_viewport: null,
                  not_covered: null,
                  overlap_detected_by: null,
                },
                error: `Invalid selector: ${message}`.slice(0, 240),
              });
              continue;
            }

            if (!nodes.length && (rule.adaptive || rule.match_text)) {
              const last = rule.selector.trim().split(/[\s>+~]+/).pop() || '';
              const idMatch = last.match(/#([A-Za-z_][\w-]*)/);
              const tagMatch = last.match(/^([a-z][a-z0-9]*)/i);
              const classes = [...last.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
              const tag = tagMatch?.[1]?.toLowerCase() || '*';
              if (idMatch?.[1]) {
                const byId = document.getElementById(idMatch[1]);
                if (byId) {
                  nodes = [byId];
                  relocated = true;
                  usedSelector = byId.id ? `#${byId.id}` : rule.selector;
                }
              }
              if (!nodes.length) {
                const needle = (rule.match_text || '').trim().toLowerCase();
                const candidates = Array.from(document.querySelectorAll(tag === '*' ? 'body *' : tag)) as HTMLElement[];
                let best: HTMLElement[] = [];
                let bestScore = 0;
                for (const el of candidates) {
                  let score = 0;
                  if (tag !== '*' && el.tagName.toLowerCase() === tag) score += 1;
                  for (const cls of classes) if (el.classList.contains(cls)) score += 3;
                  if (needle && (el.textContent || '').toLowerCase().includes(needle)) score += 4;
                  if (score > bestScore) {
                    bestScore = score;
                    best = [el];
                  } else if (score === bestScore && score > 0) best.push(el);
                }
                if (bestScore >= 3 && best.length) {
                  nodes = best;
                  relocated = true;
                  usedSelector = best[0].id ? `#${best[0].id}` : rule.selector;
                }
              }
            }

            const count = nodes.length;
            const first = (nodes[0] as HTMLElement | undefined) ?? null;
            const rawText = first ? collapse(first.textContent || '') : '';
            const text = rawText.slice(0, 500) || null;
            let href: string | null = null;
            if (first) {
              const anchor =
                first instanceof HTMLAnchorElement
                  ? first
                  : (first.querySelector('a') as HTMLAnchorElement | null);
              href = anchor?.href ?? first.getAttribute('href');
            }

            let visible: boolean | null = null;
            let in_viewport: boolean | null = null;
            let not_covered: boolean | null = null;
            let overlap_detected_by: string | null = null;

            const needsVisibility =
              rule.visible !== undefined || rule.not_covered !== undefined;

            if (first && needsVisibility) {
              const m = measureVisibility(first, ignoreSelectors);
              visible = m.visible;
              in_viewport = m.in_viewport;
              not_covered = m.not_covered;
              overlap_detected_by = m.overlap_detected_by;
              if (m.reason && (rule.visible === true || rule.not_covered === true)) {
                error = m.reason;
              }
            } else if (first && (rule.exists !== false || rule.contains || rule.text || rule.matches)) {
              // lightweight visibility sample for evidence when useful
              const style = window.getComputedStyle(first);
              visible = !(
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                parseFloat(style.opacity) < 0.05
              );
            }

            const expectExists =
              rule.exists !== undefined
                ? rule.exists
                : rule.visible !== undefined ||
                    rule.not_covered !== undefined ||
                    rule.contains !== undefined ||
                    rule.text !== undefined ||
                    rule.matches !== undefined ||
                    rule.href_contains !== undefined ||
                    rule.attr !== undefined
                  ? true
                  : undefined;

            if (expectExists !== undefined) {
              const ok = expectExists ? count > 0 : count === 0;
              checks.push({ name: 'exists', expected: expectExists, actual: count > 0, ok });
              if (!ok && !error) {
                error = expectExists ? 'Element not found' : 'Element unexpectedly present';
              }
            }

            if (rule.count !== undefined) {
              const ok = count === rule.count;
              checks.push({ name: 'count', expected: rule.count, actual: count, ok });
              if (!ok && !error) error = `Expected count ${rule.count}, got ${count}`;
            }
            if (rule.count_min !== undefined) {
              const ok = count >= rule.count_min;
              checks.push({ name: 'count_min', expected: rule.count_min, actual: count, ok });
              if (!ok && !error) error = `Expected count >= ${rule.count_min}, got ${count}`;
            }
            if (rule.count_max !== undefined) {
              const ok = count <= rule.count_max;
              checks.push({ name: 'count_max', expected: rule.count_max, actual: count, ok });
              if (!ok && !error) error = `Expected count <= ${rule.count_max}, got ${count}`;
            }

            if (rule.visible !== undefined) {
              const actual = Boolean(visible);
              const ok = count > 0 && actual === rule.visible;
              checks.push({ name: 'visible', expected: rule.visible, actual: count > 0 ? actual : false, ok });
              if (!ok && !error) {
                error = rule.visible ? 'Element not visible' : 'Element unexpectedly visible';
              }
            }

            if (rule.not_covered !== undefined) {
              const actual = Boolean(not_covered);
              const ok = count > 0 && actual === rule.not_covered;
              checks.push({
                name: 'not_covered',
                expected: rule.not_covered,
                actual: count > 0 ? actual : false,
                ok,
              });
              if (!ok && !error) {
                error = rule.not_covered
                  ? `Element is covered${overlap_detected_by ? ` by ${overlap_detected_by}` : ''}`
                  : 'Element unexpectedly uncovered';
              }
            }

            if (rule.contains !== undefined) {
              const needle = collapse(rule.contains);
              const actual = text ?? '';
              const ok = count > 0 && actual.includes(needle);
              checks.push({ name: 'contains', expected: needle, actual, ok });
              if (!ok && !error) error = `Text does not contain "${needle}"`;
            }

            if (rule.text !== undefined) {
              const expected = collapse(rule.text);
              const actual = text ?? '';
              const ok = count > 0 && actual === expected;
              checks.push({ name: 'text', expected, actual, ok });
              if (!ok && !error) error = 'Text does not match';
            }

            if (rule.matches !== undefined) {
              let ok = false;
              let regexError: string | null = null;
              try {
                const re = new RegExp(rule.matches);
                ok = count > 0 && re.test(text ?? '');
              } catch (err) {
                regexError = err instanceof Error ? err.message : String(err);
                ok = false;
              }
              checks.push({
                name: 'matches',
                expected: rule.matches,
                actual: text,
                ok: regexError ? false : ok,
              });
              if (regexError && !error) error = `Invalid matches regex: ${regexError}`;
              else if (!ok && !error) error = 'Text does not match pattern';
            }

            if (rule.href_contains !== undefined) {
              const needle = rule.href_contains;
              const actual = href ?? '';
              const ok = count > 0 && actual.includes(needle);
              checks.push({ name: 'href_contains', expected: needle, actual, ok });
              if (!ok && !error) error = `href does not contain "${needle}"`;
            }

            if (rule.attr) {
              const actual = first ? (first.getAttribute(rule.attr.name) || '').trim() : '';
              const expected = (rule.attr.value || '').trim();
              const ok = count > 0 && actual === expected;
              checks.push({
                name: 'attr',
                expected: { name: rule.attr.name, value: expected },
                actual: { name: rule.attr.name, value: actual },
                ok,
              });
              if (!ok && !error) error = `Attribute ${rule.attr.name} mismatch`;
            }

            // If only selector with no operators — treat as exists:true
            if (checks.length === 0) {
              const ok = count > 0;
              checks.push({ name: 'exists', expected: true, actual: ok, ok });
              if (!ok) error = 'Element not found';
            }

            const ok = checks.every((c) => c.ok);
            out.push({
              selector: rule.selector,
              used_selector: usedSelector,
              selector_relocated: relocated,
              ok,
              soft,
              checks,
              evidence: {
                count,
                text,
                href,
                visible,
                in_viewport,
                not_covered,
                overlap_detected_by,
              },
              error: ok ? null : error,
            });
          }

          return out;
        },
        {
          rules: options.assert.map((r) => ({
            selector: r.selector,
            exists: r.exists,
            visible: r.visible,
            not_covered: r.not_covered,
            count: r.count,
            count_min: r.count_min,
            count_max: r.count_max,
            contains: r.contains,
            text: r.text,
            matches: r.matches,
            href_contains: r.href_contains,
            attr: r.attr,
            soft: r.soft,
            adaptive: r.adaptive,
            match_text: r.match_text,
          })),
          scrollIntoView: options.scrollIntoView !== false,
          ignoreSelectors: options.ignoreSelectors ?? [],
        },
      )) as BrowserAssertItem[];

      const hardFailed = results.filter((r) => !r.ok && !r.soft).length;
      const softFailed = results.filter((r) => !r.ok && r.soft).length;

      xhr.detach();
      return {
        status: 'success' as const,
        url: options.url,
        final_url: page.url(),
        passed: hardFailed === 0,
        results,
        failed_count: hardFailed,
        soft_failed_count: softFailed,
        response_time_ms: Date.now() - started,
        timestamp: new Date().toISOString(),
        captured_xhr: options.captureXhr ? xhr.items() : undefined,
        captcha_detected: solved?.captcha_detected,
        captcha_solved: solved?.captcha_solved,
        fetch_mode: options.javaScriptEnabled === false ? ('http' as const) : ('browser' as const),
        ...(cookie
          ? {
              cookie_banner_detected: cookie.cookie_banner_detected,
              cookie_banner_dismissed: cookie.cookie_banner_dismissed,
              cookie_banner_vendor: cookie.cookie_banner_vendor,
            }
          : {}),
      };
    },
  );

  return pageResult;
}

/** Credits: 3 base + 1 per assert after the first (capped by caller assert length). */
export function estimateAssertCredits(assertCount: number): number {
  const n = Math.max(1, Math.min(Math.floor(assertCount), 25));
  return 3 + Math.max(0, n - 1);
}
