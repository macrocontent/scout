import { Router } from 'express';
import { z } from 'zod';
import type { ScoutAuthRequest } from '../auth/middleware';
import {
  BrowseOptionsSchema,
  browseCaptureFlags,
  prepareBrowseAccess,
  toPageBrowseOptions,
} from '../lib/browseOptions';
import { sendScoutError } from '../lib/errors';
import { assertPublicHttpUrl } from '../lib/networkGuard';
import { checkRobotsTxt } from '../lib/robots';
import { extractPdfTextFromUrl } from '../primitives/files';
import { inspectPage } from '../primitives/inspect';
import {
  captureAndDiff,
  captureMultiViewport,
  captureScreenshot,
} from '../primitives/screenshot';
import { getUsageForKey } from '../usage/store';
import { estimateCreditsDetailed } from '../credits/costs';

export const v1ExtraRouter = Router();

const UrlBrowseBody = z
  .object({
    url: z.string().min(1),
    settle_ms: z.number().int().min(0).max(30_000).optional(),
    goto_timeout_ms: z.number().int().optional(),
    width: z.number().int().min(200).max(3840).optional(),
    height: z.number().int().min(200).max(2160).optional(),
  })
  .merge(BrowseOptionsSchema);

v1ExtraRouter.get('/usage', (req: ScoutAuthRequest, res) => {
  const key = req.scoutKey?.key;
  if (!key) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }
  const usage = getUsageForKey(key);
  res.json({
    status: 'success',
    usage: usage ?? {
      total_requests: 0,
      by_route: {},
      updated_at: null,
    },
    note: 'Operational counters only — credit history lives in the Scout console Usage page.',
  });
});

v1ExtraRouter.post('/estimate', (req: ScoutAuthRequest, res) => {
  const parsed = z
    .object({
      method: z.string().min(1).default('POST'),
      path: z.string().min(1),
      body: z.unknown().optional(),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const path = parsed.data.path.startsWith('/') ? parsed.data.path : `/${parsed.data.path}`;
  const estimate = estimateCreditsDetailed(parsed.data.method, path, parsed.data.body);
  res.json({
    status: 'success',
    ...estimate,
    note: 'Estimate from request shape only. Extra credits apply for selected options and timeouts above the included runtime. Scout failures are not billed as add-ons.',
  });
});

v1ExtraRouter.post('/robots', async (req: ScoutAuthRequest, res) => {
  const parsed = z
    .object({
      url: z.string().min(1),
      respect_robots: z.boolean().optional(),
      user_agent: z.string().optional(),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const url = await assertPublicHttpUrl(parsed.data.url);
    const decision = await checkRobotsTxt(url, {
      respect: parsed.data.respect_robots,
      userAgent: parsed.data.user_agent,
    });
    res.json({ status: 'success', url, ...decision, timestamp: new Date().toISOString() });
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1ExtraRouter.post('/checks/security', async (req: ScoutAuthRequest, res) => {
  const parsed = UrlBrowseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const url = await assertPublicHttpUrl(parsed.data.url);
    await prepareBrowseAccess({
      url,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: parsed.data,
    });
    const browse = toPageBrowseOptions(parsed.data);
    const result = await inspectPage({
      url,
      include: ['security', 'headers'],
      settleMs: parsed.data.settle_ms,
      gotoTimeoutMs: parsed.data.goto_timeout_ms,
      width: parsed.data.width,
      height: parsed.data.height,
      colorScheme: browse.colorScheme,
      locale: browse.locale,
      userAgent: browse.userAgent,
      extraHTTPHeaders: browse.extraHTTPHeaders,
      blockResourceTypes: browse.blockResourceTypes,
      blockUrlPatterns: [
        ...(browse.blockUrlPatterns ?? []),
        ...(parsed.data.block_ads ? [] : []),
      ],
      blockAds: parsed.data.block_ads,
      httpCredentials: browse.httpCredentials,
      clientCertificates: browse.clientCertificates,
      dismissCookieBanner: parsed.data.dismiss_cookie_banner,
      runtime: browse.runtime,
      ...browseCaptureFlags(parsed.data),
    });
    res.json(result);
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1ExtraRouter.post('/checks/a11y', async (req: ScoutAuthRequest, res) => {
  const parsed = UrlBrowseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const url = await assertPublicHttpUrl(parsed.data.url);
    await prepareBrowseAccess({
      url,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: parsed.data,
    });
    const browse = toPageBrowseOptions(parsed.data);
    const result = await inspectPage({
      url,
      include: ['a11y'],
      settleMs: parsed.data.settle_ms,
      gotoTimeoutMs: parsed.data.goto_timeout_ms,
      width: parsed.data.width,
      height: parsed.data.height,
      ...browse,
      blockAds: parsed.data.block_ads,
      dismissCookieBanner: parsed.data.dismiss_cookie_banner,
      ...browseCaptureFlags(parsed.data),
    });
    res.json(result);
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1ExtraRouter.post('/checks/tech', async (req: ScoutAuthRequest, res) => {
  const parsed = UrlBrowseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const url = await assertPublicHttpUrl(parsed.data.url);
    await prepareBrowseAccess({
      url,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: parsed.data,
    });
    const browse = toPageBrowseOptions(parsed.data);
    const result = await inspectPage({
      url,
      include: ['tech'],
      settleMs: parsed.data.settle_ms,
      ...browse,
      blockAds: parsed.data.block_ads,
      width: parsed.data.width,
      height: parsed.data.height,
      dismissCookieBanner: parsed.data.dismiss_cookie_banner,
      ...browseCaptureFlags(parsed.data),
    });
    res.json(result);
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1ExtraRouter.post('/files', async (req: ScoutAuthRequest, res) => {
  const parsed = UrlBrowseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const url = await assertPublicHttpUrl(parsed.data.url);
    await prepareBrowseAccess({
      url,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: parsed.data,
    });
    const browse = toPageBrowseOptions(parsed.data);
    const result = await inspectPage({
      url,
      include: ['files'],
      settleMs: parsed.data.settle_ms,
      ...browse,
      blockAds: parsed.data.block_ads,
      width: parsed.data.width,
      height: parsed.data.height,
      dismissCookieBanner: parsed.data.dismiss_cookie_banner,
      ...browseCaptureFlags(parsed.data),
    });
    res.json(result);
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1ExtraRouter.post('/pdf/extract', async (req: ScoutAuthRequest, res) => {
  const parsed = z
    .object({
      url: z.string().min(1),
      max_pages: z.number().int().min(1).max(100).optional(),
      respect_robots: z.boolean().optional(),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const url = await assertPublicHttpUrl(parsed.data.url);
    await prepareBrowseAccess({
      url,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: { respect_robots: parsed.data.respect_robots },
    });
    const result = await extractPdfTextFromUrl(url, parsed.data.max_pages ?? 20);
    res.json({ status: result.error && !result.text ? 'error' : 'success', ...result, timestamp: new Date().toISOString() });
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1ExtraRouter.post('/screenshot/viewports', async (req: ScoutAuthRequest, res) => {
  const parsed = z
    .object({
      url: z.string().min(1),
      viewports: z
        .array(
          z.object({
            name: z.string().optional(),
            width: z.number().int().min(200).max(3840).optional(),
            height: z.number().int().min(200).max(2160).optional(),
            device: z.string().min(1).max(80).optional(),
          }).refine((v) => Boolean(v.device || (v.width && v.height)), {
            message: 'Each viewport needs device or width+height',
          }),
        )
        .min(1)
        .max(8),
      mode: z.enum(['viewport', 'fullpage']).optional(),
      format: z.enum(['jpeg', 'png']).optional(),
      quality: z.number().int().min(1).max(100).optional(),
      wait_ms: z.number().int().min(0).max(30_000).optional(),
      color_scheme: z.enum(['light', 'dark', 'no-preference']).optional(),
      locale: z.string().optional(),
      block_ads: z.boolean().optional(),
      respect_robots: z.boolean().optional(),
      stealth: z.boolean().optional(),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const url = await assertPublicHttpUrl(parsed.data.url);
    await prepareBrowseAccess({
      url,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: {
        respect_robots: parsed.data.respect_robots,
        color_scheme: parsed.data.color_scheme,
        locale: parsed.data.locale,
        block_ads: parsed.data.block_ads,
        stealth: parsed.data.stealth,
      },
    });
    const result = await captureMultiViewport({
      url,
      viewports: parsed.data.viewports,
      mode: parsed.data.mode,
      format: parsed.data.format,
      quality: parsed.data.quality,
      waitMs: parsed.data.wait_ms,
      colorScheme: parsed.data.color_scheme,
      locale: parsed.data.locale,
      blockAds: parsed.data.block_ads,
      runtime: parsed.data.stealth ? 'stealth' : 'chromium',
    });
    res.json({
      status: 'success',
      url,
      final_url: result.finalUrl,
      shots: result.shots,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1ExtraRouter.post('/screenshot/diff', async (req: ScoutAuthRequest, res) => {
  const parsed = z
    .object({
      url: z.string().min(1),
      reference_png_base64: z.string().min(1),
      tolerance: z.number().min(0).max(1).optional(),
      region: z
        .object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          width: z.number().int().min(1),
          height: z.number().int().min(1),
        })
        .optional(),
      include_diff_image: z.boolean().optional(),
      mode: z.enum(['viewport', 'fullpage']).default('viewport'),
      width: z.number().int().min(200).max(3840).default(1280),
      height: z.number().int().min(200).max(2160).default(800),
      wait_ms: z.number().int().optional(),
      color_scheme: z.enum(['light', 'dark', 'no-preference']).optional(),
      respect_robots: z.boolean().optional(),
      stealth: z.boolean().optional(),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const url = await assertPublicHttpUrl(parsed.data.url);
    await prepareBrowseAccess({
      url,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: {
        respect_robots: parsed.data.respect_robots,
        color_scheme: parsed.data.color_scheme,
        stealth: parsed.data.stealth,
      },
    });
    const result = await captureAndDiff({
      url,
      mode: parsed.data.mode,
      width: parsed.data.width,
      height: parsed.data.height,
      waitMs: parsed.data.wait_ms,
      colorScheme: parsed.data.color_scheme,
      runtime: parsed.data.stealth ? 'stealth' : 'chromium',
      referencePngBase64: parsed.data.reference_png_base64,
      tolerance: parsed.data.tolerance,
      region: parsed.data.region,
      includeDiffImage: parsed.data.include_diff_image,
    });
    res.json({ status: 'success', url, ...result, timestamp: new Date().toISOString() });
  } catch (err) {
    sendScoutError(res, err);
  }
});

/** Screenshot with optional HAR JSON response (instead of raw image). */
v1ExtraRouter.post('/screenshot/json', async (req: ScoutAuthRequest, res) => {
  const parsed = z
    .object({
      url: z.string().min(1),
      mode: z.enum(['viewport', 'fullpage']).default('fullpage'),
      width: z.number().int().min(200).max(3840).default(1280),
      height: z.number().int().min(200).max(2160).default(800),
      max_page_height: z.number().int().optional(),
      wait_ms: z.number().int().optional(),
      format: z.enum(['jpeg', 'png', 'pdf']).default('png'),
      quality: z.number().int().optional(),
      include_image: z.boolean().optional(),
    })
    .merge(BrowseOptionsSchema)
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const url = await assertPublicHttpUrl(parsed.data.url);
    await prepareBrowseAccess({
      url,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: parsed.data,
    });
    const browse = toPageBrowseOptions(parsed.data);
    const result = await captureScreenshot({
      url,
      mode: parsed.data.mode,
      width: parsed.data.width,
      height: parsed.data.height,
      maxPageHeight: parsed.data.max_page_height,
      waitMs: parsed.data.wait_ms,
      format: parsed.data.format,
      quality: parsed.data.quality,
      colorScheme: browse.colorScheme,
      locale: browse.locale,
      userAgent: browse.userAgent,
      extraHTTPHeaders: browse.extraHTTPHeaders,
      blockResourceTypes: browse.blockResourceTypes,
      blockUrlPatterns: browse.blockUrlPatterns,
      blockAds: parsed.data.block_ads,
      recordHar: parsed.data.record_har,
      httpCredentials: browse.httpCredentials,
      clientCertificates: browse.clientCertificates,
      runtime: browse.runtime,
      dismissCookieBanner: parsed.data.dismiss_cookie_banner,
    });
    res.json({
      status: 'success',
      url,
      final_url: result.finalUrl,
      cookie_banner_detected: result.cookieBanner?.cookie_banner_detected,
      cookie_banner_dismissed: result.cookieBanner?.cookie_banner_dismissed,
      cookie_banner_vendor: result.cookieBanner?.cookie_banner_vendor,
      capture_height: result.captureHeight,
      content_type: result.contentType,
      image_base64: parsed.data.include_image === false ? undefined : result.buffer.toString('base64'),
      har_base64: result.harBase64,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendScoutError(res, err);
  }
});
