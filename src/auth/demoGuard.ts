import type { NextFunction, Response } from 'express';
import type { ScoutAuthRequest } from './middleware';

/** Paths the marketing sandbox proxy may call with the demo key. */
const DEMO_PATHS = new Set([
  '/dns',
  '/robots',
  '/crawl',
  '/screenshot',
  '/screenshot/json',
  '/screenshot/viewports',
  '/checks/visibility',
  '/checks/security',
  '/checks/a11y',
  '/checks/a11y-snapshot',
  '/checks/tech',
  '/checks/network',
  '/checks/cookies',
  '/checks/console',
  '/checks/json-ld',
  '/checks/canonical',
  '/checks/links',
  '/checks/opengraph',
  '/extract',
  '/inspect',
  '/assert',
  '/journey',
  '/performance',
  '/sandbox',
]);

const DEMO_BLOCKED_BODY_KEYS = [
  'evaluate',
  'stealth',
  'solve_captcha',
  'http_auth',
  'client_certificates',
  'webhook_url',
  'webhook_secret',
] as const;

function clampInt(value: unknown, max: number): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.min(max, value);
}

/**
 * Demo keys are for scout.macrocontent.dev sandboxes only.
 * They must not become a public unlimited ScoutAPI key if leaked.
 */
export function scoutDemoKeyGuard(req: ScoutAuthRequest, res: Response, next: NextFunction): void {
  if (req.scoutKey?.tier !== 'demo') {
    next();
    return;
  }

  const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
  if (!DEMO_PATHS.has(path)) {
    res.status(403).json({
      error: 'This endpoint is not available on the public demo key',
      code: 'DEMO_KEY_FORBIDDEN',
      retryable: false,
    });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : null;
  if (body) {
    for (const key of DEMO_BLOCKED_BODY_KEYS) {
      if (body[key] !== undefined && body[key] !== false && body[key] !== null) {
        res.status(403).json({
          error: `${key} is not allowed on the public demo key`,
          code: 'DEMO_KEY_FORBIDDEN',
          retryable: false,
        });
        return;
      }
    }

    if (typeof body.html === 'string' && body.html.length > 12_000) {
      body.html = body.html.slice(0, 12_000);
    }
    if (typeof body.wait_for_function === 'string' && body.wait_for_function.length > 200) {
      delete body.wait_for_function;
    }
    body.max_pages = clampInt(body.max_pages, 8);
    body.max_depth = clampInt(body.max_depth, 2);
    body.wait_ms = clampInt(body.wait_ms, 8_000);
    body.wait_timeout_ms = clampInt(body.wait_timeout_ms, 15_000);
    body.settle_ms = clampInt(body.settle_ms, 4_000);
    if (Array.isArray(body.resources) && body.resources.length > 4) {
      body.resources = body.resources.slice(0, 4);
    }
  }

  next();
}
