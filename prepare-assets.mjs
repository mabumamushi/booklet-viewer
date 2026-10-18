import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const from = resolve(root, 'node_modules/pdfjs-dist');
const to = resolve(root, 'vendor');
mkdirSync(to, { recursive: true });
for (const [source, target] of [
  ['build/pdf.min.mjs', 'pdf.min.mjs'],
  ['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['LICENSE', 'PDFJS-LICENSE.txt'],
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
]) {
  cpSync(resolve(from, source), resolve(to, target), { recursive: true, force: true });
}
console.log('PDF.js assets copied to vendor/');
