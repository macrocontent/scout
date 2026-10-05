import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { findApiKey, scoutConfig, type ScoutApiKeyRecord } from '../config';
import type { ScoutBillingContext } from '../credits/middleware';
import { recordUsage } from '../usage/store';
import { scoutRedisRateLimitStore } from './redisRateLimitStore';

export type ScoutAuthRequest = Request & {
  scoutKey?: ScoutApiKeyRecord;
  scoutBilling?: ScoutBillingContext;
};

function extractPresentedKey(req: Request): string | null {
  const headerKey = req.header('x-scout-key')?.trim();
  if (headerKey) return headerKey;
  const auth = req.header('authorization')?.trim();
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

export function requireScoutApiKey(req: ScoutAuthRequest, res: Response, next: NextFunction): void {
  const presented = extractPresentedKey(req);
  const record = findApiKey(presented);
  if (!record) {
    res.status(401).json({
      error: 'Invalid or missing Scout API key',
      code: 'UNAUTHORIZED',
      retryable: false,
    });
    return;
  }
  if (
    scoutConfig.deploymentMode === 'hosted'
    && record.tier !== 'internal'
    && record.tier !== 'demo'
    && !record.key.startsWith('sk_scout_')
  ) {
    res.status(401).json({
      error: 'Invalid or missing Scout API key',
      code: 'UNAUTHORIZED',
      retryable: false,
    });
    return;
  }
  req.scoutKey = record;
  const route = `${req.method} ${req.path}`;
  try {
    recordUsage(record.key, route, { label: record.label, tier: record.tier });
  } catch {
    // usage is best-effort
  }
  next();
}

export function scoutRateLimit() {
  const windowMs = 60_000;
  const store = scoutRedisRateLimitStore(windowMs);
  return rateLimit({
    windowMs,
    limit: (req) => {
      const key = (req as ScoutAuthRequest).scoutKey;
      if (!key || key.tier === 'internal') return Number.MAX_SAFE_INTEGER;
      if (key.tier === 'demo') return key.rateLimitPerMinute ?? 12;
      return key.rateLimitPerMinute ?? 30;
    },
    standardHeaders: true,
    legacyHeaders: false,
    ...(store ? { store } : {}),
    keyGenerator: (req) => {
      const auth = req as ScoutAuthRequest;
      return auth.scoutBilling?.userId || auth.scoutKey?.key || req.ip || 'anonymous';
    },
    skip: (req) => (req as ScoutAuthRequest).scoutKey?.tier === 'internal',
    message: { error: 'Rate limit exceeded', code: 'RATE_LIMITED', retryable: true },
    validate: { xForwardedForHeader: false },
  });
}

/** Caps unauthenticated / forged-key probing before platform authorize. */
export function scoutIngressRateLimit() {
  const windowMs = 60_000;
  const store = scoutRedisRateLimitStore(windowMs);
  return rateLimit({
    windowMs,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    ...(store ? { store } : {}),
    keyGenerator: (req) => `ip:${req.ip || 'anonymous'}`,
    message: { error: 'Rate limit exceeded', code: 'RATE_LIMITED', retryable: true },
    validate: { xForwardedForHeader: false },
  });
}

/** evaluate: Pro or internal — never the public marketing demo key */
export function canEvaluate(key: ScoutApiKeyRecord | undefined): boolean {
  return key?.tier === 'internal' || key?.tier === 'enterprise' || key?.tier === 'pro';
}
