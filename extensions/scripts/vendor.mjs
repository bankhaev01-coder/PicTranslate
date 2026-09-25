#!/usr/bin/env node
/**
 * Собирает необязательный полностью офлайновый пакет ассетов в extensions/public/:
 *   public/tessdata/*.traineddata.gz  — языковые пакеты tesseract
 *   public/tesseract/                 — tesseract.js worker + ВСЕ сборки core
 *   public/ort/                       — ONNX Runtime Web wasm/mjs (CPU)
 *   public/models/<repo>/…            — opus-mt (q8) ONNX + файлы токенизатора
 *   public/vendor.json                — манифест, который находит расширение
 *
 * Использование:  cd extensions && npm run vendor && npm run build
 * Идемпотентно: уже скачанные файлы пропускаются.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const require = createRequire(path.join(ROOT, 'package.json'));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/local/registry.json'), 'utf8'));
const execFileAsync = promisify(execFile);
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
const MODEL_HOST = process.env.TRANSLATE_MODEL_HOST || 'https://hf.rimuru.work';
const MODEL_REVISION = 'main';
const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.json',
  'source.spm',
  'target.spm',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

let total = 0;
const modelMetadataCache = new Map();
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function accountDownload(dest) {
  const n = fs.statSync(dest).size;
  total += n;
  console.log(`  + ${path.relative(ROOT, dest)} (${mb(n)})`);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertExpectedFile(file, expected) {
  const stat = fs.statSync(file);
  if (expected.size != null && stat.size !== expected.size) {
    throw new Error(`size mismatch: expected ${expected.size}, got ${stat.size}`);
  }
  if (expected.sha256 && sha256File(file) !== expected.sha256) {
    throw new Error(`sha256 mismatch for ${file}`);
  }
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`missing source file: ${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  accountDownload(dest);
}

async function fetchBuffer(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'translate-ext-vendor' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function curlBuffer(url, timeoutSeconds, maxBuffer = 4 * 1024 * 1024) {
  const { stdout } = await execFileAsync(
    CURL,
    [
      '--location',
      '--fail',
      '--silent',
      '--show-error',
      '--retry',
      '2',
      '--connect-timeout',
      '30',
      '--max-time',
      String(timeoutSeconds),
      url,
    ],
    { windowsHide: true, maxBuffer, encoding: 'utf8' },
  );
  return Buffer.from(stdout);
}

async function curlDownload(url, dest) {
  const temp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(temp, { force: true });
  await execFileAsync(
    CURL,
    [
      '--location',
      '--fail',
      '--silent',
      '--show-error',
      '--retry',
      '2',
      '--connect-timeout',
      '30',
      '--max-time',
      '1800',
      '--output',
      temp,
      url,
    ],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (!fs.existsSync(temp) || fs.statSync(temp).size === 0) {
    fs.rmSync(temp, { force: true });
    throw new Error('curl returned an empty file');
  }
  fs.renameSync(temp, dest);
}

async function getText(url) {
  try {
    return (await fetchBuffer(url, 60_000)).toString('utf8');
  } catch (fetchError) {
    try {
      return (await curlBuffer(url, 90)).toString('utf8');
    } catch (curlError) {
      throw new Error(`${fetchError instanceof Error ? fetchError.message : fetchError}; ${curlError instanceof Error ? curlError.message : curlError}`);
    }
  }
}

function modelUrl(model, file) {
  return `${MODEL_HOST.replace(/\/$/, '')}/${model}/resolve/${MODEL_REVISION}/${file}`;
}

async function getExpectedModelFile(model, file) {
  if (!modelMetadataCache.has(model)) {
    const metadataUrl = `https://modelscope.cn/api/v1/models/${model}/repo/files?Revision=master&Recursive=true`;
    modelMetadataCache.set(model, getText(metadataUrl).then((text) => {
      const payload = JSON.parse(text);
      return new Map((payload?.Data?.Files ?? []).map((item) => [item.Path, item]));
    }));
  }
  const metadata = await modelMetadataCache.get(model);
  const entry = metadata.get(file);
  if (!entry) throw new Error(`metadata missing ${model}/${file}`);
  return { size: Number(entry.Size), sha256: String(entry.Sha256 || '').toLowerCase() };
}

async function download(url, dest, expected = null) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    try {
      if (expected) assertExpectedFile(dest, expected);
      accountDownload(dest);
      return;
    } catch (error) {
      console.log(`  ! replace invalid ${path.relative(ROOT, dest)} (${error.message})`);
      fs.rmSync(dest, { force: true });
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.part`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    fs.rmSync(temp, { force: true });
    try {
      await curlDownload(url, temp);
      if (expected) assertExpectedFile(temp, expected);
      fs.renameSync(temp, dest);
      accountDownload(dest);
      return;
    } catch (error) {
      lastErr = error;
      fs.rmSync(temp, { force: true });
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw new Error(`${url} — ${lastErr?.message ?? 'download failed'}`);
}

async function main() {
  // 1) ассеты tesseract.js (из node_modules, без сети)
  console.log('\n[1/4] tesseract.js assets');
  const tesseractDir = path.dirname(require.resolve('tesseract.js/package.json'));
  const coreDir = path.dirname(require.resolve('tesseract.js-core/package.json'));
  copyFile(path.join(tesseractDir, 'dist/worker.min.js'), path.join(PUBLIC, 'tesseract/worker.min.js'));
  for (const f of fs.readdirSync(coreDir)) {
    if (f.startsWith('tesseract-core') && (f.endsWith('.js') || f.endsWith('.wasm'))) {
      copyFile(path.join(coreDir, f), path.join(PUBLIC, 'tesseract', f));
    }
  }

  // 2) wasm ONNX Runtime (пара CPU asyncify, на которую ссылается встроенный воркер)
  console.log('\n[2/4] onnxruntime-web wasm');
  let ortDist;
  try {
    ortDist = path.dirname(require.resolve('onnxruntime-web'));
  } catch {
    ortDist = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
  }
  if (!fs.existsSync(path.join(ortDist, 'ort-wasm-simd-threaded.wasm'))) {
    ortDist = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
  }
  const ortFiles = fs.readdirSync(ortDist).filter((f) =>
    /^ort-wasm-simd-threaded(\.asyncify)?\.(mjs|wasm)$/.test(f),
  );
  if (!ortFiles.length) throw new Error('no ort-wasm files found in onnxruntime-web/dist');
  for (const f of ortFiles) copyFile(path.join(ortDist, f), path.join(PUBLIC, 'ort', f));

  // 3) языковые пакеты tesseract (несколько зеркал, первый 200 побеждает)
  console.log('\n[3/4] tessdata');
  const mirrors = [
    (lang) => `https://tessdata.projectnaptha.com/4.0.0_best/${lang}.traineddata.gz`,
    (lang) => `https://tessdata.projectnaptha.com/4.0.0/${lang}.traineddata.gz`,
    (lang) => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best/${lang}.traineddata.gz`,
    (lang) => `https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_best/${lang}.traineddata.gz`,
  ];
  for (const lang of registry.ocrLangs) {
    const dest = path.join(PUBLIC, 'tessdata', `${lang.id}.traineddata.gz`);
    let ok = false;
    for (const mirror of mirrors) {
      try {
        await download(mirror(lang.id), dest);
        ok = true;
        break;
      } catch (e) {
        console.log(`    · skip ${mirror(lang.id)} (${e.message})`);
      }
    }
    if (!ok) throw new Error(`cannot download traineddata for '${lang.id}'`);
  }

  // 4) модели opus-mt. ModelScope отдаёт неизменяемые размер/SHA-256;
  // MODEL_HOST — лишь прокси загрузки, в runtime к нему не обращаются.
  console.log('\n[4/4] opus-mt models (ONNX q8, verified)');
  for (const pair of registry.pairs) {
    console.log(`  — ${pair.id} (${pair.model})`);
    for (const file of MODEL_FILES) {
      const expected = await getExpectedModelFile(pair.model, file);
      await download(
        modelUrl(pair.model, file),
        path.join(PUBLIC, 'models', pair.model, file),
        expected,
      );
    }
  }

  const manifest = {
    version: 1,
    baseUrl: '',
    pairs: registry.pairs.map((p) => p.id),
    ocrLangs: registry.ocrLangs.map((l) => l.id),
    tesseract: true,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(PUBLIC, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC, 'vendor.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nvendor.json written. TOTAL ≈ ${mb(total)} in public/`);
  console.log('Rebuild: npm run build   (public/ is copied into dist/).');
}

main().catch((e) => {
  console.error('\nVENDOR FAILED:', e.message);
  process.exit(1);
});
