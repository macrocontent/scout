import { Router } from 'express';
import { z } from 'zod';
import { canEvaluate, type ScoutAuthRequest } from '../auth/middleware';
import { formatBrowserInfrastructureError } from '../browser/pool';
import { collectNavigateUrls, journeyRequiresVerifiedDomain } from '../domains/policy';
import {
  createDomain,
  deleteDomain,
  getDomainForKey,
  listDomainsForKey,
  serializeDomain,
  verifyDomain,
} from '../domains/store';
import { createJob, getJob, notifyWebhook, updateJob } from '../jobs/store';
import { matchesStopIf, stopReason, StopIfSchema } from '../jobs/stopIf';
import { BrowseOptionsSchema, browseCaptureFlags, browseRuntimeMeta, browseWaitOptions, prepareBrowseAccess, toPageBrowseOptions } from '../lib/browseOptions';
import { lookupDns, type DnsRecordType } from '../lib/dnsLookup';
import { ScoutError, sendScoutError } from '../lib/errors';
import { assertPublicHttpUrl } from '../lib/networkGuard';
import { resolveWebhookSecret } from '../lib/webhook';
import { extractFields, type ExtractField } from '../primitives/extract';
import { inspectPage } from '../primitives/inspect';
import { runJourney, type JourneyStep } from '../primitives/journey';
import { measurePerformance } from '../primitives/performance';
import { runSandbox } from '../primitives/sandbox';
import { captureScreenshot } from '../primitives/screenshot';
import { checkVisibility } from '../primitives/visibility';
import { getTemplateForKey } from '../templates/store';
import { v1ExtraRouter } from './v1-extra';
import { v1FactsRouter } from './v1-facts';
import { v1GapsRouter } from './v1-gaps';

export const v1Router = Router();
v1Router.use(v1ExtraRouter);
v1Router.use(v1FactsRouter);
v1Router.use(v1GapsRouter);

const DnsBody = z.object({
  hostname: z.string().min(1),
  types: z
    .array(z.enum(['A', 'AAAA', 'TXT', 'CNAME', 'MX', 'NS', 'SOA']))
    .min(1)
    .max(7)
    .optional(),
});

const DomainCreateBody = z.object({
  hostname: z.string().min(1),
});

const CookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  expires: z.number().optional(),
});

const ScreenshotBody = z
  .object({
    url: z.string().min(1),
    mode: z.enum(['viewport', 'fullpage']).default('fullpage'),
    width: z.number().int().min(200).max(3840).default(1280),
    height: z.number().int().min(200).max(2160).default(800),
    max_page_height: z.number().int().min(400).max(50_000).optional(),
    wait_ms: z.number().int().min(0).max(30_000).optional(),
    format: z.enum(['jpeg', 'png', 'pdf']).default('jpeg'),
    quality: z.number().int().min(1).max(100).optional(),
  })
  .merge(BrowseOptionsSchema);

const VisibilityBody = z
  .object({
    url: z.string().min(1),
    selector: z.string().min(1),
    wait_for_selector: z.string().optional(),
    settle_ms: z.number().int().min(0).max(30_000).optional(),
    scroll_into_view: z.boolean().optional(),
    ignore_selectors: z.array(z.string()).optional(),
    expect: z
      .object({
        attribute: z.object({ name: z.string().min(1), value: z.string() }).optional(),
        href_contains: z.string().optional(),
      })
      .optional(),
    goto_timeout_ms: z.number().int().min(1000).max(120_000).optional(),
    wait_timeout_ms: z.number().int().min(1000).max(120_000).optional(),
    width: z.number().int().min(200).max(3840).optional(),
    height: z.number().int().min(200).max(2160).optional(),
    dismiss_cookie_banner: z.boolean().optional(),
  })
  .merge(BrowseOptionsSchema);

const ExtractFieldSchema = z
  .object({
    name: z.string().min(1),
    selector: z.string().min(1),
    type: z.enum(['exists', 'text', 'html', 'attribute', 'count', 'list', 'similar', 'selector']),
    attribute: z.string().min(1).optional(),
    adaptive: z.boolean().optional(),
    match_text: z.string().max(200).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'attribute' && !val.attribute) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'attribute is required when type is attribute' });
    }
  });

const ExtractBody = z
  .object({
    url: z.string().min(1),
    fields: z.array(ExtractFieldSchema).max(50).optional(),
    template_id: z.string().min(1).optional(),
    wait_for: z.string().optional(),
    settle_ms: z.number().int().min(0).max(30_000).optional(),
    goto_timeout_ms: z.number().int().min(1000).max(120_000).optional(),
    wait_timeout_ms: z.number().int().min(1000).max(120_000).optional(),
    width: z.number().int().min(200).max(3840).optional(),
    height: z.number().int().min(200).max(2160).optional(),
  })
  .merge(BrowseOptionsSchema)
  .superRefine((val, ctx) => {
    if (!val.fields?.length && !val.template_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide fields or template_id',
      });
    }
  });

const JourneyStepSchema = z.object({
  type: z.enum([
    'navigate',
    'set_content',
    'interact',
    'extract',
    'visibility',
    'screenshot',
    'evaluate',
    'wait_for_function',
  ]),
  url: z.string().optional(),
  html: z.string().optional(),
  wait_until: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
  timeout_ms: z.number().int().optional(),
  action: z
    .enum([
      'click',
      'type',
      'fill',
      'scroll',
      'hover',
      'press_key',
      'select_option',
      'wait',
      'wait_for_selector',
    ])
    .optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  clear: z.boolean().optional(),
  y: z.number().optional(),
  key: z.string().optional(),
  value: z.string().optional(),
  ms: z.number().optional(),
  state: z.enum(['attached', 'visible', 'hidden']).optional(),
  fields: z.array(ExtractFieldSchema).optional(),
  scroll_into_view: z.boolean().optional(),
  ignore_selectors: z.array(z.string()).optional(),
  mode: z.enum(['viewport', 'fullpage']).optional(),
  format: z.enum(['jpeg', 'png']).optional(),
  quality: z.number().int().optional(),
  expression: z.string().optional(),
});

const JourneyDebugSchema = z.union([
  z.boolean(),
  z.object({
    screenshots: z.boolean().optional(),
    on_error_only: z.boolean().optional(),
    format: z.enum(['jpeg', 'png']).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  }),
]);

const JourneyBody = z.object({
  steps: z.array(JourneyStepSchema).min(1).max(40),
  width: z.number().int().min(200).max(3840).optional(),
  height: z.number().int().min(200).max(2160).optional(),
  user_agent: z.string().optional(),
  headers: z.record(z.string()).optional(),
  cookies: z.array(CookieSchema).optional(),
  /**
   * Visual debug for journey authoring: attach page URL (+ viewport screenshot)
   * to each step. Prefer `on_error_only` in production to keep responses small.
   */
  debug: JourneyDebugSchema.optional(),
  /** After navigate/set_content — known CMP accept only (no domain verify). */
  dismiss_cookie_banner: z.boolean().optional(),
  solve_captcha: z.boolean().optional(),
  stealth: z.boolean().optional(),
  capture_xhr: z.string().min(1).max(500).optional(),
  fetch_mode: z.enum(['browser', 'http']).optional(),
});

const InspectBody = z
  .object({
    url: z.string().min(1),
    include: z
      .array(
        z.enum([
          'meta',
          'headings',
          'links',
          'images',
          'json_ld',
          'headers',
          'security',
          'tech',
          'files',
          'a11y',
        ]),
      )
      .optional(),
    settle_ms: z.number().int().min(0).max(30_000).optional(),
    goto_timeout_ms: z.number().int().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
  })
  .merge(BrowseOptionsSchema);

function extractRunOptions(url: string, fields: ExtractField[], body: z.infer<typeof ExtractBody>) {
  const browse = toPageBrowseOptions(body);
  const wait = browseWaitOptions(body);
  const flags = browseCaptureFlags(body);
  return {
    url,
    fields,
    waitForSelector: body.wait_for_selector || body.wait_for,
    waitForSelectorRequired: wait.required,
    settleMs: body.settle_ms,
    gotoTimeoutMs: body.goto_timeout_ms,
    waitTimeoutMs: body.wait_for_selector_timeout_ms || body.wait_timeout_ms,
    width: body.width ?? browse.width,
    height: body.height ?? browse.height,
    detectCaptcha: body.detect_captcha,
    dismissCookieBanner: body.dismiss_cookie_banner,
    solveCaptcha: flags.solveCaptcha,
    captureXhr: flags.captureXhr,
    pageOptions: browse,
    blockAds: body.block_ads,
  };
}

function inspectRunOptions(url: string, body: z.infer<typeof InspectBody>) {
  const browse = toPageBrowseOptions(body);
  const wait = browseWaitOptions(body);
  const flags = browseCaptureFlags(body);
  return {
    url,
    include: body.include,
    settleMs: body.settle_ms,
    gotoTimeoutMs: body.goto_timeout_ms,
    width: body.width ?? browse.width,
    height: body.height ?? browse.height,
    colorScheme: browse.colorScheme,
    locale: browse.locale,
    userAgent: browse.userAgent,
    extraHTTPHeaders: browse.extraHTTPHeaders,
    blockResourceTypes: browse.blockResourceTypes,
    blockUrlPatterns: browse.blockUrlPatterns,
    blockAds: body.block_ads,
    httpCredentials: browse.httpCredentials,
    clientCertificates: browse.clientCertificates,
    deviceScaleFactor: browse.deviceScaleFactor,
    isMobile: browse.isMobile,
    hasTouch: browse.hasTouch,
    waitForSelector: wait.waitForSelector,
    waitTimeoutMs: wait.waitTimeoutMs,
    waitForSelectorRequired: wait.required,
    detectCaptcha: body.detect_captcha,
    dismissCookieBanner: body.dismiss_cookie_banner,
    solveCaptcha: flags.solveCaptcha,
    captureXhr: flags.captureXhr,
    javaScriptEnabled: flags.javaScriptEnabled,
    runtime: browse.runtime,
  };
}

function journeyRunOptions(body: z.infer<typeof JourneyBody>, allowEvaluate: boolean) {
  const browse = toPageBrowseOptions(body);
  return {
    steps: body.steps as JourneyStep[],
    width: body.width,
    height: body.height,
    userAgent: body.user_agent,
    headers: body.headers,
    cookies: body.cookies,
    allowEvaluate,
    debug: body.debug,
    dismissCookieBanner: body.dismiss_cookie_banner,
    solveCaptcha: body.solve_captcha,
    captureXhr: body.capture_xhr,
    javaScriptEnabled: body.fetch_mode !== 'http',
    runtime: browse.runtime,
  };
}

const PerformanceBody = z
  .object({
    url: z.string().min(1),
    settle_ms: z.number().int().min(0).max(30_000).optional(),
    goto_timeout_ms: z.number().int().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
  })
  .merge(BrowseOptionsSchema);

const SandboxBody = z.object({
  html: z.string().min(1).max(2_000_000),
  resources: z
    .array(
      z.object({
        url: z.string().min(1),
        body: z.string().max(5_000_000),
        content_type: z.string().optional(),
        status: z.number().int().optional(),
      }),
    )
    .max(20)
    .optional(),
  block_external: z.boolean().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  wait_for_function: z.string().optional(),
  wait_timeout_ms: z.number().int().optional(),
  evaluate: z.string().optional(),
  screenshot: z.boolean().optional(),
});

const BatchBody = z.object({
  requests: z
    .array(
      z.object({
        type: z.enum([
          'screenshot',
          'extract',
          'visibility',
          'inspect',
          'performance',
          'journey',
          'crawl',
        ]),
        body: z.record(z.unknown()),
        /**
         * After this step, if the result matches stop_if, skip remaining steps.
         * Job still completes successfully (not failed) with stopped_early: true.
         * Typical restock pattern: visibility + stop_if: { visible: false }.
         */
        stop_if: StopIfSchema.optional(),
      }),
    )
    .min(1)
    .max(25),
  webhook_url: z.string().url().optional(),
  /** Per-job HMAC secret override (falls back to key / SCOUT_WEBHOOK_SECRET). */
  webhook_secret: z.string().min(8).max(200).optional(),
});

v1Router.post('/dns', async (req: ScoutAuthRequest, res) => {
  const parsed = DnsBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await lookupDns(
      parsed.data.hostname,
      (parsed.data.types as DnsRecordType[] | undefined) ?? ['A', 'AAAA', 'TXT', 'CNAME', 'MX', 'NS'],
    );
    res.status(200).json({
      status: 'success',
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'DNS lookup failed' });
  }
});

v1Router.get('/domains', (req: ScoutAuthRequest, res) => {
  const key = req.scoutKey?.key;
  if (!key) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }
  res.json({
    domains: listDomainsForKey(key).map(serializeDomain),
  });
});

v1Router.post('/domains', (req: ScoutAuthRequest, res) => {
  const parsed = DomainCreateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const key = req.scoutKey?.key;
  if (!key) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }
  try {
    const domain = createDomain(key, parsed.data.hostname);
    res.status(201).json(serializeDomain(domain));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not create domain' });
  }
});

v1Router.get('/domains/:id', (req: ScoutAuthRequest, res) => {
  const key = req.scoutKey?.key;
  if (!key) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }
  const domain = getDomainForKey(key, String(req.params.id));
  if (!domain) {
    res.status(404).json({ error: 'Domain not found' });
    return;
  }
  res.json(serializeDomain(domain));
});

v1Router.post('/domains/:id/verify', async (req: ScoutAuthRequest, res) => {
  const key = req.scoutKey?.key;
  if (!key) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }
  try {
    const domain = await verifyDomain(key, String(req.params.id));
    res.json(serializeDomain(domain));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    const existing = getDomainForKey(key, String(req.params.id));
    res.status(existing ? 400 : 404).json({
      error: message,
      domain: existing ? serializeDomain(existing) : undefined,
    });
  }
});

v1Router.delete('/domains/:id', (req: ScoutAuthRequest, res) => {
  const key = req.scoutKey?.key;
  if (!key) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }
  const ok = deleteDomain(key, String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: 'Domain not found' });
    return;
  }
  res.status(200).json({ success: true });
});

v1Router.post('/screenshot', async (req: ScoutAuthRequest, res) => {
  const parsed = ScreenshotBody.safeParse(req.body ?? {});
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
    const result = await captureScreenshot({
      url,
      mode: parsed.data.mode,
      width: parsed.data.width ?? browse.width ?? 1280,
      height: parsed.data.height ?? browse.height ?? 800,
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
      deviceScaleFactor: browse.deviceScaleFactor,
      isMobile: browse.isMobile,
      hasTouch: browse.hasTouch,
      runtime: browse.runtime,
      waitForSelector: wait.waitForSelector,
      waitTimeoutMs: wait.waitTimeoutMs,
      waitForSelectorRequired: wait.required,
      dismissCookieBanner: parsed.data.dismiss_cookie_banner,
      solveCaptcha: parsed.data.solve_captcha,
    });
    res.setHeader('X-Scout-Capture-Height', String(result.captureHeight));
    res.setHeader('X-Scout-Final-Url', result.finalUrl);
    if (result.harBase64) res.setHeader('X-Scout-Har-Available', '1');
    if (result.cookieBanner) {
      res.setHeader('X-Scout-Cookie-Banner-Detected', result.cookieBanner.cookie_banner_detected ? '1' : '0');
      res.setHeader('X-Scout-Cookie-Banner-Dismissed', result.cookieBanner.cookie_banner_dismissed ? '1' : '0');
      if (result.cookieBanner.cookie_banner_vendor) {
        res.setHeader('X-Scout-Cookie-Banner-Vendor', result.cookieBanner.cookie_banner_vendor);
      }
    }
    if (result.captcha) {
      res.setHeader('X-Scout-Captcha-Detected', result.captcha.captcha_detected ? '1' : '0');
      res.setHeader('X-Scout-Captcha-Solved', result.captcha.captcha_solved ? '1' : '0');
    }
    res.setHeader('X-Scout-Browser-Runtime', browse.runtime ?? 'chromium');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.type(result.contentType).send(result.buffer);
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1Router.post('/checks/visibility', async (req: ScoutAuthRequest, res) => {
  const parsed = VisibilityBody.safeParse(req.body ?? {});
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
    const result = await checkVisibility({
      url,
      selector: parsed.data.selector,
      waitForSelector: parsed.data.wait_for_selector,
      settleMs: parsed.data.settle_ms,
      scrollIntoView: parsed.data.scroll_into_view,
      ignoreSelectors: parsed.data.ignore_selectors,
      expect: parsed.data.expect
        ? {
            attribute: parsed.data.expect.attribute,
            hrefContains: parsed.data.expect.href_contains,
          }
        : undefined,
      gotoTimeoutMs: parsed.data.goto_timeout_ms,
      waitTimeoutMs: parsed.data.wait_timeout_ms,
      width: parsed.data.width ?? browse.width,
      height: parsed.data.height ?? browse.height,
      dismissCookieBanner: parsed.data.dismiss_cookie_banner,
      solveCaptcha: parsed.data.solve_captcha,
      runtime: browse.runtime,
    });
    res.status(200).json({
      status: result.status === 'unreachable' ? 'error' : 'success',
      check_status: result.status,
      overall_pass: result.overall_pass,
      exists: result.exists,
      visible: result.visible,
      in_viewport: result.in_viewport,
      not_covered: result.not_covered,
      overlap_detected_by: result.overlap_detected_by,
      attribute_match: result.attribute_match,
      href_match: result.href_match,
      error: result.error,
      cookie_banner_detected: result.cookie_banner_detected,
      cookie_banner_dismissed: result.cookie_banner_dismissed,
      cookie_banner_vendor: result.cookie_banner_vendor,
      captcha_detected: result.captcha_detected,
      captcha_solved: result.captcha_solved,
      url: parsed.data.url,
      timestamp: new Date().toISOString(),
      ...browseRuntimeMeta(parsed.data),
      meta: {
        response_time_ms: result.response_time_ms,
        final_url: result.final_url,
      },
    });
  } catch (err) {
    const message = formatBrowserInfrastructureError(err);
    const status = message.includes('not allowed') || message.includes('Invalid URL') ? 400 : 502;
    res.status(status).json({ error: message });
  }
});

v1Router.post('/extract', async (req: ScoutAuthRequest, res) => {
  const parsed = ExtractBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendScoutError(
      res,
      new ScoutError('VALIDATION_FAILED', 'Validation failed', {
        details: parsed.error.flatten() as unknown as Record<string, unknown>,
      }),
    );
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

    let fields = parsed.data.fields;
    let templateMeta: { id: string; slug: string } | undefined;
    if (parsed.data.template_id) {
      const tpl = getTemplateForKey(req.scoutKey?.key ?? '', parsed.data.template_id);
      if (!tpl) {
        sendScoutError(res, new ScoutError('TEMPLATE_NOT_FOUND', 'Template not found'));
        return;
      }
      fields = tpl.fields;
      templateMeta = { id: tpl.id, slug: tpl.slug };
    }
    if (!fields?.length) {
      sendScoutError(res, new ScoutError('VALIDATION_FAILED', 'No extract fields resolved'));
      return;
    }

    const result = await extractFields(extractRunOptions(url, fields as ExtractField[], parsed.data));

    if (result.status === 'error' && result.error?.includes('wait_for_selector')) {
      sendScoutError(res, new ScoutError('SELECTOR_NOT_FOUND', result.error));
      return;
    }

    res.status(result.status === 'success' ? 200 : 502).json({
      ...result,
      url: parsed.data.url,
      template: templateMeta,
      timestamp: new Date().toISOString(),
      ...browseRuntimeMeta(parsed.data),
      meta: {
        response_time_ms: result.response_time_ms,
        final_url: result.final_url,
      },
    });
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1Router.post('/journey', async (req: ScoutAuthRequest, res) => {
  const parsed = JourneyBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const allowEvaluate = canEvaluate(req.scoutKey);
  const hasEvaluate = parsed.data.steps.some((s) => s.type === 'evaluate');
  if (hasEvaluate && !allowEvaluate) {
    res.status(403).json({
      error: 'evaluate steps require a Pro API key',
    });
    return;
  }

  const steps = parsed.data.steps as JourneyStep[];
  const apiKey = req.scoutKey?.key ?? '';

  // Validate navigate URLs + domain ownership for sensitive journeys
  for (const step of steps) {
    if (step.type === 'navigate' && step.url) {
      try {
        await assertPublicHttpUrl(step.url);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid URL in navigate step' });
        return;
      }
    }
  }

  if (journeyRequiresVerifiedDomain(steps, parsed.data.cookies) || parsed.data.solve_captcha || parsed.data.stealth) {
    const navigateUrls = collectNavigateUrls(steps);
    if (navigateUrls.length === 0) {
      res.status(400).json({
        error: 'Sensitive journey steps require at least one navigate URL on a verified domain',
        code: 'DOMAIN_VERIFY_REQUIRED',
      });
      return;
    }
    for (const url of navigateUrls) {
      try {
        await prepareBrowseAccess({
          url,
          apiKey,
          tier: req.scoutKey?.tier,
          verifiedHostnames: req.scoutBilling?.verifiedHostnames,
          browse: {
            solve_captcha: parsed.data.solve_captcha,
            stealth: parsed.data.stealth,
          },
        });
      } catch (err) {
        sendScoutError(res, err);
        return;
      }
    }
  }

  const result = await runJourney(journeyRunOptions(parsed.data, allowEvaluate));
  res.status(result.status === 'success' ? 200 : 422).json({
    ...result,
    timestamp: new Date().toISOString(),
    ...browseRuntimeMeta(parsed.data),
  });
});

v1Router.post('/inspect', async (req: ScoutAuthRequest, res) => {
  const parsed = InspectBody.safeParse(req.body ?? {});
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
    const result = await inspectPage(inspectRunOptions(url, parsed.data));
    res.status(200).json({
      ...result,
      ...browseRuntimeMeta(parsed.data),
    });
  } catch (err) {
    sendScoutError(res, err);
  }
});

v1Router.post('/performance', async (req: ScoutAuthRequest, res) => {
  const parsed = PerformanceBody.safeParse(req.body ?? {});
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
    const result = await measurePerformance({
      url,
      settleMs: parsed.data.settle_ms,
      gotoTimeoutMs: parsed.data.goto_timeout_ms,
      width: parsed.data.width ?? browse.width,
      height: parsed.data.height ?? browse.height,
      runtime: browse.runtime,
    });
    res.status(200).json({
      ...result,
      ...browseRuntimeMeta(parsed.data),
    });
  } catch (err) {
    const message = formatBrowserInfrastructureError(err);
    const status = message.includes('not allowed') || message.includes('Invalid URL') ? 400 : 502;
    res.status(status).json({ error: message });
  }
});

v1Router.post('/sandbox', async (req: ScoutAuthRequest, res) => {
  const parsed = SandboxBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const allowEvaluate = canEvaluate(req.scoutKey);
  if (parsed.data.evaluate && !allowEvaluate) {
    res.status(403).json({ error: 'evaluate requires a Pro API key' });
    return;
  }
  try {
    const result = await runSandbox({
      html: parsed.data.html,
      resources: parsed.data.resources,
      blockExternal: parsed.data.block_external,
      width: parsed.data.width,
      height: parsed.data.height,
      waitForFunction: parsed.data.wait_for_function,
      waitTimeoutMs: parsed.data.wait_timeout_ms,
      evaluate: parsed.data.evaluate,
      allowEvaluate,
      screenshot: parsed.data.screenshot,
    });
    res.status(200).json(result);
  } catch (err) {
    const message = formatBrowserInfrastructureError(err);
    res.status(502).json({ error: message });
  }
});

v1Router.post('/jobs', async (req: ScoutAuthRequest, res) => {
  const parsed = BatchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const webhookSecret = resolveWebhookSecret(req.scoutKey, parsed.data.webhook_secret);
  const job = createJob(parsed.data, parsed.data.webhook_url, webhookSecret);
  res.status(202).json({
    job_id: job.id,
    status: job.status,
    poll: `/v1/jobs/${job.id}`,
    expires_at: job.expires_at,
    webhook_signed: Boolean(webhookSecret),
  });

  void (async () => {
    updateJob(job.id, { status: 'running' });
    const results: unknown[] = [];
    let earlyStop: { stopped_at: number; stop_reason: string } | null = null;
    try {
      for (let stepIndex = 0; stepIndex < parsed.data.requests.length; stepIndex++) {
        const item = parsed.data.requests[stepIndex]!;
        // Re-dispatch through internal helpers by constructing a fake call path
        if (item.type === 'extract') {
          const body = ExtractBody.parse(item.body);
          const url = await assertPublicHttpUrl(body.url);
          await prepareBrowseAccess({
            url,
            apiKey: req.scoutKey?.key ?? '',
            tier: req.scoutKey?.tier,
            verifiedHostnames: req.scoutBilling?.verifiedHostnames,
            browse: body,
          });
          let fields = body.fields as ExtractField[] | undefined;
          if (body.template_id) {
            const tpl = getTemplateForKey(req.scoutKey?.key ?? '', body.template_id);
            if (!tpl) throw new ScoutError('TEMPLATE_NOT_FOUND', 'Template not found');
            fields = tpl.fields;
          }
          if (!fields?.length) throw new ScoutError('VALIDATION_FAILED', 'No extract fields');
          results.push(await extractFields(extractRunOptions(url, fields, body)));
        } else if (item.type === 'inspect') {
          const body = InspectBody.parse(item.body);
          const url = await assertPublicHttpUrl(body.url);
          await prepareBrowseAccess({
            url,
            apiKey: req.scoutKey?.key ?? '',
            tier: req.scoutKey?.tier,
            verifiedHostnames: req.scoutBilling?.verifiedHostnames,
            browse: body,
          });
          results.push(await inspectPage(inspectRunOptions(url, body)));
        } else if (item.type === 'performance') {
          const body = PerformanceBody.parse(item.body);
          const url = await assertPublicHttpUrl(body.url);
          await prepareBrowseAccess({
            url,
            apiKey: req.scoutKey?.key ?? '',
            tier: req.scoutKey?.tier,
            verifiedHostnames: req.scoutBilling?.verifiedHostnames,
            browse: body,
          });
          const browse = toPageBrowseOptions(body);
          results.push(
            await measurePerformance({
              url,
              settleMs: body.settle_ms,
              gotoTimeoutMs: body.goto_timeout_ms,
              width: body.width ?? browse.width,
              height: body.height ?? browse.height,
              runtime: browse.runtime,
            }),
          );
        } else if (item.type === 'visibility') {
          const body = VisibilityBody.parse(item.body);
          const url = await assertPublicHttpUrl(body.url);
          await prepareBrowseAccess({
            url,
            apiKey: req.scoutKey?.key ?? '',
            tier: req.scoutKey?.tier,
            verifiedHostnames: req.scoutBilling?.verifiedHostnames,
            browse: body,
          });
          const browse = toPageBrowseOptions(body);
          results.push(
            await checkVisibility({
              url,
              selector: body.selector,
              waitForSelector: body.wait_for_selector,
              settleMs: body.settle_ms,
              scrollIntoView: body.scroll_into_view,
              ignoreSelectors: body.ignore_selectors,
              expect: body.expect
                ? { attribute: body.expect.attribute, hrefContains: body.expect.href_contains }
                : undefined,
              gotoTimeoutMs: body.goto_timeout_ms,
              waitTimeoutMs: body.wait_timeout_ms,
              width: body.width ?? browse.width,
              height: body.height ?? browse.height,
              dismissCookieBanner: body.dismiss_cookie_banner,
              solveCaptcha: body.solve_captcha,
              runtime: browse.runtime,
            }),
          );
        } else if (item.type === 'screenshot') {
          const body = ScreenshotBody.parse(item.body);
          const url = await assertPublicHttpUrl(body.url);
          await prepareBrowseAccess({
            url,
            apiKey: req.scoutKey?.key ?? '',
            tier: req.scoutKey?.tier,
            verifiedHostnames: req.scoutBilling?.verifiedHostnames,
            browse: body,
          });
          const browse = toPageBrowseOptions(body);
          const wait = browseWaitOptions(body);
          const shot = await captureScreenshot({
            url,
            mode: body.mode,
            width: body.width,
            height: body.height,
            maxPageHeight: body.max_page_height,
            waitMs: body.wait_ms,
            format: body.format === 'pdf' ? 'jpeg' : body.format,
            quality: body.quality,
            colorScheme: browse.colorScheme,
            locale: browse.locale,
            userAgent: browse.userAgent,
            extraHTTPHeaders: browse.extraHTTPHeaders,
            blockResourceTypes: browse.blockResourceTypes,
            blockUrlPatterns: browse.blockUrlPatterns,
            blockAds: body.block_ads,
            recordHar: body.record_har,
            httpCredentials: browse.httpCredentials,
            clientCertificates: browse.clientCertificates,
            deviceScaleFactor: browse.deviceScaleFactor,
            isMobile: browse.isMobile,
            hasTouch: browse.hasTouch,
            runtime: browse.runtime,
            waitForSelector: wait.waitForSelector,
            waitTimeoutMs: wait.waitTimeoutMs,
            waitForSelectorRequired: wait.required,
            dismissCookieBanner: body.dismiss_cookie_banner,
            solveCaptcha: body.solve_captcha,
          });
          results.push({
            content_type: shot.contentType,
            capture_height: shot.captureHeight,
            final_url: shot.finalUrl,
            base64: shot.buffer.toString('base64'),
          });
        } else if (item.type === 'journey') {
          const body = JourneyBody.parse(item.body);
          results.push(
            await runJourney(journeyRunOptions(body, canEvaluate(req.scoutKey))),
          );
        } else if (item.type === 'crawl') {
          const CrawlBody = z.object({
            start_url: z.string().min(1),
            max_depth: z.number().int().optional(),
            max_pages: z.number().int().optional(),
            same_origin: z.boolean().optional(),
            allow_hosts: z.array(z.string()).optional(),
            seed_from_sitemap: z.boolean().optional(),
            respect_robots: z.boolean().optional(),
          });
          const body = CrawlBody.parse(item.body);
          const { crawlSite } = await import('../primitives/crawl');
          results.push(
            await crawlSite({
              startUrl: await assertPublicHttpUrl(body.start_url),
              maxDepth: body.max_depth,
              maxPages: body.max_pages,
              sameOrigin: body.same_origin,
              allowHosts: body.allow_hosts,
              seedFromSitemap: body.seed_from_sitemap,
              respectRobots: body.respect_robots,
            }),
          );
        }

        const stepResult = results[results.length - 1];
        if (item.stop_if && matchesStopIf(item.stop_if, stepResult)) {
          earlyStop = {
            stopped_at: stepIndex,
            stop_reason: stopReason(item.stop_if, stepIndex),
          };
          break;
        }
      }
      const completed = updateJob(job.id, {
        status: 'completed',
        result: {
          results,
          ...(earlyStop
            ? {
                stopped_early: true,
                stopped_at: earlyStop.stopped_at,
                stop_reason: earlyStop.stop_reason,
              }
            : { stopped_early: false }),
        },
      });
      if (completed) await notifyWebhook(completed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = updateJob(job.id, { status: 'failed', error: message.slice(0, 500) });
      if (failed) await notifyWebhook(failed);
    }
  })();
});

v1Router.get('/jobs/:id', (req: ScoutAuthRequest, res) => {
  const job = getJob(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({
    job_id: job.id,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    expires_at: job.expires_at,
    result: job.result,
    error: job.error,
  });
});
