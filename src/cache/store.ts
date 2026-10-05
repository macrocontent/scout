import { createHash } from 'crypto';
import { scoutConfig } from '../config';

export type CacheStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
};

class MemoryCacheStore implements CacheStore {
  private map = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const row = this.map.get(key);
    if (!row) return null;
    if (Date.now() > row.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return row.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000 });
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class RedisCacheStore implements CacheStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private client: any) {}

  async get(key: string): Promise<string | null> {
    const v = await this.client.get(key);
    return typeof v === 'string' ? v : null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', Math.max(1, ttlSeconds));
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

let storePromise: Promise<CacheStore> | null = null;

export async function getCacheStore(): Promise<CacheStore> {
  if (!storePromise) {
    storePromise = (async () => {
      if (!scoutConfig.redisUrl) return new MemoryCacheStore();
      try {
        const Redis = (await import('ioredis')).default;
        const client = new Redis(scoutConfig.redisUrl, {
          maxRetriesPerRequest: 1,
          lazyConnect: true,
        });
        await client.connect();
        console.log('[scout] cache: redis');
        return new RedisCacheStore(client);
      } catch (err) {
        console.warn('[scout] redis unavailable, falling back to memory cache', err);
        return new MemoryCacheStore();
      }
    })();
  }
  return storePromise;
}

export function cacheKey(parts: Array<string | number | boolean | null | undefined>): string {
  const raw = parts.map((p) => String(p ?? '')).join('|');
  return `scout:${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
}

const inflight = new Map<string, Promise<unknown>>();

/**
 * Operational dedup: identical work coalesces; optional short TTL result cache.
 * Not a content archive — TTL is seconds/minutes only.
 */
export async function getOrCompute<T>(options: {
  key: string;
  ttlSeconds?: number;
  bypassCache?: boolean;
  compute: () => Promise<T>;
}): Promise<{ value: T; cache: 'HIT' | 'MISS' | 'COALESCE' }> {
  const ttl = options.ttlSeconds ?? scoutConfig.resultCacheTtlSeconds;
  const store = await getCacheStore();

  if (!options.bypassCache && ttl > 0) {
    const cached = await store.get(options.key);
    if (cached) {
      try {
        return { value: JSON.parse(cached) as T, cache: 'HIT' };
      } catch {
        await store.del(options.key);
      }
    }
  }

  const existing = inflight.get(options.key);
  if (existing) {
    const value = (await existing) as T;
    return { value, cache: 'COALESCE' };
  }

  const promise = (async () => {
    const value = await options.compute();
    if (!options.bypassCache && ttl > 0) {
      try {
        await store.set(options.key, JSON.stringify(value), ttl);
      } catch {
        // ignore cache write errors
      }
    }
    return value;
  })();

  inflight.set(options.key, promise);
  try {
    const value = await promise;
    return { value, cache: 'MISS' };
  } finally {
    inflight.delete(options.key);
  }
}
