import { Router } from 'express';
import { z } from 'zod';
import type { ScoutAuthRequest } from '../auth/middleware';
import { BrowseOptionsSchema, prepareBrowseAccess } from '../lib/browseOptions';
import { DEVICE_PRESETS, listDevicePresetNames } from '../lib/devices';
import { ScoutError, sendScoutError } from '../lib/errors';
import { assertPublicHttpUrl } from '../lib/networkGuard';
import { crawlSite } from '../primitives/crawl';
import type { ExtractField } from '../primitives/extract';
import {
  createTemplate,
  deleteTemplate,
  getTemplateForKey,
  listTemplatesForKey,
  serializeTemplate,
  updateTemplate,
} from '../templates/store';

export const v1GapsRouter = Router();

const fieldExtras = {
  adaptive: z.boolean().optional(),
  match_text: z.string().max(200).optional(),
};

const ExtractFieldSchema = z.discriminatedUnion('type', [
  z.object({ name: z.string().min(1), selector: z.string().min(1), type: z.literal('exists'), ...fieldExtras }),
  z.object({ name: z.string().min(1), selector: z.string().min(1), type: z.literal('text'), ...fieldExtras }),
  z.object({ name: z.string().min(1), selector: z.string().min(1), type: z.literal('html'), ...fieldExtras }),
  z.object({
    name: z.string().min(1),
    selector: z.string().min(1),
    type: z.literal('attribute'),
    attribute: z.string().min(1),
    ...fieldExtras,
  }),
  z.object({ name: z.string().min(1), selector: z.string().min(1), type: z.literal('count'), ...fieldExtras }),
  z.object({ name: z.string().min(1), selector: z.string().min(1), type: z.literal('list'), ...fieldExtras }),
  z.object({ name: z.string().min(1), selector: z.string().min(1), type: z.literal('similar'), ...fieldExtras }),
  z.object({ name: z.string().min(1), selector: z.string().min(1), type: z.literal('selector'), ...fieldExtras }),
]);

v1GapsRouter.get('/devices', (_req, res) => {
  res.json({
    status: 'success',
    devices: listDevicePresetNames().map((name) => {
      const d = DEVICE_PRESETS[name];
      return {
        name: d.name,
        viewport: d.viewport,
        device_scale_factor: d.deviceScaleFactor,
        is_mobile: d.isMobile,
        has_touch: d.hasTouch,
        user_agent: d.userAgent,
      };
    }),
  });
});

v1GapsRouter.get('/templates', (req: ScoutAuthRequest, res) => {
  const key = req.scoutKey?.key;
  if (!key) {
    sendScoutError(res, new ScoutError('UNAUTHORIZED', 'Missing API key', { status: 401 }));
    return;
  }
  res.json({ templates: listTemplatesForKey(key).map(serializeTemplate) });
});

v1GapsRouter.post('/templates', (req: ScoutAuthRequest, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(120),
      slug: z.string().min(1).max(64).optional(),
      description: z.string().max(500).optional(),
      hostname: z.string().max(253).optional(),
      fields: z.array(ExtractFieldSchema).min(1).max(50),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    sendScoutError(
      res,
      new ScoutError('VALIDATION_FAILED', 'Validation failed', {
        details: parsed.error.flatten() as unknown as Record<string, unknown>,
      }),
    );
    return;
  }
  const key = req.scoutKey?.key;
  if (!key) {
    sendScoutError(res, new ScoutError('UNAUTHORIZED', 'Missing API key', { status: 401 }));
    return;
  }
  try {
    const tpl = createTemplate(key, {
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description,
      hostname: parsed.data.hostname,
      fields: parsed.data.fields as ExtractField[],
    });
    res.status(201).json(serializeTemplate(tpl));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already exists')) {
      sendScoutError(res, new ScoutError('VALIDATION_FAILED', message));
      return;
    }
    sendScoutError(res, err);
  }
});

v1GapsRouter.get('/templates/:id', (req: ScoutAuthRequest, res) => {
  const key = req.scoutKey?.key;
  if (!key) {
    sendScoutError(res, new ScoutError('UNAUTHORIZED', 'Missing API key', { status: 401 }));
    return;
  }
  const tpl = getTemplateForKey(key, String(req.params.id));
  if (!tpl) {
    sendScoutError(res, new ScoutError('TEMPLATE_NOT_FOUND', 'Template not found'));
    return;
  }
  res.json(serializeTemplate(tpl));
});

v1GapsRouter.patch('/templates/:id', (req: ScoutAuthRequest, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(120).optional(),
      slug: z.string().min(1).max(64).optional(),
      description: z.string().max(500).nullable().optional(),
      hostname: z.string().max(253).nullable().optional(),
      fields: z.array(ExtractFieldSchema).min(1).max(50).optional(),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    sendScoutError(res, new ScoutError('VALIDATION_FAILED', 'Validation failed'));
    return;
  }
  const key = req.scoutKey?.key;
  if (!key) {
    sendScoutError(res, new ScoutError('UNAUTHORIZED', 'Missing API key', { status: 401 }));
    return;
  }
  try {
    const tpl = updateTemplate(key, String(req.params.id), {
      ...parsed.data,
      fields: parsed.data.fields as ExtractField[] | undefined,
    });
    res.json(serializeTemplate(tpl));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      sendScoutError(res, new ScoutError('TEMPLATE_NOT_FOUND', message));
      return;
    }
    sendScoutError(res, new ScoutError('VALIDATION_FAILED', message));
  }
});

v1GapsRouter.delete('/templates/:id', (req: ScoutAuthRequest, res) => {
  const key = req.scoutKey?.key;
  if (!key) {
    sendScoutError(res, new ScoutError('UNAUTHORIZED', 'Missing API key', { status: 401 }));
    return;
  }
  const ok = deleteTemplate(key, String(req.params.id));
  if (!ok) {
    sendScoutError(res, new ScoutError('TEMPLATE_NOT_FOUND', 'Template not found'));
    return;
  }
  res.json({ success: true });
});

v1GapsRouter.post('/crawl', async (req: ScoutAuthRequest, res) => {
  const parsed = z
    .object({
      start_url: z.string().min(1),
      max_depth: z.number().int().min(0).max(5).optional(),
      max_pages: z.number().int().min(1).max(100).optional(),
      same_origin: z.boolean().optional(),
      allow_hosts: z.array(z.string().min(1)).max(20).optional(),
      seed_from_sitemap: z.boolean().optional(),
      settle_ms: z.number().int().min(0).max(10_000).optional(),
      goto_timeout_ms: z.number().int().optional(),
    })
    .merge(BrowseOptionsSchema.pick({ respect_robots: true }))
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    sendScoutError(res, new ScoutError('VALIDATION_FAILED', 'Validation failed'));
    return;
  }

  try {
    const startUrl = await assertPublicHttpUrl(parsed.data.start_url);
    await prepareBrowseAccess({
      url: startUrl,
      apiKey: req.scoutKey?.key ?? '',
      tier: req.scoutKey?.tier,
      verifiedHostnames: req.scoutBilling?.verifiedHostnames,
      browse: { respect_robots: parsed.data.respect_robots },
    });
    const result = await crawlSite({
      startUrl,
      maxDepth: parsed.data.max_depth,
      maxPages: parsed.data.max_pages,
      sameOrigin: parsed.data.same_origin,
      allowHosts: parsed.data.allow_hosts,
      seedFromSitemap: parsed.data.seed_from_sitemap,
      respectRobots: parsed.data.respect_robots,
      settleMs: parsed.data.settle_ms,
      gotoTimeoutMs: parsed.data.goto_timeout_ms,
    });
    res.json({
      ...result,
      timestamp: new Date().toISOString(),
      note: 'Link discovery only — Scout does not archive page content. Feed discovered_urls into /v1/jobs for batch inspect/extract.',
    });
  } catch (err) {
    sendScoutError(res, err);
  }
});
