import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'skill');
const dest = join(root, 'dist', 'skill');
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`copied skill/ → ${dest}`);
