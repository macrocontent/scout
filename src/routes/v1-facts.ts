import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import type { ScoutAuthRequest } from '../auth/middleware';
import {
  BrowseOptionsSchema,
  browseRuntimeMeta,
  browseWaitOptions,
  prepareBrowseAccess,
  toPageBrowseOptions,
} from '../lib/browseOptions';
import { sendScoutError } from '../lib/errors';
import { assertPublicHttpUrl } from '../lib/networkGuard';
import { runAsserts } from '../primitives/assert';
import {
  checkA11ySnapshot,
  checkAssets,
  checkCanonical,
  checkConsole,
  checkCookies,
  checkForms,
  checkImages,
  checkJsonLd,
  checkLinks,
  checkNetwork,
  checkOpenGraph,
  checkResources,
  diffDomUrls,
  diffHeaders,
  inspectSitemap,
} from '../primitives/facts';

export const v1FactsRouter = Router();

const UrlBrowseBody = z
  .object({
    url: z.string().min(1),
    settle_ms: z.number().int().min(0).max(30_000).optional(),
    goto_timeout_ms: z.number().int().optional(),
    width: z.number().int().min(200).max(3840).optional(),
    height: z.number().int().min(200).max(2160).optional(),
  })
  .merge(BrowseOptionsSchema);

const DiffUrlBody = z
  .object({
    url_a: z.string().min(1).optional(),
    url_b: z.string().min(1).optional(),
    before_url: z.string().min(1).optional(),
    after_url: z.string().min(1).optional(),
    settle_ms: z.number().int().min(0).max(30_000).optional(),
    goto_timeout_ms: z.number().int().optional(),
    width: z.number().int().min(200).max(3840).optional(),
    height: z.number().int().min(200).max(2160).optional(),
  })
  .merge(BrowseOptionsSchema)
  .refine(
    (d) => (d.url_a && d.url_b) || (d.before_url && d.after_url),
    { message: 'Provide url_a+url_b or before_url+after_url' },
  );

const AssertRuleSchema = z.object({
  selector: z.string().min(1).max(500),
  exists: z.boolean().optional(),
  visible: z.boolean().optional(),
  not_covered: z.boolean().optional(),
  count: z.number().int().min(0).max(10_000).optional(),
  count_min: z.number().int().min(0).max(10_000).optional(),
  count_max: z.number().int().min(0).max(10_000).optional(),
  contains: z.string().max(2000).optional(),
  text: z.string().max(2000).optional(),
  matches: z.string().max(500).optional(),
  href_contains: z.string().max(2000).optional(),
  attr: z
    .object({
      name: z.string().min(1).max(120),
      value: z.string().max(2000),
    })
    .optional(),
  soft: z.boolean().optional(),
  adaptive: z.boolean().optional(),
  match_text: z.string().max(200).optional(),
});

const AssertBody = z
  .object({
    url: z.string().min(1),
    assert: z.array(AssertRuleSchema).min(1).max(25),
    settle_ms: z.number().int().min(0).max(30_000).optional(),
    goto_timeout_ms: z.number().int().optional(),
    width: z.number().int().min(200).max(3840).optional(),
    height: z.number().int().min(200).max(2160).optional(),
    scroll_into_view: z.boolean().optional(),
    ignore_selectors: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .merge(BrowseOptionsSchema);

function browseOpts(parsed: z.infer<typeof UrlBrowseBody>, browse: ReturnType<typeof toPageBrowseOptions>) {
  const wait = browseWaitOptions(parsed);
  return {
    settleMs: parsed.settle_ms,
    gotoTimeoutMs: parsed.goto_timeout_ms,
    width: parsed.width,
    height: parsed.height,
    colorScheme: browse.colorScheme,
    locale: browse.locale,
    userAgent: browse.userAgent,
    extraHTTPHeaders: browse.extraHTTPHeaders,
    blockResourceTypes: browse.blockResourceTypes,
    blockUrlPatterns: browse.blockUrlPatterns,
    blockAds: parsed.block_ads,
    httpCredentials: browse.httpCredentials,
    clientCertificates: browse.clientCertificates,
    runtime: browse.runtime,
    dismissCookieBanner: parsed.dismiss_cookie_banner,
    waitForSelector: wait.waitForSelector,
    waitTimeoutMs: wait.waitTimeoutMs,
    waitForSelectorRequired: wait.required,
  };
}

async function handleUrlBrowse(
  req: ScoutAuthRequest,
  res: Response,
  run: (url: string, opts: ReturnType<typeof browseOpts>) => Promise<Record<string, unknown>>,
) {
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
    const result = await run(url, browseOpts(parsed.data, browse));
    res.json({
      ...result,
      ...browseRuntimeMeta(parsed.data),
    });
  } catch (err) {
    sendScoutError(res, err);
  }
}

v1FactsRouter.post('/assert', async (req: ScoutAuthRequest, res) => {
  const parsed = AssertBody.safeParse(req.body ?? {});
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
    const wait = browseWaitOptions(parsed.data);
    const result = await runAsserts({
      url,
      assert: parsed.data.assert,
      settleMs: parsed.data.settle_ms,
      gotoTimeoutMs: parsed.data.goto_timeout_ms,
      width: parsed.data.width ?? browse.width,
      height: parsed.data.height ?? browse.height,
      colorScheme: browse.colorScheme,
      locale: browse.locale,
      userAgent: browse.userAgent,
      extraHTTPHeaders: browse.extraHTTPHeaders,
      blockResourceTypes: browse.blockResourceTypes,
      blockUrlPatterns: browse.blockUrlPatterns,
      blockAds: parsed.data.block_ads,
      httpCredentials: browse.httpCredentials,
      clientCertificates: browse.clientCertificates,
      deviceScaleFactor: browse.deviceScaleFactor,
      isMobile: browse.isMobile,
      hasTouch: browse.hasTouch,
      runtime: browse.runtime,
      dismissCookieBanner: parsed.data.dismiss_cookie_banner,
      waitForSelector: wait.waitForSelector,
      waitTimeoutMs: wait.waitTimeoutMs,
      waitForSelectorRequired: wait.required,
      scrollIntoView: parsed.data.scroll_into_view,
      ignoreSelectors: parsed.data.ignore_selectors,
      solveCaptcha: parsed.data.solve_captcha,
      captureXhr: parsed.data.capture_xhr,
      javaScriptEnabled: parsed.data.fetch_mode !== 'http',
    });
    res.json({
      ...result,
      ...browseRuntimeMeta(parsed.data),
    });
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1FactsRouter.post('/checks/cookies', (req: ScoutAuthRequest, res) =>
  handleUrlBrowse(req, res, (url, opts) => checkCookies(url, opts)),
);

v1FactsRouter.post('/checks/console', (req: ScoutAuthRequest, res) =>
  handleUrlBrowse(req, res, (url, opts) => checkConsole(url, opts)),
);

v1FactsRouter.post('/checks/network', async (req: ScoutAuthRequest, res) => {
  const parsed = UrlBrowseBody.extend({
    top_slowest: z.boolean().optional(),
  }).safeParse(req.body ?? {});
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
    const result = await checkNetwork(url, {
      ...browseOpts(parsed.data, browse),
      top_slowest: parsed.data.top_slowest,
    });
    res.json({
      ...result,
      ...browseRuntimeMeta(parsed.data),
    });
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1FactsRouter.post('/checks/assets', (req: ScoutAuthRequest, res) =>
  handleUrlBrowse(req, res, (url, opts) => checkAssets(url, opts)),
);

v1FactsRouter.post('/checks/json-ld', (req: ScoutAuthRequest, res) =>
  handleUrlBrowse(req, res, (url, opts) => checkJsonLd(url, opts)),
);

v1FactsRouter.post('/checks/canonical', (req: ScoutAuthRequest, res) =>
  handleUrlBrowse(req, res, (url, opts) => checkCanonical(url, opts)),
);

v1FactsRouter.post('/checks/sitemap', async (req: ScoutAuthRequest, res) => {
  const parsed = z.object({ url: z.string().min(1) }).safeParse(req.body ?? {});
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
      browse: { respect_robots: true },
    });
    const result = await inspectSitemap(url);
    res.json(result);
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1FactsRouter.post('/checks/images', (req: ScoutAuthRequest, res) =>
  handleUrlBrowse(req, res, (url, opts) => checkImages(url, opts)),
);

v1FactsRouter.post('/checks/resources', (req: ScoutAuthRequest, res) =>
  handleUrlBrowse(req, res, (url, opts) => checkResources(url, opts)),
);

v1FactsRouter.post('/checks/a11y-snapshot', (req: ScoutAuthRequest, res) =>
  handleUrlBrowse(req, res, (url, opts) => checkA11ySnapshot(url, opts)),
);

v1FactsRouter.post('/checks/forms', (req: ScoutAuthRequest, res) =>
  handleUrlBrowse(req, res, (url, opts) => checkForms(url, opts)),
);

v1FactsRouter.post('/checks/opengraph', async (req: ScoutAuthRequest, res) => {
  const parsed = UrlBrowseBody.extend({
    screenshot: z.boolean().optional(),
  }).safeParse(req.body ?? {});
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
    const result = await checkOpenGraph(url, {
      ...browseOpts(parsed.data, browse),
      screenshot: parsed.data.screenshot,
    });
    res.json({
      ...result,
      ...browseRuntimeMeta(parsed.data),
    });
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1FactsRouter.post('/checks/links', (req: ScoutAuthRequest, res) =>
  handleUrlBrowse(req, res, (url, opts) => checkLinks(url, opts)),
);

v1FactsRouter.post('/diff/dom', async (req: ScoutAuthRequest, res) => {
  const parsed = DiffUrlBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const urlA = await assertPublicHttpUrl(parsed.data.url_a ?? parsed.data.before_url!);
    const urlB = await assertPublicHttpUrl(parsed.data.url_b ?? parsed.data.after_url!);
    await prepareBrowseAccess({
      url: urlA,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: parsed.data,
    });
    await prepareBrowseAccess({
      url: urlB,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: parsed.data,
    });
    const browse = toPageBrowseOptions(parsed.data);
    const wait = browseWaitOptions(parsed.data);
    const result = await diffDomUrls(urlA, urlB, {
      settleMs: parsed.data.settle_ms,
      gotoTimeoutMs: parsed.data.goto_timeout_ms,
      width: parsed.data.width,
      height: parsed.data.height,
      colorScheme: browse.colorScheme,
      locale: browse.locale,
      userAgent: browse.userAgent,
      extraHTTPHeaders: browse.extraHTTPHeaders,
      blockResourceTypes: browse.blockResourceTypes,
      blockUrlPatterns: browse.blockUrlPatterns,
      blockAds: parsed.data.block_ads,
      httpCredentials: browse.httpCredentials,
      clientCertificates: browse.clientCertificates,
      runtime: browse.runtime,
      dismissCookieBanner: parsed.data.dismiss_cookie_banner,
      waitForSelector: wait.waitForSelector,
      waitTimeoutMs: wait.waitTimeoutMs,
      waitForSelectorRequired: wait.required,
    });
    res.json({
      ...result,
      ...browseRuntimeMeta(parsed.data),
    });
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1FactsRouter.post('/diff/headers', async (req: ScoutAuthRequest, res) => {
  const parsed = DiffUrlBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const urlA = await assertPublicHttpUrl(parsed.data.url_a ?? parsed.data.before_url!);
    const urlB = await assertPublicHttpUrl(parsed.data.url_b ?? parsed.data.after_url!);
    await prepareBrowseAccess({
      url: urlA,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: parsed.data,
    });
    await prepareBrowseAccess({
      url: urlB,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: parsed.data,
    });
    const result = await diffHeaders(urlA, urlB);
    res.json(result);
  } catch (err) {
    sendScoutError(res, err);
  }
});
