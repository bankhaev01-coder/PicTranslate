// E2E-стенд: реальная страница MangaDex в Edge/Chrome с unpacked-расширением.
//
// Запуск:  node extensions/scripts/e2e-mangadex.mjs
//   • нужен playwright-core; путь — env E2E_PLAYWRIGHT или дефолт из npx-кэша ниже;
//   • что проверяет: SCAN_TAB → оверлей → режим выделения → drag областей → Enter →
//     локальный EN→RU (OCR + opus-mt, офлайн) → плашки с кириллицей → повторный
//     Enter (без дублей) → Esc (сброс);
//   • особенности стенда:
//     – %TEMP%\ext-e2e\ext — копия extensions/dist/chrome-mv3 (копируется сама),
//       в её manifest добавляется <all_urls>: автоматизация не может воспроизвести
//       activeTab-жест от клика по иконке, а captureVisibleTab требует
//       <all_urls>/activeTab;
//     – закрытый shadow root оверлея открывается CDP-патчем
//       Element.prototype.attachShadow в изолированном мире расширения
//       (addInitScript патчит только main world);
//     – coords.json (опционально, в %TEMP%\ext-e2e) — свои области:
//       { "regions": [{ "x1": 0, "y1": 0, "x2": 0, "y2": 0 }] };
//     – env-ручки отладки: E2E_PAGE_START=N — открыть главу сразу на странице N
//       (обложка = стр. 1, контентные страницы с английскими пузырями — дальше),
//       E2E_NO_ENTER=1 — dry-run: набрать области и остановиться до перевода,
//       E2E_CLOUD=ocr|full — включить облачный OCR выделенных областей
//       (backenster parseImage, способ uLanguage); 'full' — и серверный перевод.
// Артефакты: %TEMP%\ext-e2e\out\ (run.log, скриншоты, result.json).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const TMP = path.join(os.tmpdir(), 'ext-e2e');
const EXT = path.join(TMP, 'ext');
const PROFILE = path.join(TMP, 'profile');
const OUT = path.join(TMP, 'out');
const COORDS_FILE = path.join(TMP, 'coords.json');
const DIST = fileURLToPath(new URL('../dist/chrome-mv3/', import.meta.url));
const PW = process.env.E2E_PLAYWRIGHT ?? 'file:///C:/Users/bankh/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
const { chromium } = await import(PW);

fs.mkdirSync(OUT, { recursive: true });
const logFile = path.join(OUT, 'run.log');
fs.writeFileSync(logFile, '');
const log = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(s);
  fs.appendFileSync(logFile, s + '\n');
};
const save = (name, data) =>
  fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

/* Каталог расширения для --load-extension: копируется из dist при первом
 * запуске и обновляется при рассинхроне (иначе E2E молча гоняет старую сборку). */
function distStamp() {
  const stampOf = (root) => {
    try {
      const mf = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
      const html = fs.readFileSync(path.join(root, 'offscreen.html'), 'utf8');
      return `${mf.length}:${html.length}:${html.slice(0, 400)}`;
    } catch {
      return 'missing';
    }
  };
  return stampOf(DIST);
}
const EXT_STAMP_FILE = path.join(TMP, 'ext.stamp');
const curStamp = distStamp();
let savedStamp = '';
try {
  savedStamp = fs.readFileSync(EXT_STAMP_FILE, 'utf8');
} catch {
  /* первого запуска ещё не было */
}
if (!fs.existsSync(path.join(EXT, 'manifest.json')) || savedStamp !== curStamp) {
  log('копирую dist →', EXT);
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.cpSync(DIST, EXT, { recursive: true });
  fs.writeFileSync(EXT_STAMP_FILE, curStamp);
} else {
  log('тестовая копия актуальна, копирование пропущено');
}

/* ── тестовая копия манифеста: <all_urls> вместо activeTab-жеста ──
 * Прод-путь: activeTab выдаётся кликом по иконке (автоматизация не может его
 * воспроизвести). captureVisibleTab требует именно <all_urls>/activeTab. */
const mfPath = path.join(EXT, 'manifest.json');
const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
mf.host_permissions = [...new Set([...(mf.host_permissions ?? []), '<all_urls>'])];
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

fs.rmSync(PROFILE, { recursive: true, force: true });

const snap = (page) =>
  page.evaluate(() => {
    const sr = document.getElementById('translate-ext-overlay-host')?.shadowRoot;
    if (!sr) return { found: false };
    return {
      found: true,
      rows: sr.querySelectorAll('.row').length,
      progress: sr.querySelector('.progress')?.textContent ?? '',
      selCount: sr.querySelector('.sel-count')?.textContent ?? '',
      selLayer: !!sr.querySelector('.sel-layer'),
      marks: sr.querySelectorAll('.region-mark').length,
      plates: [...sr.querySelectorAll('.region-plate-text')].map((e) => e.textContent),
      selBtns: [...sr.querySelectorAll('.sel-actions .btn')].map((b) => `${b.textContent}:${b.disabled ? 'off' : 'on'}`),
    };
  });

const consoleLog = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) failures++;
};

const wirePage = (p) => {
  p.on('console', (m) => consoleLog.push(`[page] ${m.type()}: ${m.text().slice(0, 300)}`));
  p.on('pageerror', (e) => consoleLog.push(`[pageerror] ${e.message.slice(0, 300)}`));
};

let ctx = null;
for (const channel of [process.env.E2E_CHANNEL ?? 'msedge', 'chrome']) {
  try {
    ctx = await chromium.launchPersistentContext(path.join(PROFILE, channel), {
      channel,
      headless: false,
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--force-device-scale-factor=1',
      ],
    });
    log('browser launched:', channel);
    break;
  } catch (e) {
    log('launch failed on', channel, ':', String(e).slice(0, 160));
  }
}
if (!ctx) { log('FATAL: browser launch failed'); process.exit(2); }

try {
  ctx.setDefaultTimeout(30000);
  await ctx.addInitScript(() => {
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      if (init && init.mode === 'closed') init = { ...init, mode: 'open' };
      return orig.call(this, init);
    };
  });
  ctx.on('page', wirePage);
  ctx.on('serviceworker', (w) => w.on('console', (m) => consoleLog.push(`[sw] ${m.type()}: ${m.text().slice(0, 300)}`)));
  ctx.pages().forEach(wirePage);

  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 30000 }));
  const extId = new URL(sw.url()).host;
  log('extension id:', extId);

  /* 1. глава MangaDex через официальный API */
  const api = await ctx.newPage();
  const navJson = async (url) => {
    await api.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const text = await api.evaluate(() => document.body?.innerText ?? '');
    try { return JSON.parse(text); } catch { throw new Error(`API не JSON: ${url} :: ${text.slice(0, 120)}`); }
  };
  const mangaList = await navJson('https://api.mangadex.org/manga?limit=6&order[followedCount]=desc&contentRating[]=safe&hasAvailableChapters=true');
  let chapter = null;
  let mangaId = null;
  let mangaTitle = null;
  for (const m of mangaList.data) {
    let feed;
    try {
      feed = await navJson(`https://api.mangadex.org/manga/${m.id}/feed?limit=40&translatedLanguage[]=en&order[chapter]=desc&contentRating[]=safe`);
    } catch (e) {
      log('feed skip:', m.id, String(e).slice(0, 90));
      continue;
    }
    const c = feed.data.find((x) => !x.attributes.externalUrl && (x.attributes.pages ?? 0) > 8);
    if (c) { chapter = c; mangaId = m.id; mangaTitle = m.attributes.title?.en ?? m.id; break; }
  }
  if (!chapter) throw new Error('не нашёл главу с внутренними страницами (все внешние?)');
  const chapterUrl = `https://mangadex.org/chapter/${chapter.id}`;
  log('manga:', mangaTitle, '| ch.', chapter.attributes.chapter, `| pages: ${chapter.attributes.pages}`, '|', chapterUrl);
  await api.close();

  /* 2. страница главы: крупные страницы манги в DOM */
  const md = await ctx.newPage();
  /* CDP: патч attachShadow в изолированном мире расширения (main world патчит addInitScript). */
  const worldIds = new Set();
  const cdp = await md.context().newCDPSession(md);
  const PATCH = "(() => { const o = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { if (i && i.mode === 'closed') i = Object.assign({}, i, { mode: 'open' }); return o.call(this, i); }; return 'patched'; })()";
  const patchWorld = async (ctxId, tag) => {
    try {
      const r = await cdp.send('Runtime.evaluate', { contextId: ctxId, expression: PATCH, returnByValue: true });
      log('shadow-patch:', tag, '→', r?.result?.value ?? r?.exceptionDetails?.text ?? 'no-result');
    } catch (e) { log('shadow-patch failed:', tag, String(e).slice(0, 120)); }
  };
  const repatchAll = async () => { for (const id of worldIds) await patchWorld(id, 're'); };
  cdp.on('Runtime.executionContextCreated', (ev) => {
    const c = ev.context ?? {};
    if ((c.auxData ?? {}).isDefault) return;
    worldIds.add(c.id);
    void patchWorld(c.id, c.name || c.origin || String(c.id));
  });
  await cdp.send('Runtime.enable');
  const startPage = Math.max(1, Number(process.env.E2E_PAGE_START ?? 1));
  const openUrl = startPage > 1 ? `${chapterUrl}/${startPage}` : chapterUrl;
  await md.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await md.waitForTimeout(3000);
  const early = await md.evaluate(() => (document.body?.innerText ?? '').slice(0, 120).replace(/\s+/g, ' '));
  if (/just a moment|checking your browser/i.test(early)) throw new Error('Cloudflare challenge');
  const bigCount = () => md.evaluate(() => [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 600 && i.naturalHeight > 600 && !/\.svg/i.test(i.currentSrc || i.src || '')).length);
  let n = await bigCount();
  for (let i = 0; n < 4 && i < 12; i++) {
    await md.evaluate((k) => window.scrollTo(0, k * 800), i + 1);
    await md.waitForTimeout(1000);
    n = await bigCount();
  }
  const imgStats = await md.evaluate(() => [...document.images].slice(0, 12).map((i) => ({ nw: i.naturalWidth, nh: i.naturalHeight, src: (i.currentSrc || i.src || '').slice(0, 50) })));
  log('img stats:', JSON.stringify(imgStats));
  check('страницы манги загружены', n >= 3, `big imgs=${n}`);
  const target = await md.evaluate((skipScroll) => {
    const F = (i) => i.naturalWidth > 600 && i.naturalHeight > 600 && !/\.svg/i.test(i.currentSrc || i.src || '');
    const pool = [...document.querySelectorAll('img')].filter(F);
    const el = pool[Math.min(2, pool.length - 1)];
    if (!el) return null;
    if (!skipScroll) el.scrollIntoView({ block: 'center' });
    return { count: pool.length, w: el.naturalWidth, h: el.naturalHeight };
  }, startPage > 1);
  await md.waitForTimeout(900);
  check('целевая страница манги найдена', !!target, JSON.stringify(target));

  /* 3. настройки: офлайновый конвейер, EN→RU */
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'domcontentloaded' });
  const applied = await opt.evaluate(async ({ quality, cloud }) => {
    const key = 'translateExt.settings';
    const cur = (await chrome.storage.local.get(key))[key] ?? {};
    const next = { ...cur, engine: 'local', uiLang: 'en', targetLang: 'ru', sourceLang: 'auto', ocrLangs: ['eng'], ocrQuality: 'balanced', mtPair: 'en-ru', externalMt: 'off', useNativeHost: false, translateConcurrency: 1, bubbleShape: 'oval', minImageSize: 96, ocrMinConfidence: 40, cloudOcr: cloud === 'ocr' || cloud === 'full', cloudTranslate: cloud === 'full', ...(quality ? { ocrQuality: quality } : {}) };
    await chrome.storage.local.set({ [key]: next });
    return next;
  }, { quality: process.env.E2E_QUALITY ?? '', cloud: process.env.E2E_CLOUD ?? '' });
  log('settings:', JSON.stringify({ engine: applied.engine, ocrLangs: applied.ocrLangs, mtPair: applied.mtPair, ext: applied.externalMt, cloudOcr: applied.cloudOcr, cloudTranslate: applied.cloudTranslate }));

  /* 4. прод-путь: SCAN_TAB → background → executeScript → SCAN_IMAGES */
  const tScan = Date.now();
  const scan = await opt.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://mangadex.org/*' });
    if (!tab) return { error: 'mangadex tab not found' };
    return await chrome.runtime.sendMessage({ type: 'SCAN_TAB', tabId: tab.id });
  });
  log(`SCAN_TAB → ${JSON.stringify(scan)} (${Date.now() - tScan} ms)`);
  check('скан вкладки прошёл', scan?.ok === true, JSON.stringify(scan));
  await md.bringToFront();
  await md.locator('#translate-ext-overlay-host').waitFor({ state: 'attached', timeout: 20000 });
  let s = await snap(md);
  if (!s.found) {
    log('shadowRoot закрыт — перепатчиваю изолированные миры и пересканирую');
    await repatchAll();
    await opt.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://mangadex.org/*' });
      await chrome.runtime.sendMessage({ type: 'CLEAR_OVERLAY', tabId: tab.id });
      await chrome.runtime.sendMessage({ type: 'SCAN_TAB', tabId: tab.id });
    });
    await md.waitForTimeout(1500);
    s = await snap(md);
  }
  check('оверлей отрисован', s.found, JSON.stringify({ rows: s.rows, progress: s.progress }));
  log('after scan:', JSON.stringify(s));
  await md.screenshot({ path: path.join(OUT, '01-scan.png') });

  /* 5. режим выделения */
  const clicked = await md.evaluate(() => {
    const sr = document.getElementById('translate-ext-overlay-host').shadowRoot;
    const btn = [...sr.querySelectorAll('.panel .btn')].find((b) => /select area/i.test(b.textContent));
    btn?.click();
    return !!btn;
  });
  check('клик «Select area»', clicked);
  s = await snap(md);
  check('слой выделения активен', s.selLayer);

  /* 6. области: coords.json или сетка 2×2 по видимой части страницы */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const geoFn = () => {
    const sr = document.getElementById('translate-ext-overlay-host')?.shadowRoot;
    const pr = sr?.querySelector('.panel')?.getBoundingClientRect?.() ?? null;
    const F = (i) => i.naturalWidth > 600 && i.naturalHeight > 600 && !/\.svg/i.test(i.currentSrc || i.src || '');
    const all = [...document.querySelectorAll('img')].filter(F);
    const rectOf = (i) => {
      const r = i.getBoundingClientRect();
      return r.width > 200 && r.height > 200 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth ? r : null;
    };
    const best = all.map((i) => ({ r: rectOf(i) })).filter((x) => x.r).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    if (!best) {
      const fb = all[Math.min(1, all.length - 1)];
      if (fb) fb.scrollIntoView({ block: 'center' });
      return { scrolled: true, count: all.length };
    }
    const r = best.r;
    return {
      panel: pr ? { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height) } : null,
      img: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      area: { left: Math.max(r.left, 8), right: Math.min(r.right, innerWidth - 8), top: Math.max(r.top, 8), bottom: Math.min(r.bottom, innerHeight - 8) },
    };
  };
  let geo = null;
  for (let k = 0; k < 4; k++) {
    geo = await md.evaluate(geoFn);
    if (geo && !geo.scrolled) break;
    log('geo: подвожу страницу манги во вьюпорт, попытка', k + 1, JSON.stringify(geo));
    await md.waitForTimeout(900);
  }
  check('видимая часть страницы определена', !!geo && !geo.scrolled && geo.area.right - geo.area.left > 100 && geo.area.bottom - geo.area.top > 100, JSON.stringify(geo?.area ?? geo));
  save('geometry.json', geo);
  if (!geo || geo.scrolled) throw new Error(`страница манги не во вьюпорте: ${JSON.stringify(geo)}`);
  let fileRegions = null;
  try { fileRegions = JSON.parse(fs.readFileSync(COORDS_FILE, 'utf8')); } catch { /* нет файла — сетка */ }
  let regions;
  if (Array.isArray(fileRegions?.regions) && fileRegions.regions.length) {
    regions = fileRegions.regions;
    log('области из coords.json');
  } else {
    const { left, right, top, bottom } = geo.area;
    const W = right - left, H = bottom - top;
    regions = [[0.04, 0.03, 0.48, 0.30], [0.52, 0.03, 0.96, 0.30], [0.04, 0.36, 0.48, 0.64], [0.52, 0.36, 0.96, 0.64]]
      .map(([a, b, c, d]) => ({ x1: left + W * a, y1: top + H * b, x2: left + W * c, y2: top + H * d }));
    log('области: сетка 2×2 по видимой части');
  }
  regions = regions
    .map((r) => ({ x1: clamp(r.x1, 4, 1276), y1: clamp(r.y1, 4, 896), x2: clamp(r.x2, 8, 1276), y2: clamp(r.y2, 8, 896) }))
    .filter((r) => r.x2 - r.x1 > 12 && r.y2 - r.y1 > 12);
  save('regions.json', { geo, regions });
  if (!regions.length) throw new Error(`области не сформированы: area=${JSON.stringify(geo?.area)}`);
  for (const r of regions) {
    await md.mouse.move(r.x1, r.y1);
    await md.mouse.down();
    await md.mouse.move(r.x2, r.y2, { steps: 10 });
    await md.mouse.up();
    await md.waitForTimeout(300);
  }
  s = await snap(md);
  check('области набраны', s.marks === regions.length, `marks=${s.marks}/${regions.length} ${s.selCount}`);
  await md.screenshot({ path: path.join(OUT, '02-regions.png') });

  /* 7. Enter → перевод; ждём плашки со всех областей (E2E_NO_ENTER=1 — dry-run) */
  if (process.env.E2E_NO_ENTER === '1') {
    log('E2E_NO_ENTER=1 — dry-run: остановился на выделении областей, перевод не запускаю');
  } else {
  await md.bringToFront();
  await md.mouse.click(40, 300); // нейтральный клик: фокус на body, мимо панели (0-размер области игнорируется)
  await md.evaluate(() => {
    window.__e2eKeys = { capture: [], bubble: [] };
    window.addEventListener('keydown', (e) => window.__e2eKeys.capture.push(e.key), true);
    window.addEventListener('keydown', (e) => window.__e2eKeys.bubble.push(e.key), false);
  });
  const t0 = Date.now();
  await md.keyboard.press('Enter');
  await md.waitForTimeout(500);
  let busy = await snap(md);
  const probe = await md.evaluate(() => ({
    keys: window.__e2eKeys,
    active: `${document.activeElement?.tagName}.${document.activeElement?.className || ''}`,
  }));
  log('Enter probe:', JSON.stringify(probe));
  const enterWorked = busy.selBtns.some((b) => /translate selected/i.test(b) && b.endsWith(':off')) || busy.plates.length > 0;
  check('Enter запускает перевод (кнопка блокируется)', enterWorked, JSON.stringify(busy.selBtns));
  if (!enterWorked) {
    log('Enter не сработал — фолбэк: клик по кнопке «Translate selected»');
    await md.evaluate(() => {
      const sr = document.getElementById('translate-ext-overlay-host').shadowRoot;
      const btn = [...sr.querySelectorAll('.sel-actions .btn')].find((b) => /translate selected/i.test(b.textContent));
      btn?.click();
    });
    await md.waitForTimeout(500);
    busy = await snap(md);
    check('фолбэк-клик запускает перевод', busy.selBtns.some((b) => /translate selected/i.test(b) && b.endsWith(':off')) || busy.plates.length > 0, JSON.stringify(busy.selBtns));
  }
  let firstPlateMs = null;
  for (let i = 0; i < 150; i++) {
    await md.waitForTimeout(2000);
    s = await snap(md);
    if (s.plates.length && firstPlateMs === null) { firstPlateMs = Date.now() - t0; log(`first plate: ${firstPlateMs} ms`); }
    if (s.plates.length >= regions.length) break;
  }
  const totalMs = Date.now() - t0;
  log(`plates: ${JSON.stringify(s.plates)} (${totalMs} ms)`);
  save('result.json', { firstPlateMs, totalMs, plates: s.plates, snapshot: s });
  check('EN→RU перевод получен (кириллица)', s.plates.some((p) => /[А-Яа-яЁё]/.test(p)), JSON.stringify(s.plates));
  check('плашка на каждую область', s.plates.length === regions.length, `${s.plates.length}/${regions.length}`);
  await md.screenshot({ path: path.join(OUT, '03-result.png') });

  /* промежуточные результаты: сырой OCR-текст и перевод из кэша расширения
   * (Cache Storage общ для options/offscreen — читаем со страницы options) */
  try {
    const dump = await opt.evaluate(async () => {
      const out = [];
      for (const name of await caches.keys()) {
        if (!name.startsWith('te-local-results-')) continue;
        const c = await caches.open(name);
        for (const req of await c.keys()) {
          const r = await c.match(req);
          if (!r) continue;
          try {
            const j = await r.json();
            const p = j.payload ?? {};
            out.push({ url: req.url, model: p.model, source_text: p.source_text, translation: p.translation, latency_ms: p.latency_ms });
          } catch {
            /* не-JSON ответы пропускаем */
          }
        }
      }
      return out;
    });
    save('cache-dump.json', dump);
    log(`cache-dump: ${dump.length} entries`);
  } catch (e) {
    log('cache-dump failed:', String(e));
  }

  /* 8. edge: повторный Enter не дублирует переводы, Esc сбрасывает */
  const before = s.plates.join('|');
  await md.keyboard.press('Enter');
  await md.waitForTimeout(4000);
  s = await snap(md);
  check('повторный Enter не дублирует переводы', s.plates.join('|') === before, JSON.stringify(s.plates));
  await md.keyboard.press('Escape');
  await md.waitForTimeout(1200);
  s = await snap(md);
  check('Esc очистил области и плашки', s.marks === 0 && s.plates.length === 0, JSON.stringify({ marks: s.marks, plates: s.plates }));
  await md.screenshot({ path: path.join(OUT, '04-after-esc.png') });
  }


} catch (e) {
  failures++;
  log('EXCEPTION:', e?.stack ?? String(e));
  try {
    const p = ctx.pages().find((x) => x.url().includes('mangadex.org'));
    if (p) await p.screenshot({ path: path.join(OUT, '99-fail.png') });
  } catch { /* диагностика не критична */ }
} finally {
  save('console.log', consoleLog.join('\n'));
  save('summary.json', { failures, finished: new Date().toISOString() });
  log(failures === 0 ? 'E2E OK' : `E2E FAILED (${failures})`);
  await ctx.close().catch(() => {});
  process.exitCode = failures === 0 ? 0 : 1;
}

