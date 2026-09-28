/** Чистые текстовые хелперы для локального MT-конвейера (юнит-тестируемые, без DOM). */

/** true, когда ≥40% букв — кириллица (и буквы вообще есть). */
export function isMostlyCyrillic(text: string): boolean {
  let cyr = 0;
  let letters = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isLetter =
      (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x410 && code <= 0x44f) || code === 0x451 || code === 0x401;
    if (!isLetter) continue;
    letters++;
    if (code >= 0x410 && code <= 0x44f) cyr++;
  }
  if (letters < 4) return false;
  return cyr / letters >= 0.4;
}

/** CJK-символы (кана/кандзи/хангыль): в тексте пишутся без пробелов. */
function isCjkChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x3040 && code <= 0x30ff) || // хирагана и катакана
    (code >= 0x3400 && code <= 0x9fff) || // CJK unified + extension A
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
    (code >= 0xac00 && code <= 0xd7af) || // хангыль (слоги)
    (code >= 0xff66 && code <= 0xff9d) // полуширинная катакана
  );
}

/** Латинская буква (любой регистр) — для стыка переносов. */
function isLatinLetter(ch: string): boolean {
  return ch.length > 0 && /[a-zA-Z]/.test(ch);
}

/**
 * Склеить многострочный OCR-текст в одну строку: перенос строки у Tesseract —
 * не смысловая граница, перевод должен уходить единой фразой («весь текст
 * един, даже если он на разных строках»).
 *
 * Правила стыка строк:
 *  - дефисный перенос строки (`some-` + `thing`, `POWER-` + `FUL`) — без дефиса
 *    и без пробела: в комиксах весь текст капсом, а дефис в конце строки почти
 *    всегда перенос, а не составное слово;
 *  - CJK-строки (японский/китайский/корейский) — вплотную, без пробела;
 *  - остальные случаи — один пробел.
 * Пустые строки выбрасываются. Чистая функция — юнит-тестируется.
 */
export function joinOcrLines(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let out = '';
  for (const line of lines) {
    if (!out) {
      out = line;
      continue;
    }
    const last = out[out.length - 1] ?? '';
    const first = line[0] ?? '';
    if (last === '-' && isLatinLetter(first)) {
      out = out.slice(0, -1) + line; // перенос слова: дефис не нужен
    } else if (isCjkChar(last) && isCjkChar(first)) {
      out += line; // CJK пишутся вплотную
    } else {
      out += ` ${line}`;
    }
  }
  return out;
}

/**
 * Гарантия «одна строка» на входе модели перевода: переносы из полного скана
 * или native host становятся пробелами. Осмысленная склейка (дефисы, CJK) —
 * в joinOcrLines. Чистая функция — юнит-тестируется.
 */
export function normalizeMtInput(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export interface PickPairInput {
  sourceLang: string; // 'auto' | 'en' | 'ru' | ...
  targetLang: string;
  text: string;
  preferred: string; // предпочтительная id пары, если направление неоднозначно
  available: string[]; // id пары из реестра
}

export interface PickPairResult {
  /** Какую пару использовать для перевода. */
  pair?: string;
  /** true, если модель не нужна (source == target / pass-through). */
  passthrough: boolean;
  /** Какую пару стоит скачать (её нет в наборе скачанных). */
  missingPair?: string;
}

/**
 * Выбрать MT-пару для запроса.
 * MVP поддерживает только en<->ru; неизвестные направления отдаются как missingPair.
 */
export function pickPair(input: PickPairInput, downloaded: string[]): PickPairResult {
  const { sourceLang, targetLang, text, preferred, available } = input;
  const has = (id?: string): id is string => !!id && downloaded.includes(id);

  // Явный исходный язык
  if (sourceLang !== 'auto') {
    if (sourceLang === targetLang) return { passthrough: true };
    const wanted = available.find((id) => id === `${sourceLang}-${targetLang}`);
    if (!wanted) return { passthrough: false, missingPair: `${sourceLang}-${targetLang}` };
    if (!has(wanted)) return { passthrough: false, missingPair: wanted };
    return { pair: wanted, passthrough: false };
  }

  // Авто-определение по эвристике письма: латиница -> *-ru и т.д.
  const cyrillic = isMostlyCyrillic(text);
  const targetIsCyrillic = targetLang === 'ru' || targetLang === 'uk' || targetLang === 'bg';

  if (targetIsCyrillic && cyrillic) return { passthrough: true }; // уже целевое письмо
  if (targetLang === 'en' && !cyrillic) return { passthrough: true };

  const from = cyrillic ? 'ru' : 'en';
  if (from === targetLang) return { passthrough: true };
  const wanted = available.find((id) => id === `${from}-${targetLang}`);
  if (!wanted) return { passthrough: false, missingPair: `${from}-${targetLang}` };

  // Явное направление при неоднозначности (en-текст + ru-цель и т.п. обработаны выше);
  // fallback на preferred, когда эвристика с ним совпала.
  const chosen = preferred === wanted ? preferred : wanted;
  if (!has(chosen)) return { passthrough: false, missingPair: chosen };
  return { pair: chosen, passthrough: false };
}

/**
 * Разбить длинный OCR-текст на фрагменты по размеру opus-mt (~512 токенов).
 * Переносы строк сохраняются; патологически длинные строки режутся жёстко.
 */
export function chunkText(text: string, maxLen = 400): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let buf = '';

  const flush = () => {
    if (buf.trim().length > 0) chunks.push(buf);
    buf = '';
  };

  for (const line of lines) {
    if (line.length > maxLen) {
      flush();
      let rest = line;
      while (rest.length > maxLen) {
        let cut = rest.lastIndexOf(' ', maxLen);
        if (cut < maxLen * 0.5) cut = maxLen;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
      }
      buf = rest;
      continue;
    }
    if (buf.length + line.length + 1 > maxLen) flush();
    buf += (buf ? '\n' : '') + line;
  }
  flush();
  return chunks;
}
