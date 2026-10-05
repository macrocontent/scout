import type { Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { browserAcquireTimeoutMs, getBrowserConcurrencyGate } from './concurrency';
import {
  applyStealthDefaults,
  buildStealthInitScript,
  chromeMajorFromBrowserVersion,
  getStealthLaunchOptions,
  getStealthRuntimeStatus,
  stealthRuntimeEnabledFromEnv,
} from './stealth';

let playwrightPromise: Promise<typeof import('playwright')> | null = null;
export type BrowserRuntime = 'chromium' | 'stealth';
const browserPromises: Partial<Record<BrowserRuntime, Promise<Browser>>> = {};

function stealthRuntimeEnabled(): boolean {
  return stealthRuntimeEnabledFromEnv();
}

export { getStealthRuntimeStatus };

async function loadPlaywright() {
  if (!playwrightPromise) playwrightPromise = import('playwright');
  return playwrightPromise;
}

async function getBrowser(runtime: BrowserRuntime): Promise<Browser> {
  if (runtime === 'stealth' && !stealthRuntimeEnabled()) {
    throw new Error('Stealth runtime is disabled. Set SCOUT_STEALTH_RUNTIME_ENABLED=true');
  }
  if (!browserPromises[runtime]) {
    browserPromises[runtime] = (async () => {
      const { chromium } = await loadPlaywright();
      const baseArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
      if (runtime !== 'stealth') {
        return chromium.launch({ headless: true, args: baseArgs });
      }
      const stealthLaunch = getStealthLaunchOptions(baseArgs);
      try {
        return await chromium.launch({
          headless: true,
          channel: stealthLaunch.channel,
          ignoreDefaultArgs: stealthLaunch.ignoreDefaultArgs,
          args: stealthLaunch.args,
        });
      } catch {
        // Bundled Chromium without channel alias (some local installs).
        return chromium.launch({
          headless: true,
          ignoreDefaultArgs: stealthLaunch.ignoreDefaultArgs,
          args: stealthLaunch.args,
        });
      }
    })();
  }
  try {
    const browser = await browserPromises[runtime]!;
    if (!browser.isConnected()) {
      browserPromises[runtime] = undefined;
      return getBrowser(runtime);
    }
    return browser;
  } catch (err) {
    browserPromises[runtime] = undefined;
    throw err;
  }
}

export type ScoutCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
};

export type ResourceType =
  | 'document'
  | 'stylesheet'
  | 'image'
  | 'media'
  | 'font'
  | 'script'
  | 'texttrack'
  | 'xhr'
  | 'fetch'
  | 'eventsource'
  | 'websocket'
  | 'manifest'
  | 'other';

export type WithPageOptions = {
  runtime?: BrowserRuntime;
  width?: number;
  height?: number;
  userAgent?: string;
  locale?: string;
  extraHTTPHeaders?: Record<string, string>;
  cookies?: ScoutCookie[];
  colorScheme?: 'light' | 'dark' | 'no-preference';
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  /** HTTP Basic Auth (verified domains only — enforced at route layer). */
  httpCredentials?: { username: string; password: string };
  /** Client certificates for mTLS (verified domains only). Paths written to temp files. */
  clientCertificates?: Array<{
    origin: string;
    cert: Buffer | string;
    key: Buffer | string;
    passphrase?: string;
  }>;
  /** Mocked network resources: exact URL → body */
  resources?: Array<{ url: string; body: string | Buffer; contentType?: string; status?: number }>;
  /** Abort all requests not matching resources / about:blank / data: */
  blockExternal?: boolean;
  /** Abort these Playwright resource types (e.g. image, font, media). */
  blockResourceTypes?: ResourceType[];
  /** Abort URLs matching these substrings (ads/trackers). */
  blockUrlPatterns?: string[];
  /** Record HAR to a temp file; returned via session.harPath */
  recordHar?: boolean;
  /** Static fetch — no JS. Used for browse `fetch_mode: http`. */
  javaScriptEnabled?: boolean;
};

export type PageSession = {
  page: Page;
  context: BrowserContext;
  harPath: string | null;
};

export type WithPageResult<T> = {
  value: T;
  /** HAR base64 when recordHar was requested (written after context close). */
  harBase64: string | null;
};

/**
 * Run page work with up to N concurrent browser jobs (license / SCOUT_WORKER_COUNT).
 */
export async function withPage<T>(
  options: WithPageOptions,
  fn: (page: Page, session: PageSession) => Promise<T>,
): Promise<WithPageResult<T>> {
  const gate = getBrowserConcurrencyGate();
  await gate.acquire(browserAcquireTimeoutMs());
  let context: BrowserContext | null = null;
  let harPath: string | null = null;
  const tempFiles: string[] = [];
  let harBase64: string | null = null;
  try {
    const runtime = options.runtime ?? 'chromium';
    const browser = await getBrowser(runtime);
    try {
      if (options.recordHar) {
        harPath = path.join(os.tmpdir(), `scout-har-${randomBytes(8).toString('hex')}.har`);
      }

      let userAgent = options.userAgent;
      let locale = options.locale;
      let extraHTTPHeaders = options.extraHTTPHeaders;
      if (runtime === 'stealth') {
        const stealth = applyStealthDefaults({
          userAgent,
          locale,
          extraHTTPHeaders,
          chromeMajor: chromeMajorFromBrowserVersion(browser.version()),
        });
        userAgent = stealth.userAgent;
        locale = stealth.locale;
        extraHTTPHeaders = stealth.extraHTTPHeaders;
      }

      const clientCertificates = options.clientCertificates?.map((c) => {
        const certPath = path.join(os.tmpdir(), `scout-cert-${randomBytes(6).toString('hex')}.pem`);
        const keyPath = path.join(os.tmpdir(), `scout-key-${randomBytes(6).toString('hex')}.pem`);
        fs.writeFileSync(certPath, typeof c.cert === 'string' ? c.cert : c.cert);
        fs.writeFileSync(keyPath, typeof c.key === 'string' ? c.key : c.key);
        tempFiles.push(certPath, keyPath);
        return {
          origin: c.origin,
          certPath,
          keyPath,
          passphrase: c.passphrase,
        };
      });

      context = await browser.newContext({
        viewport: {
          width: options.width ?? 1280,
          height: options.height ?? 800,
        },
        deviceScaleFactor: options.deviceScaleFactor ?? 1,
        isMobile: options.isMobile ?? false,
        hasTouch: options.hasTouch ?? false,
        userAgent,
        locale,
        extraHTTPHeaders,
        colorScheme: options.colorScheme,
        javaScriptEnabled: options.javaScriptEnabled !== false,
        httpCredentials: options.httpCredentials,
        clientCertificates: clientCertificates as never,
        recordHar: harPath
          ? { path: harPath, mode: 'full', content: 'embed' }
          : undefined,
      });

      if (runtime === 'stealth') {
        await context.addInitScript(buildStealthInitScript());
      }

      if (options.cookies?.length) {
        const cookies = options.cookies
          .filter((c) => Boolean(c.url || c.domain))
          .map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path ?? '/',
            url: c.url,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
            expires: c.expires && c.expires > 0 ? c.expires : undefined,
          }));
        if (cookies.length) await context.addCookies(cookies as Parameters<BrowserContext['addCookies']>[0]);
      }

      const page = await context.newPage();

      const blockTypes = new Set(options.blockResourceTypes ?? []);
      const blockPatterns = (options.blockUrlPatterns ?? []).map((p) => p.toLowerCase());
      const needsRoute =
        Boolean(options.resources?.length)
        || Boolean(options.blockExternal)
        || blockTypes.size > 0
        || blockPatterns.length > 0;

      if (needsRoute) {
        const resourceMap = new Map(
          (options.resources ?? []).map((r) => [r.url, r] as const),
        );
        await page.route('**/*', async (route) => {
          const req = route.request();
          const url = req.url();
          const hit = resourceMap.get(url);
          if (hit) {
            await route.fulfill({
              status: hit.status ?? 200,
              contentType: hit.contentType ?? 'application/octet-stream',
              body: hit.body,
            });
            return;
          }
          if (
            url.startsWith('data:')
            || url.startsWith('about:')
            || url.startsWith('blob:')
          ) {
            await route.continue();
            return;
          }
          if (blockTypes.has(req.resourceType() as ResourceType)) {
            await route.abort('blockedbyclient');
            return;
          }
          const lower = url.toLowerCase();
          if (blockPatterns.some((p) => lower.includes(p))) {
            await route.abort('blockedbyclient');
            return;
          }
          if (options.blockExternal) {
            await route.abort('blockedbyclient');
            return;
          }
          await route.continue();
        });
      }

      const value = await fn(page, { page, context, harPath });
      await context.close().catch(() => undefined);
      context = null;
      if (harPath && fs.existsSync(harPath)) {
        try {
          harBase64 = fs.readFileSync(harPath).toString('base64');
          fs.unlinkSync(harPath);
        } catch {
          // ignore
        }
      }
      for (const f of tempFiles) {
        try {
          fs.unlinkSync(f);
        } catch {
          // ignore
        }
      }
      return { value, harBase64 };
    } finally {
      await context?.close().catch(() => undefined);
      if (harPath) {
        try {
          if (fs.existsSync(harPath)) fs.unlinkSync(harPath);
        } catch {
          // ignore
        }
      }
      for (const f of tempFiles) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {
          // ignore
        }
      }
    }
  } finally {
    gate.release();
  }
}

/** Convenience wrapper when HAR is not needed. */
export async function withPageValue<T>(
  options: WithPageOptions,
  fn: (page: Page, session: PageSession) => Promise<T>,
): Promise<T> {
  const { value } = await withPage(options, fn);
  return value;
}

export function formatBrowserInfrastructureError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Stealth runtime is disabled')) {
    return 'Scout stealth runtime is disabled on this deployment. Enable SCOUT_STEALTH_RUNTIME_ENABLED=true.';
  }
  if (
    message.includes("Executable doesn't exist")
    || message.includes('browserType.launch')
    || message.includes('chrome-headless-shell')
  ) {
    return 'Scout browser unavailable (Playwright Chromium not installed). Run: pnpm --filter macro-scout browser:install';
  }
  return message.slice(0, 240);
}

/** Common ad/tracker URL substrings for optional block_ads preset. */
export const DEFAULT_AD_TRACKER_PATTERNS = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.net',
  'hotjar.com',
  'segment.com',
  'mixpanel.com',
  'adservice.google',
  'pagead2.googlesyndication',
];
