import type { Page } from 'playwright';
import { withPageValue, type WithPageOptions } from '../browser/pool';
import { pageEvaluate } from '../browser/playwrightEvaluate';
import { maybeDismissCookieBanner } from '../lib/cookieBanner';
import { maybeSolveCaptcha } from '../lib/solveCaptcha';

export type VisibilityExpect = {
  attribute?: { name: string; value: string };
  hrefContains?: string;
};

export type VisibilityCheckOptions = {
  url: string;
  selector: string;
  waitForSelector?: string;
  settleMs?: number;
  scrollIntoView?: boolean;
  ignoreSelectors?: string[];
  expect?: VisibilityExpect;
  gotoTimeoutMs?: number;
  waitTimeoutMs?: number;
  width?: number;
  height?: number;
  dismissCookieBanner?: boolean;
  solveCaptcha?: boolean;
  runtime?: WithPageOptions['runtime'];
};

export type VisibilityCheckResult = {
  overall_pass: boolean;
  exists: boolean;
  visible: boolean;
  in_viewport: boolean;
  not_covered: boolean;
  overlap_detected_by: string | null;
  attribute_match: boolean | null;
  href_match: boolean | null;
  error: string | null;
  status: 'verified' | 'missing' | 'hidden' | 'wrong_token' | 'unreachable';
  final_url: string;
  response_time_ms: number;
  cookie_banner_detected?: boolean;
  cookie_banner_dismissed?: boolean;
  cookie_banner_vendor?: string | null;
  captcha_detected?: boolean;
  captcha_solved?: boolean;
};

type EvalResult = {
  exists: boolean;
  visible: boolean;
  in_viewport: boolean;
  not_covered: boolean;
  overlap_detected_by: string | null;
  attribute_match: boolean | null;
  href_match: boolean | null;
  error: string | null;
  status: 'verified' | 'missing' | 'hidden' | 'wrong_token';
};

async function runVisibilityOnPage(page: Page, options: VisibilityCheckOptions): Promise<Omit<VisibilityCheckResult, 'final_url' | 'response_time_ms' | 'overall_pass'>> {
  const settleMs = Math.max(0, options.settleMs ?? 0);
  const waitTimeoutMs = options.waitTimeoutMs ?? 15_000;
  const waitSelector = options.waitForSelector || options.selector;

  try {
    await page.waitForSelector(waitSelector, { state: 'attached', timeout: waitTimeoutMs });
  } catch {
    return {
      exists: false,
      visible: false,
      in_viewport: false,
      not_covered: false,
      overlap_detected_by: null,
      attribute_match: null,
      href_match: null,
      error: `Selector not found: ${waitSelector}`,
      status: 'missing',
    };
  }

  if (settleMs > 0) {
    await page.waitForTimeout(settleMs);
  }

  const evalResult = (await pageEvaluate(
    page,
    ({
      selector,
      scrollIntoView,
      ignoreSelectors,
      expectAttributeName,
      expectAttributeValue,
      hrefContains,
    }) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) {
        return {
          exists: false,
          visible: false,
          in_viewport: false,
          not_covered: false,
          overlap_detected_by: null,
          attribute_match: null,
          href_match: null,
          error: 'Element not found',
          status: 'missing',
        } satisfies EvalResult;
      }
      const target = el;

      let attribute_match: boolean | null = null;
      if (expectAttributeName) {
        const actual = (target.getAttribute(expectAttributeName) || '').trim();
        attribute_match = actual === (expectAttributeValue || '').trim();
        if (!attribute_match) {
          return {
            exists: true,
            visible: false,
            in_viewport: false,
            not_covered: false,
            overlap_detected_by: null,
            attribute_match: false,
            href_match: null,
            error: 'Attribute value mismatch',
            status: 'wrong_token',
          } satisfies EvalResult;
        }
      }

      let href_match: boolean | null = null;
      if (hrefContains) {
        const anchor = target instanceof HTMLAnchorElement ? target : target.querySelector('a');
        const href = (anchor && 'href' in anchor ? String((anchor as HTMLAnchorElement).href) : '') || '';
        href_match = href.indexOf(hrefContains) !== -1;
        if (!href_match) {
          return {
            exists: true,
            visible: false,
            in_viewport: false,
            not_covered: false,
            overlap_detected_by: null,
            attribute_match,
            href_match: false,
            error: `Link does not contain expected host fragment: ${hrefContains}`,
            status: 'missing',
          } satisfies EvalResult;
        }
      }

      const style = window.getComputedStyle(target);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.05) {
        return {
          exists: true,
          visible: false,
          in_viewport: false,
          not_covered: false,
          overlap_detected_by: null,
          attribute_match,
          href_match,
          error: 'Element is hidden by CSS',
          status: 'hidden',
        } satisfies EvalResult;
      }

      if (scrollIntoView && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
      }

      let rect = target.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        return {
          exists: true,
          visible: false,
          in_viewport: false,
          not_covered: false,
          overlap_detected_by: null,
          attribute_match,
          href_match,
          error: 'Element has no visible size',
          status: 'hidden',
        } satisfies EvalResult;
      }

      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const in_viewport =
        rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;

      const ignoreList = ignoreSelectors || [];
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

      const left = rect.left;
      const top = rect.top;
      const width = rect.width;
      const height = rect.height;
      const points: Array<[number, number]> = [
        [left + width * 0.5, top + height * 0.5],
        [left + Math.min(8, width * 0.25), top + height * 0.5],
        [left + width - Math.min(8, width * 0.25), top + height * 0.5],
        [left + width * 0.5, top + Math.min(6, height * 0.25)],
        [left + width * 0.5, top + height - Math.min(6, height * 0.25)],
      ];

      for (let p = 0; p < points.length; p++) {
        const overlap = isOccluded(points[p][0], points[p][1]);
        if (overlap) {
          return {
            exists: true,
            visible: true,
            in_viewport,
            not_covered: false,
            overlap_detected_by: overlap,
            attribute_match,
            href_match,
            error: 'Element is covered by another element',
            status: 'hidden',
          } satisfies EvalResult;
        }
      }

      return {
        exists: true,
        visible: true,
        in_viewport,
        not_covered: true,
        overlap_detected_by: null,
        attribute_match,
        href_match,
        error: null,
        status: 'verified',
      } satisfies EvalResult;
    },
    {
      selector: options.selector,
      scrollIntoView: options.scrollIntoView !== false,
      ignoreSelectors: options.ignoreSelectors ?? [],
      expectAttributeName: options.expect?.attribute?.name ?? null,
      expectAttributeValue: options.expect?.attribute?.value ?? null,
      hrefContains: options.expect?.hrefContains ?? null,
    },
  )) as EvalResult;

  return evalResult;
}

export async function checkVisibility(options: VisibilityCheckOptions): Promise<VisibilityCheckResult> {
  const started = Date.now();
  const gotoTimeoutMs = options.gotoTimeoutMs ?? (options.solveCaptcha ? 45_000 : 20_000);

  try {
    return await withPageValue(
      { width: options.width ?? 1280, height: options.height ?? 800, runtime: options.runtime },
      async (page) => {
        await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs });
        const cookie = await maybeDismissCookieBanner(page, options.dismissCookieBanner);
        const solved = await maybeSolveCaptcha(page, options.solveCaptcha);
        const result = await runVisibilityOnPage(page, options);
        const overall_pass = result.status === 'verified';
        return {
          ...result,
          overall_pass,
          final_url: page.url(),
          response_time_ms: Date.now() - started,
          ...(cookie
            ? {
                cookie_banner_detected: cookie.cookie_banner_detected,
                cookie_banner_dismissed: cookie.cookie_banner_dismissed,
                cookie_banner_vendor: cookie.cookie_banner_vendor,
              }
            : {}),
          ...(solved
            ? {
                captcha_detected: solved.captcha_detected,
                captcha_solved: solved.captcha_solved,
              }
            : {}),
        };
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      overall_pass: false,
      exists: false,
      visible: false,
      in_viewport: false,
      not_covered: false,
      overlap_detected_by: null,
      attribute_match: null,
      href_match: null,
      error: message.slice(0, 240),
      status: 'unreachable',
      final_url: options.url,
      response_time_ms: Date.now() - started,
    };
  }
}
