import type { Page } from 'playwright';
import { withPageValue, type ScoutCookie, type WithPageOptions } from '../browser/pool';
import { pageEvaluate } from '../browser/playwrightEvaluate';
import { maybeDismissCookieBanner, type CookieBannerResult } from '../lib/cookieBanner';
import { maybeSolveCaptcha } from '../lib/solveCaptcha';
import { attachXhrCapture, type CapturedXhr } from '../lib/xhrCapture';
import { extractOnPage, type ExtractField } from './extract';
import { runInteractAction, type InteractAction } from './interact';

export type JourneyStep =
  | { type: 'navigate'; url: string; wait_until?: 'load' | 'domcontentloaded' | 'networkidle'; timeout_ms?: number }
  | { type: 'set_content'; html: string; wait_until?: 'load' | 'domcontentloaded' | 'networkidle'; timeout_ms?: number }
  | { type: 'interact'; action: InteractAction['action']; selector?: string; text?: string; clear?: boolean; y?: number; key?: string; value?: string; ms?: number; state?: 'attached' | 'visible' | 'hidden'; timeout_ms?: number }
  | { type: 'extract'; fields: ExtractField[] }
  | { type: 'visibility'; selector: string; scroll_into_view?: boolean; ignore_selectors?: string[] }
  | { type: 'screenshot'; mode?: 'viewport' | 'fullpage'; format?: 'jpeg' | 'png'; quality?: number }
  | { type: 'evaluate'; expression: string }
  | { type: 'wait_for_function'; expression: string; timeout_ms?: number };

export type JourneyDebugOptions = {
  /** Capture a viewport JPEG after each step (or only on failure). Default true when debug is enabled. */
  screenshots?: boolean;
  /** Only attach a screenshot for the failing step. Default false. */
  on_error_only?: boolean;
  format?: 'jpeg' | 'png';
  quality?: number;
};

export type JourneyOptions = {
  steps: JourneyStep[];
  width?: number;
  height?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  cookies?: ScoutCookie[];
  allowEvaluate?: boolean;
  /** Visual debug: attach page URL + optional screenshot to each step result. */
  debug?: boolean | JourneyDebugOptions;
  /** After each navigate/set_content, try known CMP accept buttons (no domain verify). */
  dismissCookieBanner?: boolean;
  solveCaptcha?: boolean;
  captureXhr?: string;
  javaScriptEnabled?: boolean;
  runtime?: WithPageOptions['runtime'];
};

export type JourneyStepDebug = {
  url: string;
  screenshot?: {
    format: 'jpeg' | 'png';
    base64: string;
  };
};

export type JourneyStepResult = {
  index: number;
  type: string;
  ok: boolean;
  error?: string;
  data?: unknown;
  debug?: JourneyStepDebug;
};

export type JourneyResult = {
  status: 'success' | 'error';
  steps: JourneyStepResult[];
  final_url: string;
  cookies: ScoutCookie[];
  response_time_ms: number;
  error?: string;
  cookie_banner_detected?: boolean;
  cookie_banner_dismissed?: boolean;
  cookie_banner_vendor?: string | null;
  captured_xhr?: CapturedXhr[];
  captcha_detected?: boolean;
  captcha_solved?: boolean;
  fetch_mode?: 'browser' | 'http';
  debug?: {
    enabled: true;
    screenshots: boolean;
    on_error_only: boolean;
    screenshot_count: number;
  };
};

function normalizeDebug(debug: JourneyOptions['debug']): Required<JourneyDebugOptions> | null {
  if (!debug) return null;
  const opts = typeof debug === 'boolean' ? {} : debug;
  return {
    screenshots: opts.screenshots !== false,
    on_error_only: opts.on_error_only === true,
    format: opts.format === 'png' ? 'png' : 'jpeg',
    quality: typeof opts.quality === 'number' ? Math.min(100, Math.max(1, opts.quality)) : 72,
  };
}

async function captureDebugShot(
  page: Page,
  opts: Required<JourneyDebugOptions>,
): Promise<JourneyStepDebug['screenshot'] | undefined> {
  if (!opts.screenshots) return undefined;
  try {
    const buffer = await page.screenshot({
      type: opts.format,
      quality: opts.format === 'jpeg' ? opts.quality : undefined,
      fullPage: false,
    });
    return {
      format: opts.format,
      base64: Buffer.from(buffer).toString('base64'),
    };
  } catch {
    return undefined;
  }
}

async function runVisibilityLite(page: Page, selector: string, scrollIntoView: boolean, ignoreSelectors: string[]) {
  return pageEvaluate(
    page,
    ({ selector: sel, scrollIntoView: scroll, ignoreSelectors: ignore }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return { exists: false, visible: false, not_covered: false, overall_pass: false };
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.05) {
        return { exists: true, visible: false, not_covered: false, overall_pass: false };
      }
      if (scroll && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        return { exists: true, visible: false, not_covered: false, overall_pass: false };
      }
      const ignoreList = ignore || [];
      const isIgnorable = (node: Element) => {
        if (node === document.documentElement || node === document.body) return true;
        if (node === el || el!.contains(node)) return true;
        for (const s of ignoreList) if (node.closest?.(s)) return true;
        const cs = window.getComputedStyle(node);
        if (cs.pointerEvents === 'none' || parseFloat(cs.opacity) < 0.02) return true;
        return false;
      };
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (typeof document.elementsFromPoint === 'function') {
        const stack = document.elementsFromPoint(cx, cy);
        for (const node of stack) {
          if (node === el || el!.contains(node)) break;
          if (isIgnorable(node)) continue;
          return { exists: true, visible: true, not_covered: false, overall_pass: false, overlap_detected_by: node.tagName.toLowerCase() };
        }
      }
      return { exists: true, visible: true, not_covered: true, overall_pass: true };
    },
    { selector, scrollIntoView, ignoreSelectors },
  );
}

function toInteractAction(step: Extract<JourneyStep, { type: 'interact' }>): InteractAction {
  switch (step.action) {
    case 'click':
      return { action: 'click', selector: step.selector! };
    case 'type':
      return { action: 'type', selector: step.selector!, text: step.text ?? '', clear: step.clear };
    case 'fill':
      return { action: 'fill', selector: step.selector!, text: step.text ?? '' };
    case 'scroll':
      return { action: 'scroll', selector: step.selector, y: step.y };
    case 'hover':
      return { action: 'hover', selector: step.selector! };
    case 'press_key':
      return { action: 'press_key', key: step.key ?? 'Enter', selector: step.selector };
    case 'select_option':
      return { action: 'select_option', selector: step.selector!, value: step.value ?? '' };
    case 'wait':
      return { action: 'wait', ms: step.ms ?? 0 };
    case 'wait_for_selector':
      return {
        action: 'wait_for_selector',
        selector: step.selector!,
        state: step.state,
        timeout_ms: step.timeout_ms,
      };
    default:
      throw new Error(`Unsupported interact action: ${step.action}`);
  }
}

export async function runJourney(options: JourneyOptions): Promise<JourneyResult> {
  const started = Date.now();
  const debugOpts = normalizeDebug(options.debug);
  const pageOpts: WithPageOptions = {
    runtime: options.runtime,
    width: options.width,
    height: options.height,
    userAgent: options.userAgent,
    extraHTTPHeaders: options.headers,
    cookies: options.cookies,
    javaScriptEnabled: options.javaScriptEnabled,
  };

  const mapCookies = (
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      httpOnly: boolean;
      secure: boolean;
      sameSite: string;
      expires: number;
    }>,
  ): ScoutCookie[] =>
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as ScoutCookie['sameSite'],
      expires: c.expires,
    }));

  try {
    return await withPageValue(pageOpts, async (page, session) => {
      const xhr = attachXhrCapture(page, options.captureXhr);
      let solvedSummary: { captcha_detected: boolean; captcha_solved: boolean } | undefined;
      const stepResults: JourneyStepResult[] = [];
      let screenshotCount = 0;
      let cookieSummary: CookieBannerResult | undefined;

      const maybeCookie = async () => {
        const result = await maybeDismissCookieBanner(page, options.dismissCookieBanner);
        if (result) {
          cookieSummary = {
            cookie_banner_detected:
              Boolean(cookieSummary?.cookie_banner_detected) || result.cookie_banner_detected,
            cookie_banner_dismissed:
              Boolean(cookieSummary?.cookie_banner_dismissed) || result.cookie_banner_dismissed,
            cookie_banner_vendor: result.cookie_banner_vendor || cookieSummary?.cookie_banner_vendor || null,
          };
        }
      };

      const attachDebug = async (result: JourneyStepResult, failed: boolean) => {
        if (!debugOpts) return result;
        const wantShot =
          debugOpts.screenshots && (!debugOpts.on_error_only || failed);
        const shot = wantShot ? await captureDebugShot(page, debugOpts) : undefined;
        if (shot) screenshotCount += 1;
        result.debug = {
          url: page.url(),
          ...(shot ? { screenshot: shot } : {}),
        };
        return result;
      };

      const debugMeta = () =>
        debugOpts
          ? ({
              enabled: true as const,
              screenshots: debugOpts.screenshots,
              on_error_only: debugOpts.on_error_only,
              screenshot_count: screenshotCount,
            } satisfies JourneyResult['debug'])
          : undefined;

      for (let i = 0; i < options.steps.length; i++) {
        const step = options.steps[i];
        try {
          let result: JourneyStepResult;
          if (step.type === 'navigate') {
            await page.goto(step.url, {
              waitUntil: step.wait_until ?? 'domcontentloaded',
              timeout: step.timeout_ms ?? 45_000,
            });
            await maybeCookie();
            if (options.solveCaptcha) {
              const solved = await maybeSolveCaptcha(page, true);
              if (solved) {
                solvedSummary = {
                  captcha_detected: solved.captcha_detected,
                  captcha_solved: Boolean(solvedSummary?.captcha_solved) || solved.captcha_solved,
                };
              }
            }
            result = { index: i, type: step.type, ok: true, data: { url: page.url() } };
          } else if (step.type === 'set_content') {
            await page.setContent(step.html, {
              waitUntil: step.wait_until ?? 'domcontentloaded',
              timeout: step.timeout_ms ?? 45_000,
            });
            await maybeCookie();
            result = { index: i, type: step.type, ok: true };
          } else if (step.type === 'interact') {
            await runInteractAction(page, toInteractAction(step));
            result = { index: i, type: step.type, ok: true, data: { action: step.action } };
          } else if (step.type === 'extract') {
            const extracted = await extractOnPage(page, step.fields);
            result = {
              index: i,
              type: step.type,
              ok: true,
              data: {
                ...extracted.data,
                ...(extracted.relocations.length ? { selector_relocations: extracted.relocations } : {}),
              },
            };
          } else if (step.type === 'visibility') {
            const data = await runVisibilityLite(
              page,
              step.selector,
              step.scroll_into_view !== false,
              step.ignore_selectors ?? [],
            );
            result = { index: i, type: step.type, ok: true, data };
          } else if (step.type === 'screenshot') {
            const format = step.format ?? 'jpeg';
            const buffer = await page.screenshot({
              type: format,
              quality: format === 'jpeg' ? (step.quality ?? 84) : undefined,
              fullPage: step.mode === 'fullpage',
            });
            result = {
              index: i,
              type: step.type,
              ok: true,
              data: {
                format,
                base64: Buffer.from(buffer).toString('base64'),
              },
            };
          } else if (step.type === 'evaluate') {
            if (!options.allowEvaluate) {
              result = await attachDebug(
                {
                  index: i,
                  type: step.type,
                  ok: false,
                  error: 'evaluate requires a Pro API key',
                },
                true,
              );
              stepResults.push(result);
              break;
            }
            const data = await page.evaluate(step.expression);
            result = { index: i, type: step.type, ok: true, data };
          } else if (step.type === 'wait_for_function') {
            await page.waitForFunction(step.expression, { timeout: step.timeout_ms ?? 15_000 });
            result = { index: i, type: step.type, ok: true };
          } else {
            result = { index: i, type: (step as { type: string }).type, ok: false, error: 'Unknown step type' };
          }

          stepResults.push(await attachDebug(result, !result.ok));
          if (!result.ok) break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const failed = await attachDebug(
            { index: i, type: step.type, ok: false, error: message.slice(0, 240) },
            true,
          );
          stepResults.push(failed);
          const cookies = await session.context.cookies();
          xhr.detach();
          return {
            status: 'error' as const,
            steps: stepResults,
            final_url: page.url(),
            cookies: mapCookies(cookies),
            response_time_ms: Date.now() - started,
            error: `Step ${i} (${step.type}) failed: ${message.slice(0, 200)}`,
            captured_xhr: options.captureXhr ? xhr.items() : undefined,
            captcha_detected: solvedSummary?.captcha_detected,
            captcha_solved: solvedSummary?.captcha_solved,
            fetch_mode: options.javaScriptEnabled === false ? ('http' as const) : ('browser' as const),
            ...(cookieSummary
              ? {
                  cookie_banner_detected: cookieSummary.cookie_banner_detected,
                  cookie_banner_dismissed: cookieSummary.cookie_banner_dismissed,
                  cookie_banner_vendor: cookieSummary.cookie_banner_vendor,
                }
              : {}),
            debug: debugMeta(),
          };
        }
      }

      const cookies = await session.context.cookies();
      const allOk = stepResults.every((s) => s.ok);
      xhr.detach();
      return {
        status: allOk ? ('success' as const) : ('error' as const),
        steps: stepResults,
        final_url: page.url(),
        cookies: mapCookies(cookies),
        response_time_ms: Date.now() - started,
        captured_xhr: options.captureXhr ? xhr.items() : undefined,
        captcha_detected: solvedSummary?.captcha_detected,
        captcha_solved: solvedSummary?.captcha_solved,
        fetch_mode: options.javaScriptEnabled === false ? ('http' as const) : ('browser' as const),
        ...(cookieSummary
          ? {
              cookie_banner_detected: cookieSummary.cookie_banner_detected,
              cookie_banner_dismissed: cookieSummary.cookie_banner_dismissed,
              cookie_banner_vendor: cookieSummary.cookie_banner_vendor,
            }
          : {}),
        debug: debugMeta(),
      };
    });
  } catch (err) {
    return {
      status: 'error',
      steps: [],
      final_url: '',
      cookies: [],
      response_time_ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
      debug: debugOpts
        ? {
            enabled: true,
            screenshots: debugOpts.screenshots,
            on_error_only: debugOpts.on_error_only,
            screenshot_count: 0,
          }
        : undefined,
    };
  }
}
