import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ExtractField } from '../primitives/extract';

export type ScoutTemplate = {
  id: string;
  owner_key_hash: string;
  slug: string;
  name: string;
  description: string | null;
  /** Optional hostname hint (not enforced as verify). */
  hostname: string | null;
  fields: ExtractField[];
  created_at: string;
  updated_at: string;
};

type StoreFile = { templates: ScoutTemplate[] };

function dataDir(): string {
  return process.env.SCOUT_DATA_DIR || path.join(process.cwd(), 'data');
}

function storePath(): string {
  return path.join(dataDir(), 'templates.json');
}

function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function readStore(): StoreFile {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed.templates || !Array.isArray(parsed.templates)) return { templates: [] };
    return parsed;
  } catch {
    return { templates: [] };
  }
}

function writeStore(store: StoreFile): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

function newId(): string {
  return `tpl_${randomBytes(12).toString('hex')}`;
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

export function listTemplatesForKey(apiKey: string): ScoutTemplate[] {
  const hash = hashApiKey(apiKey);
  return readStore().templates.filter((t) => t.owner_key_hash === hash);
}

export function getTemplateForKey(apiKey: string, idOrSlug: string): ScoutTemplate | null {
  const hash = hashApiKey(apiKey);
  return (
    readStore().templates.find(
      (t) => t.owner_key_hash === hash && (t.id === idOrSlug || t.slug === idOrSlug),
    ) ?? null
  );
}

export function createTemplate(
  apiKey: string,
  input: {
    name: string;
    slug?: string;
    description?: string;
    hostname?: string;
    fields: ExtractField[];
  },
): ScoutTemplate {
  const hash = hashApiKey(apiKey);
  const store = readStore();
  const slug = slugify(input.slug || input.name);
  if (!slug) throw new Error('Invalid template slug');
  if (store.templates.some((t) => t.owner_key_hash === hash && t.slug === slug)) {
    throw new Error(`Template slug already exists: ${slug}`);
  }
  const now = new Date().toISOString();
  const row: ScoutTemplate = {
    id: newId(),
    owner_key_hash: hash,
    slug,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    hostname: input.hostname?.trim().toLowerCase() || null,
    fields: input.fields,
    created_at: now,
    updated_at: now,
  };
  store.templates.push(row);
  writeStore(store);
  return row;
}

export function updateTemplate(
  apiKey: string,
  id: string,
  patch: {
    name?: string;
    slug?: string;
    description?: string | null;
    hostname?: string | null;
    fields?: ExtractField[];
  },
): ScoutTemplate {
  const hash = hashApiKey(apiKey);
  const store = readStore();
  const idx = store.templates.findIndex((t) => t.id === id && t.owner_key_hash === hash);
  if (idx < 0) throw new Error('Template not found');

  if (patch.slug) {
    const slug = slugify(patch.slug);
    if (
      store.templates.some(
        (t) => t.owner_key_hash === hash && t.slug === slug && t.id !== id,
      )
    ) {
      throw new Error(`Template slug already exists: ${slug}`);
    }
    store.templates[idx].slug = slug;
  }
  if (patch.name !== undefined) store.templates[idx].name = patch.name.trim();
  if (patch.description !== undefined) {
    store.templates[idx].description = patch.description?.trim() || null;
  }
  if (patch.hostname !== undefined) {
    store.templates[idx].hostname = patch.hostname?.trim().toLowerCase() || null;
  }
  if (patch.fields) store.templates[idx].fields = patch.fields;
  store.templates[idx].updated_at = new Date().toISOString();
  writeStore(store);
  return store.templates[idx];
}

export function deleteTemplate(apiKey: string, id: string): boolean {
  const hash = hashApiKey(apiKey);
  const store = readStore();
  const before = store.templates.length;
  store.templates = store.templates.filter((t) => !(t.id === id && t.owner_key_hash === hash));
  if (store.templates.length === before) return false;
  writeStore(store);
  return true;
}

export function serializeTemplate(t: ScoutTemplate) {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    hostname: t.hostname,
    fields: t.fields,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}
