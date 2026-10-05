import { z } from 'zod';
import type { WithPageOptions } from '../browser/pool';
import { scoutConfig } from '../config';
import { assertUrlHostVerified } from '../domains/store';
import { deviceToPageOptions, listDevicePresetNames, resolveDevicePreset } from './devices';
import { ScoutError } from './errors';
import { assertRobotsAllowed } from './robots';

export const ResourceTypeSchema = z.enum([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
]);

export const BrowseOptionsSchema = z.object({
  respect_robots: z.boolean().optional(),
  color_scheme: z.enum(['light', 'dark', 'no-preference']).optional(),
  locale: z.string().min(2).max(32).optional(),
  user_agent: z.string().max(400).optional(),
  headers: z.record(z.string()).optional(),
  block_resource_types: z.array(ResourceTypeSchema).max(20).optional(),
  block_url_patterns: z.array(z.string().min(1).max(200)).max(50).optional(),
  block_ads: z.boolean().optional(),
  record_har: z.boolean().optional(),
  /** Wait until CSS selector is attached after navigation. */
  wait_for_selector: z.string().min(1).max(500).optional(),
  wait_for_selector_timeout_ms: z.number().int().min(100).max(120_000).optional(),
  /** If false, missing wait_for_selector does not fail the request (default true). */
  wait_for_selector_required: z.boolean().optional(),
  /**
   * Best-effort dismiss of known cookie CMP banners (fixed allowlist — not free interact).
   * Allowed without domain verify. Returns cookie_banner_* fields on JSON responses.
   */
  dismiss_cookie_banner: z.boolean().optional(),
  /** Playwright-style device preset name (overrides width/height/UA/DPR/touch when set). */
  device: z.string().min(1).max(80).optional(),
  detect_captcha: z.boolean().optional(),
  /**
   * Best-effort Turnstile/checkbox handling. Requires verified domain (cloud)
   * or self-hosted (verify always off). Never runs on unverified third-party URLs.
   */
  solve_captcha: z.boolean().optional(),
  /**
   * Run request in the dedicated stealth browser runtime.
   * Cloud requires verified domain + Basic/Pro/Internal tier.
   */
  stealth: z.boolean().optional(),
  /** Capture XHR/fetch bodies whose URL matches a glob or substring (example: /api/pricing). */
  capture_xhr: z.string().min(1).max(500).optional(),
  /** browser (default) runs JS. http disables JavaScript for a static document. */
  fetch_mode: z.enum(['browser', 'http']).optional(),
  /** Basic Auth — requires verified domain (or internal key). */
  http_auth: z
    .object({
      username: z.string().min(1),
      password: z.string(),
    })
    .optional(),
  /** mTLS client cert (PEM strings) — requires verified domain. */
  client_certificates: z
    .array(
      z.object({
        origin: z.string().min(1),
        cert: z.string().min(1),
        key: z.string().min(1),
        passphrase: z.string().optional(),
      }),
    )
    .max(5)
    .optional(),
  encoding: z.string().max(40).optional(),
  accept_language: z.string().max(120).optional(),
});

export type BrowseOptions = z.infer<typeof BrowseOptionsSchema>;

export function mergeBrowseHeaders(opts: BrowseOptions): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.accept_language) headers['Accept-Language'] = opts.accept_language;
  if (opts.encoding) headers['Accept-Charset'] = opts.encoding;
  return Object.keys(headers).length ? headers : undefined;
}

export function toPageBrowseOptions(opts: BrowseOptions): Partial<WithPageOptions> {
  const device = resolveDevicePreset(opts.device);
  if (opts.device && !device) {
    throw new ScoutError(
      'VALIDATION_FAILED',
      `Unknown device preset: ${opts.device}. Use GET /v1/devices`,
      { details: { available: listDevicePresetNames() } },
    );
  }

  const fromDevice = device ? deviceToPageOptions(device) : ({} as Partial<WithPageOptions>);

  return {
    ...fromDevice,
    colorScheme: opts.color_scheme,
    locale: opts.locale,
    userAgent: opts.user_agent || fromDevice.userAgent,
    extraHTTPHeaders: mergeBrowseHeaders(opts),
    blockResourceTypes: opts.block_resource_types,
    blockUrlPatterns: opts.block_url_patterns,
    recordHar: opts.record_har,
    httpCredentials: opts.http_auth,
    clientCertificates: opts.client_certificates,
    javaScriptEnabled: opts.fetch_mode !== 'http',
    runtime: opts.stealth ? 'stealth' : 'chromium',
  };
}

export function browseWaitOptions(opts: BrowseOptions) {
  return {
    waitForSelector: opts.wait_for_selector,
    waitTimeoutMs: opts.wait_for_selector_timeout_ms,
    required: opts.wait_for_selector_required,
  };
}

export function browseCaptureFlags(opts: BrowseOptions) {
  return {
    captureXhr: opts.capture_xhr,
    solveCaptcha: opts.solve_captcha,
    javaScriptEnabled: opts.fetch_mode !== 'http',
  };
}

export function browseRuntimeMeta(opts: Pick<BrowseOptions, 'stealth'>) {
  return { browser_runtime: opts.stealth ? ('stealth' as const) : ('chromium' as const) };
}

/**
 * Assert robots + require domain verify when using Basic Auth / mTLS / captcha solve.
 */
export async function prepareBrowseAccess(options: {
  url: string;
  apiKey: string;
  tier?: string;
  browse?: BrowseOptions;
  verifiedHostnames?: string[];
}): Promise<{ robots: Awaited<ReturnType<typeof assertRobotsAllowed>> }> {
  const browse = options.browse ?? {};
  if (browse.device && !resolveDevicePreset(browse.device)) {
    throw new ScoutError(
      'VALIDATION_FAILED',
      `Unknown device preset: ${browse.device}. Use GET /v1/devices`,
      { details: { available: listDevicePresetNames() } },
    );
  }
  const needsAuth = Boolean(
    browse.http_auth
    || browse.client_certificates?.length
    || browse.solve_captcha
    || browse.stealth,
  );
  if (browse.stealth && scoutConfig.deploymentMode !== 'self_hosted') {
    const tier = (options.tier ?? '').toLowerCase();
    const tierAllowed = tier === 'internal' || tier === 'basic' || tier === 'pro';
    if (!tierAllowed) {
      throw new ScoutError(
        'STEALTH_TIER_NOT_ALLOWED',
        'stealth requires Basic, Pro, or Internal API key tier',
        { status: 403 },
      );
    }
  }
  if (needsAuth) {
    const check = assertUrlHostVerified(
      options.apiKey,
      options.tier,
      options.url,
      options.verifiedHostnames,
    );
    if (!check.ok) {
      const expired = check.error.includes('expired');
      throw new ScoutError(expired ? 'DOMAIN_VERIFY_EXPIRED' : 'DOMAIN_NOT_VERIFIED', check.error, {
        status: 403,
        details: check.hostname ? { hostname: check.hostname } : undefined,
      });
    }
  }
  try {
    const robots = await assertRobotsAllowed(options.url, browse.respect_robots);
    return { robots };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ScoutError('ROBOTS_BLOCKED', message, { status: 400 });
  }
}
