/**
 * Post-authorize settlement: fair final credits (crawl pages, actual runtime, failure refunds).
 */
import { scoutConfig } from '../config';
import type { ScoutAuthRequest } from '../auth/middleware';
import {
  estimateCreditsDetailed,
  type CreditEstimate,
  type CreditLineItem,
} from './costs';

export type SettledBilling = {
  totalCredits: number;
  reservedCredits: number;
  refundCredits: number;
  estimatedCredits: number;
  maximumCredits: number;
  items: CreditLineItem[];
  settled: boolean;
  reason: string;
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

export function finalizeCreditsDetailed(input: {
  method: string;
  path: string;
  body?: unknown;
  reserved: CreditEstimate;
  elapsedMs: number;
  crawlOkPages?: number | null;
  failed?: boolean;
}): CreditEstimate & { reservedCredits: number; refundCredits: number } {
  const reservedCredits = input.reserved.estimatedCredits;
  if (input.failed || reservedCredits <= 0) {
    return {
      estimatedCredits: 0,
      maximumCredits: 0,
      items:
        reservedCredits > 0
          ? [{ type: 'refund_scout_failure', credits: 0, detail: 'full refund — no usable result' }]
          : [],
      includedRuntimeMs: input.reserved.includedRuntimeMs,
      requestedTimeoutMs: input.reserved.requestedTimeoutMs,
      reservedCredits,
      refundCredits: reservedCredits,
    };
  }

  const route = normalizeRoute(input.method, input.path);
  const items: CreditLineItem[] = [];
  const stealthEnabled = input.body && typeof input.body === 'object'
    ? (input.body as Record<string, unknown>).stealth === true
    : false;
  for (const line of input.reserved.items) {
    if (line.type === 'crawl_pages_reserved') {
      const ok =
        typeof input.crawlOkPages === 'number' && Number.isFinite(input.crawlOkPages)
          ? Math.max(0, Math.floor(input.crawlOkPages))
          : 0;
      if (ok > 0) {
        items.push({
          type: 'crawl_pages_processed',
          credits: 2 * ok,
          detail: `${ok} successfully processed page(s)`,
        });
      }
      continue;
    }
    if (line.type === 'extended_runtime' || line.type === 'stealth_multiplier') continue;
    items.push(line);
  }

  const included = INCLUDED_RUNTIME_MS[route] ?? INCLUDED_RUNTIME_MS.default;
  const elapsed = Math.max(0, Math.floor(input.elapsedMs));
  if (elapsed > included) {
    const actualChunks = Math.ceil((elapsed - included) / 5_000);
    const reservedRuntime = input.reserved.items.find((i) => i.type === 'extended_runtime');
    const capped = reservedRuntime
      ? Math.min(actualChunks, reservedRuntime.credits)
      : actualChunks;
    if (capped > 0) {
      items.push({
        type: 'extended_runtime',
        credits: capped,
        detail: `${capped}×5s beyond ${Math.round(included / 1000)}s (actual ${Math.round(elapsed / 1000)}s)`,
      });
    }
  }

  if (stealthEnabled) {
    const subtotal = items.reduce((s, i) => s + i.credits, 0);
    if (subtotal > 0) {
      items.push({
        type: 'stealth_multiplier',
        credits: subtotal * (STEALTH_MULTIPLIER - 1),
        detail: `${STEALTH_MULTIPLIER.toFixed(1)}x stealth runtime`,
      });
    }
  }

  const estimatedCredits = items.reduce((s, i) => s + i.credits, 0);
  return {
    estimatedCredits,
    maximumCredits: estimatedCredits,
    items,
    includedRuntimeMs: input.reserved.includedRuntimeMs,
    requestedTimeoutMs: input.reserved.requestedTimeoutMs,
    reservedCredits,
    refundCredits: Math.max(0, reservedCredits - estimatedCredits),
  };
}

function countCrawlOkPages(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const pages = (body as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return null;
  return pages.filter((p) => p && typeof p === 'object' && (p as { status?: string }).status === 'ok').length;
}

export async function settleScoutCredits(input: {
  req: ScoutAuthRequest;
  statusCode: number;
  responseBody?: unknown;
  startedAt: number;
}): Promise<SettledBilling | null> {
  const billing = input.req.scoutBilling;
  const key = input.req.scoutKey?.key;
  if (!billing || !key || !key.startsWith('sk_scout_')) return null;
  if (scoutConfig.deploymentMode === 'self_hosted') return null;
  if (billing.creditsCharged <= 0 && !billing.billing) return null;

  const reserved: CreditEstimate =
    billing.billing && Array.isArray(billing.billing.items)
      ? {
          estimatedCredits: billing.billing.estimatedCredits ?? billing.creditsCharged,
          maximumCredits: billing.billing.maximumCredits ?? billing.creditsCharged,
          items: billing.billing.items,
          includedRuntimeMs: 30_000,
          requestedTimeoutMs: null,
        }
      : estimateCreditsDetailed(input.req.method, input.req.path, input.req.body);

  const failed = input.statusCode >= 400;
  const elapsedMs = Date.now() - input.startedAt;
  const crawlOkPages =
    normalizeRoute(input.req.method, input.req.path) === 'POST /v1/crawl'
      ? countCrawlOkPages(input.responseBody)
      : null;

  const final = finalizeCreditsDetailed({
    method: input.req.method,
    path: input.req.path.startsWith('/v1') ? input.req.path : `/v1${input.req.path}`,
    body: input.req.body,
    reserved,
    elapsedMs,
    crawlOkPages,
    failed,
  });

  const charged = billing.creditsCharged;
  const delta = final.estimatedCredits - charged;
  const reason = failed
    ? 'refund_scout_failure'
    : delta < 0
      ? 'settle_refund'
      : delta > 0
        ? 'settle_debit'
        : 'settle_exact';

  if (delta !== 0) {
    const platformBase = scoutConfig.platformApiBaseUrl;
    const secret = scoutConfig.platformSecret;
    if (platformBase && secret) {
      try {
        await fetch(`${platformBase.replace(/\/$/, '')}/internal/scout/credits/adjust`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Scout-Platform-Secret': secret,
          },
          body: JSON.stringify({
            api_key: key,
            delta,
            reason,
            method: input.req.method,
            path: input.req.path.startsWith('/v1') ? input.req.path : `/v1${input.req.path}`,
            billing_items: final.items,
          }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        // best-effort — response still reports intended settlement
      }
    }
  }

  const settled: SettledBilling = {
    totalCredits: final.estimatedCredits,
    reservedCredits: final.reservedCredits,
    refundCredits: final.refundCredits,
    estimatedCredits: final.estimatedCredits,
    maximumCredits: final.maximumCredits,
    items: final.items,
    settled: true,
    reason,
  };

  input.req.scoutBilling = {
    ...billing,
    creditsCharged: final.estimatedCredits,
    billing: {
      totalCredits: settled.totalCredits,
      estimatedCredits: settled.estimatedCredits,
      maximumCredits: settled.maximumCredits,
      items: settled.items,
    },
  };

  return settled;
}
