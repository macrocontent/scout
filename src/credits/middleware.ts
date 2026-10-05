import type { NextFunction, Response } from 'express';
import type { ScoutAuthRequest } from '../auth/middleware';
import { scoutConfig, type ScoutKeyTier } from '../config';
import { ScoutError, sendScoutError } from '../lib/errors';
import { estimateCredits, estimateCreditsDetailed } from './costs';
import { settleScoutCredits, type SettledBilling } from './settle';

export type ScoutBillingContext = {
  userId: string | null;
  keyId: string | null;
  creditsCharged: number;
  creditsBalance: number | null;
  usedPayg: boolean;
  verifiedHostnames: string[];
  webhookSecret: string | null;
  billing?: {
    totalCredits: number;
    estimatedCredits: number;
    maximumCredits: number;
    items: Array<{ type: string; credits: number; detail?: string }>;
    reservedCredits?: number;
    refundCredits?: number;
    settled?: boolean;
    reason?: string;
  };
};

/**
 * After API key auth: debit account credits for sk_scout_ keys via platform.
 * After the handler finishes, settle to fair final credits (crawl pages, actual runtime,
 * full refund when the API returns an error with no usable result).
 */
export function scoutCreditsMiddleware() {
  return async (req: ScoutAuthRequest, res: Response, next: NextFunction) => {
    const key = req.scoutKey;
    if (!key) {
      next();
      return;
    }

    if (scoutConfig.deploymentMode === 'self_hosted') {
      req.scoutBilling = {
        userId: null,
        keyId: null,
        creditsCharged: 0,
        creditsBalance: null,
        usedPayg: false,
        verifiedHostnames: [],
        webhookSecret: key.webhookSecret ?? null,
      };
      next();
      return;
    }

    if (key.tier === 'internal' || key.tier === 'demo') {
      const local = estimateCreditsDetailed(req.method, req.path, req.body);
      req.scoutBilling = {
        userId: null,
        keyId: null,
        creditsCharged: 0,
        creditsBalance: null,
        usedPayg: false,
        verifiedHostnames: [],
        webhookSecret: key.webhookSecret ?? null,
        billing: {
          totalCredits: 0,
          estimatedCredits: local.estimatedCredits,
          maximumCredits: local.maximumCredits,
          items: local.items,
        },
      };
      next();
      return;
    }

    const platformBase = scoutConfig.platformApiBaseUrl;
    const secret = scoutConfig.platformSecret;
    if (!platformBase || !secret) {
      sendScoutError(
        res,
        new ScoutError(
          'INTERNAL_ERROR',
          'Scout platform billing not configured (SCOUT_PLATFORM_API_BASE_URL / SCOUT_PLATFORM_SECRET)',
          { status: 503 },
        ),
      );
      return;
    }

    const credits = estimateCredits(req.method, req.path, req.body);
    try {
      const authRes = await fetch(`${platformBase.replace(/\/$/, '')}/internal/scout/authorize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Scout-Platform-Secret': secret,
        },
        body: JSON.stringify({
          api_key: key.key,
          method: req.method,
          path: req.path.startsWith('/v1') ? req.path : `/v1${req.path}`,
          body: req.body,
          credits: credits > 0 ? credits : undefined,
        }),
        signal: AbortSignal.timeout(8_000),
      });

      const data = (await authRes.json()) as Record<string, unknown>;
      if (!authRes.ok || data.ok === false) {
        const code = String(data.code || 'CREDITS_EXHAUSTED');
        if (code === 'BILLING_LIMIT_EXCEEDED') {
          sendScoutError(
            res,
            new ScoutError('VALIDATION_FAILED', String(data.error || 'Billing limit exceeded'), {
              status: 402,
              details: {
                status: 'billing_limit_exceeded',
                estimatedCredits: data.estimatedCredits,
                maxCredits: data.maxCredits,
                credits_balance: data.credits_balance,
              },
            }),
          );
          return;
        }
        if (code === 'PAYG_SPEND_LIMIT_EXCEEDED') {
          sendScoutError(
            res,
            new ScoutError('CREDITS_EXHAUSTED', String(data.error || 'PAYG spend limit exceeded'), {
              status: 402,
              details: {
                status: 'payg_spend_limit_exceeded',
                payg_spend_limit_eur: data.payg_spend_limit_eur,
                payg_used_credits: data.payg_used_credits,
                estimatedCredits: data.estimatedCredits,
                credits_balance: data.credits_balance,
              },
            }),
          );
          return;
        }
        if (code === 'CREDITS_EXHAUSTED') {
          sendScoutError(
            res,
            new ScoutError('CREDITS_EXHAUSTED', String(data.error || 'Credits exhausted'), {
              status: 402,
              details: {
                credits_balance: data.credits_balance,
                pay_as_you_go: data.pay_as_you_go,
              },
            }),
          );
          return;
        }
        sendScoutError(
          res,
          new ScoutError('UNAUTHORIZED', String(data.error || 'Invalid Scout API key'), {
            status: 401,
          }),
        );
        return;
      }

      const tierRaw = String(data.tier || key.tier);
      const tier: ScoutKeyTier =
        tierRaw === 'pro'
          ? 'pro'
          : tierRaw === 'basic'
            ? 'basic'
            : tierRaw === 'paid'
              ? 'paid'
              : tierRaw === 'enterprise'
                ? 'enterprise'
                : tierRaw === 'internal'
                  ? 'internal'
                  : 'free';
      req.scoutKey = {
        ...key,
        tier,
        rateLimitPerMinute:
          typeof data.rate_limit_per_minute === 'number'
            ? data.rate_limit_per_minute
            : key.rateLimitPerMinute,
        accountBacked: true,
      };

      const billing =
        data.billing && typeof data.billing === 'object'
          ? (data.billing as ScoutBillingContext['billing'])
          : undefined;

      req.scoutBilling = {
        userId: typeof data.user_id === 'string' ? data.user_id : null,
        keyId: typeof data.key_id === 'string' ? data.key_id : null,
        creditsCharged: Number(data.credits_charged || 0),
        creditsBalance: typeof data.credits_balance === 'number' ? data.credits_balance : null,
        usedPayg: Boolean(data.used_payg),
        verifiedHostnames: Array.isArray(data.verified_hostnames)
          ? (data.verified_hostnames as string[])
          : [],
        webhookSecret:
          typeof data.webhook_secret === 'string' ? data.webhook_secret : null,
        billing,
      };

      if (req.scoutBilling.creditsBalance != null) {
        res.setHeader('X-Scout-Credits-Remaining', String(req.scoutBilling.creditsBalance));
      }
      if (req.scoutBilling.creditsCharged > 0) {
        res.setHeader('X-Scout-Credits-Charged', String(req.scoutBilling.creditsCharged));
      }
      if (billing) {
        res.setHeader('X-Scout-Credits-Breakdown', JSON.stringify(billing));
      }

      const startedAt = Date.now();
      let settlePromise: Promise<SettledBilling | null> | null = null;
      const ensureSettle = (statusCode: number, responseBody?: unknown) => {
        if (!settlePromise) {
          settlePromise = settleScoutCredits({
            req,
            statusCode,
            responseBody,
            startedAt,
          });
        }
        return settlePromise;
      };

      const originalJson = res.json.bind(res);
      const sendWithBilling = (body: unknown, settled: SettledBilling | null) => {
        const payloadBilling = settled
          ? {
              totalCredits: settled.totalCredits,
              estimatedCredits: settled.estimatedCredits,
              maximumCredits: settled.maximumCredits,
              items: settled.items,
              reservedCredits: settled.reservedCredits,
              refundCredits: settled.refundCredits,
              settled: true,
              reason: settled.reason,
            }
          : billing;
        if (payloadBilling) {
          res.setHeader('X-Scout-Credits-Charged', String(payloadBilling.totalCredits));
          res.setHeader('X-Scout-Credits-Breakdown', JSON.stringify(payloadBilling));
        }
        if (payloadBilling && body && typeof body === 'object' && !Buffer.isBuffer(body)) {
          originalJson({ ...(body as Record<string, unknown>), billing: payloadBilling });
        } else {
          originalJson(body as any);
        }
      };

      // Delay JSON until settle so the client sees fair final credits (refund/crawl pages).
      res.json = ((body: unknown) => {
        const statusCode = res.statusCode || 200;
        void ensureSettle(statusCode, body)
          .then((settled) => sendWithBilling(body, settled))
          .catch(() => sendWithBilling(body, null));
        return res;
      }) as typeof res.json;

      // Binary / non-JSON success or error paths
      res.on('finish', () => {
        if (settlePromise) return;
        if (req.scoutBilling && req.scoutBilling.creditsCharged > 0) {
          void ensureSettle(res.statusCode || 200);
        }
      });

      next();
    } catch (err) {
      sendScoutError(
        res,
        new ScoutError(
          'INTERNAL_ERROR',
          `Scout billing authorize failed: ${err instanceof Error ? err.message : String(err)}`,
          { status: 502 },
        ),
      );
    }
  };
}
