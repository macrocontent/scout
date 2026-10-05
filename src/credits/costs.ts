/**
 * Scout endpoint credit costs (mirrors backend/src/lib/scout/pricing.ts).
 * Authoritative debit happens on platform via /internal/scout/authorize.
 */

import { estimateAssertCredits } from '../primitives/assert';

export type ScoutCustomerTier = 'free' | 'basic' | 'pro';

export const SCOUT_TIERS = {
  free: { id: 'free' as const, creditsIncluded: 500, rateLimitPerMinute: 30 },
  basic: { id: 'basic' as const, creditsIncluded: 10_000, rateLimitPerMinute: 120 },
  pro: { id: 'pro' as const, creditsIncluded: 50_000, rateLimitPerMinute: 250 },
};

export type CreditLineItem = {
  type: string;
  credits: number;
  detail?: string;
};

export type CreditEstimate = {
  estimatedCredits: number;
  maximumCredits: number;
  items: CreditLineItem[];
  includedRuntimeMs: number;
  requestedTimeoutMs: number | null;
};

const INCLUDED_RUNTIME_MS: Record<string, number> = {
  'POST /v1/screenshot': 30_000,
  'POST /v1/screenshot/json': 30_000,
  'POST /v1/screenshot/viewports': 30_000,
  'POST /v1/screenshot/diff': 45_000,
  'POST /v1/journey': 90_000,
  'POST /v1/crawl': 120_000,
  'POST /v1/performance': 45_000,
  default: 30_000,
};
const STEALTH_MULTIPLIER = 2;

function normalizeRoute(method: string, path: string): string {
  const p = (path.split('?')[0] || '/').replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '/:id',
  );
  return `${method.toUpperCase()} ${p}`;
}

function readRequestedTimeoutMs(body: Record<string, unknown>): number | null {
  const candidates = [body.goto_timeout_ms, body.wait_timeout_ms, body.timeout_ms, body.navigation_timeout_ms];
  let max: number | null = null;
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      max = max == null ? Math.floor(c) : Math.max(max, Math.floor(c));
    }
  }
  return max;
}

function runtimeAddon(route: string, requestedTimeoutMs: number | null): CreditLineItem | null {
  if (requestedTimeoutMs == null) return null;
  const included = INCLUDED_RUNTIME_MS[route] ?? INCLUDED_RUNTIME_MS.default;
  if (requestedTimeoutMs <= included) return null;
  const chunks = Math.ceil((requestedTimeoutMs - included) / 5_000);
  return {
    type: 'extended_runtime',
    credits: chunks,
    detail: `${chunks}×5s beyond ${Math.round(included / 1000)}s included`,
  };
}

export function estimateCreditsDetailed(
  method: string,
  path: string,
  body?: unknown,
): CreditEstimate {
  const route = normalizeRoute(method, path);
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const items: CreditLineItem[] = [];
  const includedRuntimeMs = INCLUDED_RUNTIME_MS[route] ?? INCLUDED_RUNTIME_MS.default;
  const requestedTimeoutMs = readRequestedTimeoutMs(b);

  const add = (item: CreditLineItem | null | undefined) => {
    if (item && item.credits > 0) items.push(item);
  };
  const applyStealthMultiplier = () => {
    if (b.stealth !== true) return;
    const subtotal = items.reduce((s, i) => s + i.credits, 0);
    if (subtotal <= 0) return;
    add({
      type: 'stealth_multiplier',
      credits: subtotal * (STEALTH_MULTIPLIER - 1),
      detail: `${STEALTH_MULTIPLIER.toFixed(1)}x stealth runtime`,
    });
  };

  if (route === 'POST /v1/assert') {
    const n = Array.isArray(b.assert) ? b.assert.length : 1;
    const total = estimateAssertCredits(n);
    add({ type: 'base', credits: 3, detail: 'assert base' });
    if (total > 3) add({ type: 'assert_extra_rules', credits: total - 3 });
    if (typeof b.capture_xhr === 'string' && b.capture_xhr.trim()) {
      add({ type: 'capture_xhr', credits: 1 });
    }
    if (b.solve_captcha === true) add({ type: 'solve_captcha', credits: 2 });
  } else if (route === 'POST /v1/screenshot/viewports') {
    const n = Array.isArray(b.viewports) ? b.viewports.length : 1;
    const count = Math.max(1, Math.min(n, 8));
    add({ type: 'base', credits: 8 * count, detail: `${count} viewport(s)` });
    if (b.record_har === true) add({ type: 'record_har', credits: 2 });
    add(runtimeAddon(route, requestedTimeoutMs));
  } else if (route === 'POST /v1/journey') {
    const steps = Array.isArray(b.steps) ? b.steps : [];
    add({ type: 'base', credits: 10 });
    if (steps.length) add({ type: 'journey_steps', credits: 2 * steps.length });
    if (steps.some((s) => s && typeof s === 'object' && (s as { type?: string }).type === 'evaluate')) {
      add({ type: 'journey_evaluate', credits: 15 });
    }
    if (b.debug === true) {
      add({ type: 'debug_screenshots', credits: Math.max(1, steps.length) });
    } else if (b.debug && typeof b.debug === 'object') {
      const d = b.debug as { screenshots?: boolean; on_error_only?: boolean };
      if (d.screenshots !== false) {
        add({
          type: 'debug_screenshots',
          credits: d.on_error_only ? 1 : Math.max(1, steps.length),
        });
      }
    }
    if (typeof b.capture_xhr === 'string' && b.capture_xhr.trim()) {
      add({ type: 'capture_xhr', credits: 1 });
    }
    if (b.solve_captcha === true) add({ type: 'solve_captcha', credits: 2 });
    add(runtimeAddon(route, requestedTimeoutMs));
  } else if (route === 'POST /v1/crawl') {
    const maxPages =
      typeof b.max_pages === 'number' ? Math.min(Math.max(Math.floor(b.max_pages), 1), 100) : 25;
    add({ type: 'base', credits: 15 });
    add({ type: 'crawl_pages_reserved', credits: 2 * maxPages });
    add(runtimeAddon(route, requestedTimeoutMs));
  } else if (route === 'POST /v1/jobs') {
    const requests = Array.isArray(b.requests) ? b.requests : [];
    let sum = 0;
    for (const item of requests) {
      if (!item || typeof item !== 'object') continue;
      const type = String((item as { type?: string }).type || '');
      const nestedBody = (item as { body?: unknown }).body;
      const nestedPath =
        type === 'screenshot'
          ? '/v1/screenshot'
          : type === 'extract'
            ? '/v1/extract'
            : type === 'visibility'
              ? '/v1/checks/visibility'
              : type === 'assert'
                ? '/v1/assert'
                : type === 'inspect'
                  ? '/v1/inspect'
                  : type === 'performance'
                    ? '/v1/performance'
                    : type === 'journey'
                      ? '/v1/journey'
                      : type === 'crawl'
                        ? '/v1/crawl'
                        : '/v1/unknown';
      const nested = estimateCreditsDetailed('POST', nestedPath, nestedBody);
      sum += nested.estimatedCredits;
      for (const line of nested.items) {
        add({ type: `job:${type}:${line.type}`, credits: line.credits, detail: line.detail });
      }
    }
    if (sum <= 0) add({ type: 'base', credits: 1, detail: 'minimum job charge' });
  } else if (route === 'POST /v1/checks/opengraph') {
    add({ type: 'base', credits: b.screenshot === true ? 8 : 3 });
    add(runtimeAddon(route, requestedTimeoutMs));
  } else if (route === 'POST /v1/screenshot' || route === 'POST /v1/screenshot/json') {
    add({ type: 'base', credits: 8 });
    const mode = typeof b.mode === 'string' ? b.mode : 'fullpage';
    if (mode === 'fullpage') add({ type: 'full_page', credits: 2 });
    if (b.record_har === true) add({ type: 'record_har', credits: 2 });
    add(runtimeAddon(route, requestedTimeoutMs));
  } else {
    const table: Record<string, number> = {
      'GET /health': 0,
      'GET /': 0,
      'GET /v1/usage': 0,
      'GET /v1/estimate': 0,
      'POST /v1/estimate': 0,
      'GET /v1/devices': 0,
      'POST /v1/dns': 1,
      'POST /v1/robots': 1,
      'POST /v1/extract': 3,
      'POST /v1/inspect': 3,
      'POST /v1/checks/visibility': 3,
      'POST /v1/checks/tech': 3,
      'POST /v1/files': 3,
      'POST /v1/pdf/extract': 4,
      'POST /v1/checks/security': 5,
      'POST /v1/checks/a11y': 5,
      'POST /v1/checks/cookies': 3,
      'POST /v1/checks/console': 3,
      'POST /v1/checks/network': 4,
      'POST /v1/checks/assets': 3,
      'POST /v1/checks/json-ld': 3,
      'POST /v1/checks/canonical': 3,
      'POST /v1/checks/sitemap': 3,
      'POST /v1/checks/images': 3,
      'POST /v1/checks/resources': 3,
      'POST /v1/checks/a11y-snapshot': 3,
      'POST /v1/checks/forms': 3,
      'POST /v1/checks/opengraph': 3,
      'POST /v1/checks/links': 3,
      'POST /v1/diff/dom': 8,
      'POST /v1/diff/headers': 4,
      'POST /v1/performance': 5,
      'POST /v1/sandbox': 5,
      'POST /v1/screenshot/diff': 10,
    };
    let base = 0;
    if (route in table) base = table[route];
    else if (route.startsWith('GET /v1/')) base = 0;
    else if (route.includes('/domains') || route.includes('/templates')) base = 0;
    else if (route.startsWith('POST /v1/')) base = 3;
    if (b.fetch_mode === 'http' && (route === 'POST /v1/extract' || route === 'POST /v1/inspect') && base > 1) {
      base -= 1;
    }
    if (base > 0) {
      add({ type: 'base', credits: base, detail: b.fetch_mode === 'http' ? 'http (no JS)' : undefined });
      if (b.record_har === true) add({ type: 'record_har', credits: 2 });
      if (typeof b.capture_xhr === 'string' && b.capture_xhr.trim()) {
        add({ type: 'capture_xhr', credits: 1 });
      }
      if (b.solve_captcha === true) add({ type: 'solve_captcha', credits: 2 });
      add(runtimeAddon(route, requestedTimeoutMs));
    }
  }

  applyStealthMultiplier();
  const estimatedCredits = items.reduce((s, i) => s + i.credits, 0);
  return {
    estimatedCredits,
    maximumCredits: estimatedCredits,
    items,
    includedRuntimeMs,
    requestedTimeoutMs,
  };
}

export function estimateCredits(method: string, path: string, body?: unknown): number {
  return estimateCreditsDetailed(method, path, body).estimatedCredits;
}

export function readBillingMaxCredits(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const billing = (body as { billing?: { maxCredits?: unknown } }).billing;
  const max = billing?.maxCredits;
  if (typeof max === 'number' && Number.isFinite(max) && max >= 0) return Math.floor(max);
  return null;
}
