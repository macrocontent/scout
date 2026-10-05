import type { Page } from 'playwright';
import {
  DEFAULT_AD_TRACKER_PATTERNS,
  type ResourceType,
  withPageValue,
  type WithPageOptions,
} from '../browser/pool';
import { pageEvaluate } from '../browser/playwrightEvaluate';
import { detectCaptcha } from '../lib/captcha';
import { maybeDismissCookieBanner } from '../lib/cookieBanner';
import { applyWaitForSelector } from '../lib/pageWait';
import { maybeSolveCaptcha } from '../lib/solveCaptcha';
import { attachXhrCapture } from '../lib/xhrCapture';
import { buildSecurityReport } from './security';
import { runA11yChecks } from './a11y';
import { detectTechStack } from './techstack';
import { collectFileLinks } from './files';

export type InspectInclude =
  | 'meta'
  | 'headings'
  | 'links'
  | 'images'
  | 'json_ld'
  | 'headers'
  | 'security'
  | 'tech'
  | 'files'
  | 'a11y';

export type InspectOptions = {
  url: string;
  include?: InspectInclude[];
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
  detectCaptcha?: boolean;
  dismissCookieBanner?: boolean;
  solveCaptcha?: boolean;
  captureXhr?: string;
  javaScriptEnabled?: boolean;
  runtime?: WithPageOptions['runtime'];
};

export async function inspectPage(options: InspectOptions) {
  const started = Date.now();
  const include = new Set<InspectInclude>(
    options.include?.length
      ? options.include
      : ['meta', 'headings', 'links', 'images', 'json_ld'],
  );

  const blockPatterns = [
    ...(options.blockUrlPatterns ?? []),
    ...(options.blockAds ? DEFAULT_AD_TRACKER_PATTERNS : []),
  ];

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
      javaScriptEnabled: options.javaScriptEnabled,
      runtime: options.runtime,
    },
    async (page) => {
      const xhr = attachXhrCapture(page, options.captureXhr);
      const response = await page.goto(options.url, {
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

      let captcha: { captcha_detected: boolean; signals: Array<{ id: string; evidence: string }>; captcha_solved?: boolean } | undefined;
      if (solved) {
        captcha = {
          captcha_detected: solved.captcha_detected,
          signals: solved.captcha_signals,
          captcha_solved: solved.captcha_solved,
        };
      } else if (options.detectCaptcha !== false) {
        captcha = await detectCaptcha(page);
      }

      const httpHeaders = response?.headers() ?? {};
      const httpStatus = response?.status() ?? null;

      const data = await pageEvaluate(page, (inc) => {
        const out: Record<string, unknown> = {};

        if (inc.includes('meta')) {
          const getMeta = (sel: string) => document.querySelector(sel)?.getAttribute('content') ?? null;
          out.meta = {
            title: document.title || null,
            description: getMeta('meta[name="description"]'),
            robots: getMeta('meta[name="robots"]'),
            canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
            og_title: getMeta('meta[property="og:title"]'),
            og_description: getMeta('meta[property="og:description"]'),
            og_image: getMeta('meta[property="og:image"]'),
            twitter_card: getMeta('meta[name="twitter:card"]'),
            twitter_title: getMeta('meta[name="twitter:title"]'),
            lang: document.documentElement.getAttribute('lang'),
          };
        }

        if (inc.includes('headings')) {
          const headings: Array<{ level: number; text: string }> = [];
          for (let level = 1; level <= 6; level++) {
            document.querySelectorAll(`h${level}`).forEach((el) => {
              headings.push({ level, text: (el.textContent || '').trim() });
            });
          }
          out.headings = headings;
          out.h1_count = headings.filter((h) => h.level === 1).length;
        }

        if (inc.includes('links')) {
          const origin = location.origin;
          out.links = Array.from(document.querySelectorAll('a[href]')).map((a) => {
            const href = a.getAttribute('href') || '';
            let absolute = href;
            try {
              absolute = new URL(href, location.href).toString();
            } catch {
              // keep raw
            }
            return {
              href: absolute,
              text: (a.textContent || '').trim().slice(0, 200),
              rel: a.getAttribute('rel'),
              internal: absolute.startsWith(origin),
            };
          });
        }

        if (inc.includes('images')) {
          out.images = Array.from(document.querySelectorAll('img')).map((img) => ({
            src: img.currentSrc || img.getAttribute('src'),
            alt: img.getAttribute('alt'),
            width: img.naturalWidth || null,
            height: img.naturalHeight || null,
            missing_alt: !img.getAttribute('alt'),
          }));
          out.images_missing_alt_count = (out.images as Array<{ missing_alt: boolean }>).filter(
            (i) => i.missing_alt,
          ).length;
        }

        if (inc.includes('json_ld')) {
          out.json_ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(
            (el) => {
              const raw = el.textContent || '';
              try {
                return JSON.parse(raw);
              } catch {
                return { raw: raw.slice(0, 2000), parse_error: true };
              }
            },
          );
        }

        return out;
      }, Array.from(include));

      if (include.has('security')) {
        data.security = await buildSecurityReport(page, response, options.url);
      }
      if (include.has('tech')) {
        data.tech = await detectTechStack(page);
      }
      if (include.has('files')) {
        data.files = await collectFileLinks(page);
      }
      if (include.has('a11y')) {
        data.a11y = await runA11yChecks(page);
      }

      xhr.detach();
      return {
        status: 'success' as const,
        url: options.url,
        final_url: page.url(),
        http_status: httpStatus,
        response_headers: include.has('headers') ? httpHeaders : undefined,
        data,
        captcha_detected: captcha?.captcha_detected,
        captcha_solved: captcha?.captcha_solved,
        captcha_signals: captcha?.signals,
        captured_xhr: options.captureXhr ? xhr.items() : undefined,
        fetch_mode: options.javaScriptEnabled === false ? ('http' as const) : ('browser' as const),
        ...(cookie
          ? {
              cookie_banner_detected: cookie.cookie_banner_detected,
              cookie_banner_dismissed: cookie.cookie_banner_dismissed,
              cookie_banner_vendor: cookie.cookie_banner_vendor,
            }
          : {}),
        response_time_ms: Date.now() - started,
        timestamp: new Date().toISOString(),
      };
    },
  );
}

/** Convenience for security-only endpoint */
export async function inspectSecurity(url: string, pageOpts?: Partial<InspectOptions>) {
  return inspectPage({
    url,
    include: ['security', 'headers'],
    ...pageOpts,
  });
}
