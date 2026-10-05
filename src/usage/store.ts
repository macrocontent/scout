import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export type UsageCounters = {
  key_hash: string;
  label?: string;
  tier?: string;
  total_requests: number;
  by_route: Record<string, number>;
  updated_at: string;
};

type UsageFile = { keys: Record<string, UsageCounters> };

function dataDir(): string {
  return process.env.SCOUT_DATA_DIR || path.join(process.cwd(), 'data');
}

function storePath(): string {
  return path.join(dataDir(), 'usage.json');
}

function readStore(): UsageFile {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as UsageFile;
    if (!parsed.keys || typeof parsed.keys !== 'object') return { keys: {} };
    return parsed;
  } catch {
    return { keys: {} };
  }
}

function writeStore(store: UsageFile): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

export function hashKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export function recordUsage(apiKey: string, route: string, meta?: { label?: string; tier?: string }): void {
  const keyHash = hashKey(apiKey);
  const store = readStore();
  const row = store.keys[keyHash] ?? {
    key_hash: keyHash,
    total_requests: 0,
    by_route: {},
    updated_at: new Date().toISOString(),
  };
  row.total_requests += 1;
  row.by_route[route] = (row.by_route[route] ?? 0) + 1;
  row.updated_at = new Date().toISOString();
  if (meta?.label) row.label = meta.label;
  if (meta?.tier) row.tier = meta.tier;
  store.keys[keyHash] = row;
  writeStore(store);
}

export function getUsageForKey(apiKey: string): UsageCounters | null {
  const keyHash = hashKey(apiKey);
  return readStore().keys[keyHash] ?? null;
}
