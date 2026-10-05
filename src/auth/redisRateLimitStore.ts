import type { Store } from 'express-rate-limit';
import Redis from 'ioredis';
import { scoutConfig } from '../config';

let redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = scoutConfig.redisUrl;
  if (!url) {
    redis = null;
    return null;
  }
  try {
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectTimeout: 2_000,
      lazyConnect: false,
    });
    client.on('error', (err) => {
      console.warn('[scout] rate-limit redis', err.message);
    });
    redis = client;
    return redis;
  } catch {
    redis = null;
    return null;
  }
}

type Hit = { totalHits: number; resetTime: Date };

/**
 * Shared Scout Redis counters (`scout:rl:*`). Falls back to undefined so
 * express-rate-limit uses its in-memory store.
 */
export function scoutRedisRateLimitStore(windowMs: number): Store | undefined {
  const client = getRedis();
  if (!client) return undefined;

  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));

  return {
    async increment(key: string): Promise<Hit> {
      const redisKey = `scout:rl:${key}`;
      const count = await client.incr(redisKey);
      if (count === 1) await client.expire(redisKey, windowSec);
      const ttl = await client.ttl(redisKey);
      const resetTime = new Date(Date.now() + Math.max(ttl, 1) * 1000);
      return { totalHits: count, resetTime };
    },
    async decrement(key: string): Promise<void> {
      await client.decr(`scout:rl:${key}`).catch(() => undefined);
    },
    async resetKey(key: string): Promise<void> {
      await client.del(`scout:rl:${key}`).catch(() => undefined);
    },
  };
}
