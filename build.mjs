import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const path of ['index.html', 'styles.css', 'main.js', 'page-model.js', 'vendor']) {
  cpSync(resolve(root, path), resolve(dist, path), { recursive: true });
}
console.log('Static site built in dist/');
