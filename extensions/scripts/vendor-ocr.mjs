#!/usr/bin/env node
/** Small local OCR pack, without Opus-MT weights. Text MT remains opt-in/network.
 * Run: npm run vendor:ocr && npm run build. Existing NMT assets are preserved.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public');
const require = createRequire(path.join(root, 'package.json'));
const worker = path.dirname(require.resolve('tesseract.js/package.json'));
const core = path.dirname(require.resolve('tesseract.js-core/package.json'));
await fs.mkdir(path.join(out, 'tesseract'), { recursive: true });
await fs.mkdir(path.join(out, 'tessdata'), { recursive: true });
await fs.copyFile(path.join(worker, 'dist/worker.min.js'), path.join(out, 'tesseract/worker.min.js'));
for (const kind of ['relaxedsimd-lstm', 'simd-lstm', 'lstm']) {
  for (const suffix of ['.wasm.js', '.wasm']) {
    const name = `tesseract-core-${kind}${suffix}`;
    await fs.copyFile(path.join(core, name), path.join(out, 'tesseract', name));
  }
}
for (const [dir, name] of [[worker, 'LICENSE'], [core, 'LICENSE']]) {
  try { await fs.copyFile(path.join(dir, name), path.join(out, 'tesseract', dir === worker ? 'LICENSE-tesseract.js' : 'LICENSE-core')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const languages = ['eng', 'rus'];
for (const lang of languages) {
  const target = path.join(out, 'tessdata', `${lang}.traineddata.gz`);
  let bytes;
  try { bytes = await fs.readFile(target); gunzipSync(bytes); }
  catch {
    const url = 'https://' + 'tessdata.projectnaptha.com/4.0.0_best/' + lang + '.traineddata.gz';
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`tessdata ${lang}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    gunzipSync(bytes); // reject HTML, empty/truncated gzips before committing a file
    await fs.writeFile(target, bytes);
  }
  console.log(`OCR ${lang}: ${(bytes.length / 1048576).toFixed(1)} MiB`);
}
let previous = {};
try { previous = JSON.parse(await fs.readFile(path.join(out, 'vendor.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await fs.writeFile(path.join(out, 'vendor.json'), JSON.stringify({
  ...previous, version: 1, baseUrl: '', pairs: previous.pairs ?? [],
  ocrLangs: [...new Set([...(previous.ocrLangs ?? []), ...languages])],
  tesseract: true, createdAt: new Date().toISOString(),
}, null, 2));
console.log('OCR pack ready. No local NMT models downloaded. Use external text MT or AI explicitly.');
