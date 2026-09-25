import type { AiJsonResponse, TranslateResult } from '../types';

export interface GeminiClientOptions {
  apiKey: string;
  model?: string;
  targetLang: string;
  sourceLang?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Ответ Gemini generateContent (только используемые поля). */
interface GeminiApiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export const GEMINI_PROMPT = `You are an expert manga and comic OCR and translation assistant.
Analyze this image carefully. Extract all dialogue and narrative text verbatim.
Detect the approximate bounding box for each distinct speech bubble or text block in pixel coordinates relative to the original image dimensions [x, y, width, height].
Translate each text segment faithfully into {target_lang}.

Return STRICTLY a valid JSON object matching this schema without any markdown, backticks, or extra text:
{
  "source_text": "entire extracted source text joined by newlines",
  "translation": "entire translated text joined by newlines",
  "detected_language": "ISO language code, e.g. ja, en, ko, zh",
  "boxes": [
    {
      "x": 100,
      "y": 150,
      "width": 120,
      "height": 80,
      "text": "original text in this bubble",
      "translation": "translated text for this bubble"
    }
  ]
}`;

export function extractJson(raw: string): AiJsonResponse {
  const trimmed = raw.trim();
  // Снять markdown-изгородь ```json, если модель её добавила
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  const candidate = match ? match[1] : trimmed;
  try {
    return asAiJson(JSON.parse(candidate));
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return asAiJson(JSON.parse(candidate.slice(start, end + 1)));
      } catch {
        /* запасной вариант тоже не удался */
      }
    }
    return {};
  }
}

/** Привести разобранный JSON к AiJsonResponse; не-объект или битая структура → {}. */
function asAiJson(v: unknown): AiJsonResponse {
  return isAiJsonResponse(v) ? v : {};
}

/** Проверка структуры: поля ожидаемых типов, лишние поля допустимы. */
function isAiJsonResponse(v: unknown): v is AiJsonResponse {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const optionalString = (x: unknown): boolean => x === undefined || typeof x === 'string';
  if (!optionalString(o.source_text) || !optionalString(o.translation)) return false;
  if (o.detected_language != null && typeof o.detected_language !== 'string') return false;
  if (o.boxes !== undefined && !(Array.isArray(o.boxes) && o.boxes.every(isBox))) return false;
  return true;
}

function isBox(b: unknown): boolean {
  if (typeof b !== 'object' || b === null) return false;
  const o = b as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof o[k] === 'number');
}

/**
 * Переводит изображение через Gemini Vision API напрямую из браузера.
 */
export async function translateWithGemini(
  base64Png: string,
  options: GeminiClientOptions,
): Promise<TranslateResult> {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const {
    apiKey,
    model = 'gemini-1.5-flash',
    targetLang,
    timeoutMs = 60_000,
    signal,
  } = options;

  if (!apiKey) {
    return {
      source_text: '',
      translation: '',
      model: `gemini:${model}`,
      latency_ms: elapsed(),
      error: 'Gemini API key is not configured. Please enter your API key in Settings.',
    };
  }

  // Убрать префикс data:image/...;base64, если он есть
  const cleanBase64 = base64Png.replace(/^data:image\/[a-zA-Z0-9.+]+;base64,/, '');

  const prompt = GEMINI_PROMPT.replace('{target_lang}', targetLang);

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: 'image/png',
              data: cleanBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Ключ в заголовке, а не в query string — не попадает в URL и логи
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resp.ok) {
      let detail = `Gemini HTTP ${resp.status}`;
      try {
        const errJson: { error?: { message?: string } } = await resp.json();
        detail = errJson?.error?.message ?? detail;
      } catch {
        // тело ошибки не JSON — оставляем статус
      }
      return {
        source_text: '',
        translation: '',
        model: `gemini:${model}`,
        latency_ms: elapsed(),
        error: detail,
      };
    }

    const data: GeminiApiResponse = await resp.json();
    const candidateText =
      data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = extractJson(candidateText);

    return {
      source_text: parsed.source_text ?? '',
      translation: parsed.translation ?? candidateText,
      model: `gemini:${model}`,
      detected_language: parsed.detected_language ?? null,
      boxes: Array.isArray(parsed.boxes) ? parsed.boxes : [],
      latency_ms: elapsed(),
    };
  } catch (err: unknown) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? 'Gemini request timed out'
        : String(err);
    return {
      source_text: '',
      translation: '',
      model: `gemini:${model}`,
      latency_ms: elapsed(),
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}
