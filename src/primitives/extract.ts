import type { Page } from 'playwright';
import { DEFAULT_AD_TRACKER_PATTERNS, withPageValue, type WithPageOptions } from '../browser/pool';
import { pageEvaluate } from '../browser/playwrightEvaluate';
import { detectCaptcha } from '../lib/captcha';
import { maybeDismissCookieBanner, type CookieBannerResult } from '../lib/cookieBanner';
import { ScoutError } from '../lib/errors';
import { applyWaitForSelector } from '../lib/pageWait';
import { maybeSolveCaptcha } from '../lib/solveCaptcha';
import { attachXhrCapture, type CapturedXhr } from '../lib/xhrCapture';

export type ExtractField =
  | { name: string; selector: string; type: 'exists'; adaptive?: boolean; match_text?: string }
  | { name: string; selector: string; type: 'text'; adaptive?: boolean; match_text?: string }
  | { name: string; selector: string; type: 'html'; adaptive?: boolean; match_text?: string }
  | { name: string; selector: string; type: 'attribute'; attribute: string; adaptive?: boolean; match_text?: string }
  | { name: string; selector: string; type: 'count'; adaptive?: boolean; match_text?: string }
  | { name: string; selector: string; type: 'list'; adaptive?: boolean; match_text?: string }
  | { name: string; selector: string; type: 'similar'; adaptive?: boolean; match_text?: string }
  | { name: string; selector: string; type: 'selector'; adaptive?: boolean; match_text?: string };

export type ExtractOptions = {
  url: string;
  fields: ExtractField[];
  waitForSelector?: string;
  waitForSelectorRequired?: boolean;
  settleMs?: number;
  gotoTimeoutMs?: number;
  waitTimeoutMs?: number;
  width?: number;
  height?: number;
  detectCaptcha?: boolean;
  dismissCookieBanner?: boolean;
  solveCaptcha?: boolean;
  captureXhr?: string;
  pageOptions?: Partial<WithPageOptions>;
  blockAds?: boolean;
};

export type SelectorRelocation = {
  name: string;
  from: string;
  to: string;
};

export type ExtractResult = {
  status: 'success' | 'error';
  data: Record<string, unknown>;
  final_url: string;
  response_time_ms: number;
  error?: string;
  captcha_detected?: boolean;
  captcha_solved?: boolean;
  captcha_signals?: Array<{ id: string; evidence: string }>;
  cookie_banner_detected?: boolean;
  cookie_banner_dismissed?: boolean;
  cookie_banner_vendor?: string | null;
  captured_xhr?: CapturedXhr[];
  selector_relocations?: SelectorRelocation[];
  fetch_mode?: 'browser' | 'http';
};

type PageExtractOut = {
  data: Record<string, unknown>;
  relocations: SelectorRelocation[];
};

export async function extractOnPage(page: Page, fields: ExtractField[]): Promise<PageExtractOut> {
  return pageEvaluate(page, (fieldDefs) => {
    const cssPath = (el: Element): string => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === 1 && parts.length < 5) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
        const cls = Array.from(node.classList).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
        part += cls;
        const parent: Element | null = node.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    };

    const parseHint = (selector: string) => {
      const last = selector.trim().split(/[\s>+~]+/).pop() || '';
      const idMatch = last.match(/#([A-Za-z_][\w-]*)/);
      const tagMatch = last.match(/^([a-z][a-z0-9]*)/i);
      const classes = [...last.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
      return {
        tag: tagMatch?.[1]?.toLowerCase() || '*',
        id: idMatch?.[1] ?? null,
        classes,
      };
    };

    const relocate = (selector: string, adaptive: boolean | undefined, matchText?: string) => {
      let nodes: Element[] = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch {
        nodes = [];
      }
      if (nodes.length) return { nodes, relocated: false, used: selector };
      if (!adaptive && !matchText) return { nodes: [], relocated: false, used: selector };

      const hint = parseHint(selector);
      if (hint.id) {
        const byId = document.getElementById(hint.id);
        if (byId) return { nodes: [byId], relocated: true, used: cssPath(byId) };
      }

      const candidates = Array.from(
        document.querySelectorAll(hint.tag === '*' ? 'body *' : hint.tag),
      ) as HTMLElement[];
      const needle = (matchText || '').trim().toLowerCase();
      let best: HTMLElement[] = [];
      let bestScore = 0;
      for (const el of candidates) {
        let score = 0;
        if (hint.tag !== '*' && el.tagName.toLowerCase() === hint.tag) score += 1;
        for (const cls of hint.classes) {
          if (el.classList.contains(cls)) score += 3;
        }
        if (needle && (el.textContent || '').toLowerCase().includes(needle)) score += 4;
        if (score > bestScore) {
          bestScore = score;
          best = [el];
        } else if (score === bestScore && score > 0) {
          best.push(el);
        }
      }
      if (bestScore >= 3 && best.length) {
        return { nodes: best, relocated: true, used: cssPath(best[0]) };
      }
      return { nodes: [], relocated: false, used: selector };
    };

    const similarTo = (el: Element): Element[] => {
      const classes = Array.from(el.classList);
      const parent = el.parentElement;
      const pool = parent ? Array.from(parent.children) : Array.from(document.querySelectorAll(el.tagName));
      return pool.filter((n) => {
        if (n.tagName !== el.tagName) return false;
        if (!classes.length) return n !== el ? true : true;
        const overlap = classes.filter((c) => n.classList.contains(c)).length;
        return overlap >= Math.max(1, Math.ceil(classes.length / 2));
      });
    };

    const data: Record<string, unknown> = {};
    const relocations: Array<{ name: string; from: string; to: string }> = [];

    for (const field of fieldDefs) {
      const found = relocate(field.selector, field.adaptive, field.match_text);
      if (found.relocated && found.used !== field.selector) {
        relocations.push({ name: field.name, from: field.selector, to: found.used });
      }
      const nodes = found.nodes;
      if (field.type === 'exists') {
        data[field.name] = nodes.length > 0;
      } else if (field.type === 'count') {
        data[field.name] = nodes.length;
      } else if (field.type === 'text') {
        const el = nodes[0];
        data[field.name] = el ? (el.textContent || '').trim() : null;
      } else if (field.type === 'html') {
        const el = nodes[0];
        data[field.name] = el ? el.innerHTML : null;
      } else if (field.type === 'attribute') {
        const el = nodes[0];
        data[field.name] = el ? el.getAttribute(field.attribute || '') : null;
      } else if (field.type === 'list') {
        data[field.name] = nodes.map((el) => (el.textContent || '').trim()).filter(Boolean);
      } else if (field.type === 'similar') {
        const first = nodes[0];
        const group = first ? similarTo(first) : [];
        data[field.name] = group.map((el) => (el.textContent || '').trim()).filter(Boolean);
      } else if (field.type === 'selector') {
        const el = nodes[0];
        data[field.name] = el ? cssPath(el) : null;
      }
    }

    return { data, relocations };
  }, fields);
}

function attachCookieFields<T extends Record<string, unknown>>(
  result: T,
  cookie: CookieBannerResult | undefined,
): T {
  if (!cookie) return result;
  return {
    ...result,
    cookie_banner_detected: cookie.cookie_banner_detected,
    cookie_banner_dismissed: cookie.cookie_banner_dismissed,
    cookie_banner_vendor: cookie.cookie_banner_vendor,
  };
}

export async function extractFields(options: ExtractOptions): Promise<ExtractResult> {
  const started = Date.now();
  const fetchMode: 'browser' | 'http' = options.pageOptions?.javaScriptEnabled === false ? 'http' : 'browser';
  try {
    return await withPageValue(
      {
        width: options.width ?? options.pageOptions?.width ?? 1280,
        height: options.height ?? options.pageOptions?.height ?? 800,
        ...options.pageOptions,
        blockUrlPatterns: [
          ...(options.pageOptions?.blockUrlPatterns ?? []),
          ...(options.blockAds ? DEFAULT_AD_TRACKER_PATTERNS : []),
        ],
      },
      async (page) => {
        const xhr = attachXhrCapture(page, options.captureXhr);
        await page.goto(options.url, {
          waitUntil: fetchMode === 'http' ? 'commit' : 'domcontentloaded',
          timeout: options.gotoTimeoutMs ?? 20_000,
        });
        const cookie = await maybeDismissCookieBanner(page, options.dismissCookieBanner);
        const solved = await maybeSolveCaptcha(page, options.solveCaptcha);
        await applyWaitForSelector(page, {
          waitForSelector: options.waitForSelector,
          waitTimeoutMs: options.waitTimeoutMs,
          required: options.waitForSelectorRequired,
        });
        if ((options.settleMs ?? 0) > 0) {
          await page.waitForTimeout(options.settleMs!);
        }

        let captcha_detected: boolean | undefined;
        let captcha_signals: Array<{ id: string; evidence: string }> | undefined;
        let captcha_solved: boolean | undefined;
        if (solved) {
          captcha_detected = solved.captcha_detected;
          captcha_signals = solved.captcha_signals;
          captcha_solved = solved.captcha_solved;
        } else if (options.detectCaptcha !== false) {
          const cap = await detectCaptcha(page);
          captcha_detected = cap.captcha_detected;
          captcha_signals = cap.signals;
        }

        const extracted = await extractOnPage(page, options.fields);
        xhr.detach();
        return attachCookieFields(
          {
            status: 'success' as const,
            data: extracted.data,
            final_url: page.url(),
            response_time_ms: Date.now() - started,
            captcha_detected,
            captcha_solved,
            captcha_signals,
            captured_xhr: options.captureXhr ? xhr.items() : undefined,
            selector_relocations: extracted.relocations.length ? extracted.relocations : undefined,
            fetch_mode: fetchMode,
          },
          cookie,
        );
      },
    );
  } catch (err) {
    if (err instanceof ScoutError) throw err;
    return {
      status: 'error',
      data: {},
      final_url: options.url,
      response_time_ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
      fetch_mode: fetchMode,
    };
  }
}
