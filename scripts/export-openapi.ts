/**
 * Export Scout OpenAPI JSON into apps/docs/public/openapi/scout.json
 * Run: pnpm --filter macro-scout openapi:export
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoutOpenApiSpec } from '../src/openapi/spec';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, '../../docs/public/openapi/scout.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(scoutOpenApiSpec, null, 2)}\n`);
console.log(`[scout] wrote ${out}`);
