/**
 * Облачный OCR выделенной области через backenster.com parseImage — способ,
 * скопированный из расширения uLanguage (переупаковка CRX: background.js,
 * функция _imageToOCr). Один multipart-POST отдаёт и распознанный текст, и
 * готовый перевод строками — без координат bbox.
 *
 * Поэтому работает только для regionOnly (кроп области, выделенной
 * пользователем): автосканирование всей страницы остаётся на локальном
 * Tesseract — только он возвращает боксы для пузырей.
 *
 * Сервер сторонний, ключ — публичный, статически зашитый в пакете uLanguage,
 * и может перестать работать в любой момент: конвейер обязан на любую ошибку
 * падать на локальный путь (см. localPipeline в offscreen/main.ts).
 */

export const PARSE_IMAGE_URL =
  'https://backenster.com/v2/api/v3/parseImage?platform=android&compose=true';

/** Публичный Bearer-ключ из пакета uLanguage (Chrome-вариант окружения). */
const PARSE_IMAGE_BEARER = 'Bearer sdf2fsd34lkkdfg';

/** Таймаут запроса: живой сервер отвечает за 2–4 с. */
const PARSE_IMAGE_TIMEOUT_MS = 15_000;

/**
 * Маппинг наших языков (BCP-47) → формат backenster (xx_XX).
 * Сервер не принимает ни 'auto', ни короткие коды: `from=ru` → 400 "Bad
 * languages", `from=ru_RU` → 200 (проверено smoke-запросом).
 */
const CLOUD_LANGS: Record<string, string> = {
  ru: 'ru_RU',
  en: 'en_US',
  uk: 'uk_UA',
  de: 'de_DE',
  fr: 'fr_FR',
  es: 'es_ES',
  zh: 'zh_CN',
  ja: 'ja_JP',
  ko: 'ko_KR',
};

/**
 * Наш код языка → их формат xx_XX. 'auto' и неизвестные коды → 'en_US':
 * у сервера автоопределения нет, а англоязычные комиксы — основной сценарий.
 */
export function toCloudLang(code: string): string {
  if (/^[a-z]{2}_[A-Z]{2}$/.test(code)) return code;
  return CLOUD_LANGS[code] ?? 'en_US';
}

/** Разобранный ответ parseImage. */
export interface CloudOcrText {
  /** Распознанный текст одной строкой (как в локальном regionOnly-пути). */
  sourceText: string;
  /** Готовый серверный перевод одной строкой; '' если данных нет. */
  translatedText: string;
  /** Число распознанных строк сервера (для логов/статистики). */
  lineCount: number;
}

/** Сырой ответ parseImage (поля опциональные: err/sourceData/translatedData). */
interface ParseImageJson {
  err?: string | null;
  sourceData?: unknown;
  translatedData?: unknown;
}

/** Массив строк из ответа → одна строка; не-массивы и не-строки отбрасываем. */
function joinLines(v: unknown): string {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').join(' ') : '';
}

/**
 * Чистая функция разбора ответа parseImage — юнит-тесты без сети.
 * Бросает Error при `err` сервера или отсутствии распознанного текста.
 */
export function parseParseImageJson(json: unknown): CloudOcrText {
  const j = (json ?? {}) as ParseImageJson;
  if (typeof j.err === 'string' && j.err.trim()) throw new Error(j.err);
  const lines = Array.isArray(j.sourceData) ? j.sourceData : [];
  const sourceText = joinLines(j.sourceData);
  if (!sourceText) throw new Error('parseImage: empty sourceData');
  return { sourceText, translatedText: joinLines(j.translatedData), lineCount: lines.length };
}

/**
 * Отправить data URL (кроп области) в parseImage и вернуть тексты.
 * Бросает при сетевой ошибке, таймауте, HTTP != 200, не-JSON ответе или `err`
 * в ответе — вызывающий код (localPipeline) перехватывает и уходит на
 * локальный OCR.
 */
export async function parseImageOcr(
  dataUrl: string,
  sourceLang: string,
  targetLang: string,
): Promise<CloudOcrText> {
  const blob = await (await fetch(dataUrl)).blob();
  const form = new FormData();
  form.append('from', toCloudLang(sourceLang));
  form.append('to', toCloudLang(targetLang));
  form.append('file', blob, 'region.png');

  const res = await fetch(PARSE_IMAGE_URL, {
    method: 'POST',
    headers: { authorization: PARSE_IMAGE_BEARER, accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(PARSE_IMAGE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`parseImage: HTTP ${res.status}`);
  // Сторонний сервер при блокировке/капче может отдать HTML со статусом 200:
  // вместо невнятного SyntaxError — понятная причина в логе.
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('parseImage: invalid JSON response');
  }
  return parseParseImageJson(json);
}
