import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc only emits JavaScript; the schema and any incremental migrations are SQL
// files that must ship alongside it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src', 'db');
const to = path.join(root, 'dist', 'db');

mkdirSync(to, { recursive: true });
cpSync(path.join(from, 'schema.sql'), path.join(to, 'schema.sql'));
if (existsSync(path.join(from, 'migrations'))) {
  cpSync(path.join(from, 'migrations'), path.join(to, 'migrations'), { recursive: true });
}
console.log('Copied SQL assets to dist/db');
