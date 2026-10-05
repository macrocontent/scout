import type { Page } from 'playwright';
import {
  DEFAULT_AD_TRACKER_PATTERNS,
  type ResourceType,
  withPage,
  withPageValue,
  type WithPageOptions,
} from '../browser/pool';
import { pageEvaluate, pageEvaluateNoArg } from '../browser/playwrightEvaluate';
import { deviceToPageOptions, resolveDevicePreset } from '../lib/devices';
import { ScoutError } from '../lib/errors';
import { maybeDismissCookieBanner, type CookieBannerResult } from '../lib/cookieBanner';
import { applyWaitForSelector } from '../lib/pageWait';
import { maybeSolveCaptcha, type SolveCaptchaResult } from '../lib/solveCaptcha';
import { comparePngScreenshots, type DiffRegion } from './diff';

export type ScreenshotMode = 'viewport' | 'fullpage';

export type ViewportSpec = {
  name?: string;
  width?: number;
  height?: number;
  /** Device preset name — overrides width/height when set. */
  device?: string;
};

export type ScreenshotOptions = {
  url: string;
  mode: ScreenshotMode;
  width: number;
  height: number;
  maxPageHeight?: number;
  waitMs?: number;
  format?: 'jpeg' | 'png' | 'pdf';
  quality?: number;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  locale?: string;
  userAgent?: string;
  extraHTTPHeaders?: Record<string, string>;
  blockResourceTypes?: ResourceType[];
  blockUrlPatterns?: string[];
  blockAds?: boolean;
  recordHar?: boolean;
  httpCredentials?: { username: string; password: string };
  clientCertificates?: WithPageOptions['clientCertificates'];
  runtime?: WithPageOptions['runtime'];
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  waitForSelector?: string;
  waitTimeoutMs?: number;
  waitForSelectorRequired?: boolean;
  detectCaptcha?: boolean;
  dismissCookieBanner?: boolean;
  solveCaptcha?: boolean;
};

async function preparePage(page: Page, waitAfterLoadMs: number, maxScrollHeight: number): Promise<void> {
  await page.waitForTimeout(waitAfterLoadMs);

  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(12_000, waitAfterLoadMs + 8_000) });
  } catch {
    // Many sites never reach networkidle.
  }

  try {
    await pageEvaluateNoArg(page, () => document.fonts.ready);
  } catch {
    // ignore
  }

  await pageEvaluate(page, async (maxH) => {
    const step = Math.max(window.innerHeight, 450);
    const total = Math.min(
      Math.max(
        document.body?.scrollHeight ?? 0,
        document.documentElement?.scrollHeight ?? 0,
      ),
      maxH,
    );
    let y = 0;
    while (y < total) {
      y = Math.min(y + step, total);
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 140));
    }
    window.scrollTo(0, 0);
  }, maxScrollHeight);

  await page.waitForTimeout(350);
}

async function readScrollHeight(page: Page): Promise<number> {
  return Number(
    await page.evaluate(
      `Math.max(
        document.body?.scrollHeight ?? 0,
        document.documentElement?.scrollHeight ?? 0,
        document.body?.offsetHeight ?? 0,
        document.documentElement?.offsetHeight ?? 0,
      )`,
    ),
  );
}

function pageOptsFromScreenshot(options: ScreenshotOptions): WithPageOptions {
  return {
    runtime: options.runtime,
    width: options.width,
    height: options.height,
    colorScheme: options.colorScheme,
    locale: options.locale,
    userAgent: options.userAgent,
    extraHTTPHeaders: options.extraHTTPHeaders,
    blockResourceTypes: options.blockResourceTypes,
    blockUrlPatterns: [
      ...(options.blockUrlPatterns ?? []),
      ...(options.blockAds ? DEFAULT_AD_TRACKER_PATTERNS : []),
    ],
    recordHar: options.recordHar,
    httpCredentials: options.httpCredentials,
    clientCertificates: options.clientCertificates,
    deviceScaleFactor: options.deviceScaleFactor,
    isMobile: options.isMobile,
    hasTouch: options.hasTouch,
  };
}

export async function captureScreenshot(options: ScreenshotOptions): Promise<{
  buffer: Buffer;
  captureHeight: number;
  contentType: 'image/jpeg' | 'image/png' | 'application/pdf';
  finalUrl: string;
  harBase64?: string;
  cookieBanner?: CookieBannerResult;
  captcha?: SolveCaptchaResult;
}> {
  const format = options.format ?? 'jpeg';
  const quality = options.quality ?? 84;
  const waitMs = Math.max(0, options.waitMs ?? 2_000);
  const maxPageHeight = options.maxPageHeight ?? 24_000;

  const { value, harBase64 } = await withPage(pageOptsFromScreenshot(options), async (page) => {
    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const cookieBanner = await maybeDismissCookieBanner(page, options.dismissCookieBanner);
    const captcha = await maybeSolveCaptcha(page, options.solveCaptcha);
    await applyWaitForSelector(page, {
      waitForSelector: options.waitForSelector,
      waitTimeoutMs: options.waitTimeoutMs,
      required: options.waitForSelectorRequired,
    });
    await preparePage(page, waitMs, maxPageHeight);

    if (format === 'pdf') {
      const buffer = Buffer.from(
        await page.pdf({
          printBackground: true,
          preferCSSPageSize: true,
        }),
      );
      return {
        buffer,
        captureHeight: options.height,
        contentType: 'application/pdf' as const,
        finalUrl: page.url(),
        cookieBanner,
        captcha,
      };
    }

    if (options.mode === 'viewport') {
      const buffer = Buffer.from(
        await page.screenshot({
          type: format,
          quality: format === 'jpeg' ? quality : undefined,
          fullPage: false,
        }),
      );
      return {
        buffer,
        captureHeight: options.height,
        contentType: (format === 'png' ? 'image/png' : 'image/jpeg') as 'image/png' | 'image/jpeg',
        finalUrl: page.url(),
        cookieBanner,
        captcha,
      };
    }

    const scrollHeight = await readScrollHeight(page);
    const captureHeight = Math.max(options.height, Math.min(scrollHeight, maxPageHeight));
    const buffer = Buffer.from(
      await page.screenshot({
        type: format,
        quality: format === 'jpeg' ? quality : undefined,
        fullPage: true,
        // clip handled below if needed — keep existing path
      }),
    );
    return {
      buffer,
      captureHeight,
      contentType: (format === 'png' ? 'image/png' : 'image/jpeg') as 'image/png' | 'image/jpeg',
      finalUrl: page.url(),
      cookieBanner,
      captcha,
    };
  });

  return { ...value, harBase64: harBase64 ?? undefined };
}

/**
 * Capture screenshots for multiple viewports in one browser session.
 */
export async function captureMultiViewport(options: {
  url: string;
  viewports: ViewportSpec[];
  mode?: ScreenshotMode;
  format?: 'jpeg' | 'png';
  quality?: number;
  waitMs?: number;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  locale?: string;
  blockAds?: boolean;
  blockResourceTypes?: ResourceType[];
  runtime?: WithPageOptions['runtime'];
}): Promise<{
  finalUrl: string;
  shots: Array<{
    name: string;
    width: number;
    height: number;
    content_type: string;
    base64: string;
  }>;
}> {
  const format = options.format ?? 'png';
  const quality = options.quality ?? 84;
  const waitMs = Math.max(0, options.waitMs ?? 1_500);
  const viewports = options.viewports.slice(0, 8);

  const shots: Array<{
    name: string;
    width: number;
    height: number;
    device?: string;
    content_type: string;
    base64: string;
  }> = [];
  let finalUrl = options.url;

  for (const vp of viewports) {
    const device = vp.device ? resolveDevicePreset(vp.device) : null;
    if (vp.device && !device) {
      throw new ScoutError('VALIDATION_FAILED', `Unknown device preset: ${vp.device}`);
    }
    const pageOpts = device
      ? deviceToPageOptions(device)
      : {
          width: vp.width ?? 1280,
          height: vp.height ?? 800,
        };

    const shot = await withPageValue(
      {
        ...pageOpts,
        runtime: options.runtime,
        colorScheme: options.colorScheme,
        locale: options.locale,
        blockResourceTypes: options.blockResourceTypes,
        blockUrlPatterns: options.blockAds ? DEFAULT_AD_TRACKER_PATTERNS : undefined,
      },
      async (page) => {
        await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await preparePage(page, waitMs, 24_000);
        const buffer = Buffer.from(
          await page.screenshot({
            type: format,
            quality: format === 'jpeg' ? quality : undefined,
            fullPage: (options.mode ?? 'viewport') === 'fullpage',
          }),
        );
        return {
          finalUrl: page.url(),
          width: pageOpts.width ?? 1280,
          height: pageOpts.height ?? 800,
          buffer,
        };
      },
    );

    finalUrl = shot.finalUrl;
    shots.push({
      name: vp.name || device?.name || `${shot.width}x${shot.height}`,
      width: shot.width,
      height: shot.height,
      device: vp.device,
      content_type: format === 'png' ? 'image/png' : 'image/jpeg',
      base64: shot.buffer.toString('base64'),
    });
  }

  return { finalUrl, shots };
}

export async function captureAndDiff(options: ScreenshotOptions & {
  referencePngBase64: string;
  tolerance?: number;
  region?: DiffRegion;
  includeDiffImage?: boolean;
}) {
  const shot = await captureScreenshot({
    ...options,
    format: 'png',
  });
  const referencePng = Buffer.from(options.referencePngBase64, 'base64');
  const diff = comparePngScreenshots({
    referencePng,
    currentPng: shot.buffer,
    tolerance: options.tolerance,
    region: options.region,
    includeDiffImage: options.includeDiffImage,
  });
  return {
    final_url: shot.finalUrl,
    capture_height: shot.captureHeight,
    current_png_base64: shot.buffer.toString('base64'),
    diff,
  };
}
