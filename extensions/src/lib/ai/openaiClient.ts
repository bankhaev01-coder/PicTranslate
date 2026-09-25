import type { TranslateResult } from '../types';
import { extractJson } from './geminiClient';

export interface OpenAIClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  targetLang: string;
  sourceLang?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Ответ Chat Completions (только используемые поля). */
interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

/** Тело ошибки OpenAI в формате { error: { message } }. */
interface OpenAIErrorBody {
  error?: { message?: string };
}

export const OPENAI_PROMPT = `You are an expert manga and comic OCR and translation assistant.
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

/**
 * Переводит изображение через OpenAI Vision API напрямую из браузера.
 */
export async function translateWithOpenAI(
  dataUrlOrBase64: string,
  options: OpenAIClientOptions,
): Promise<TranslateResult> {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const {
    apiKey,
    baseUrl = 'https://api.openai.com/v1',
    model = 'gpt-4o',
    targetLang,
    timeoutMs = 60_000,
    signal,
  } = options;

  if (!apiKey) {
    return {
      source_text: '',
      translation: '',
      model: `openai:${model}`,
      latency_ms: elapsed(),
      error: 'OpenAI API key is not configured. Please enter your API key in Settings.',
    };
  }

  const imageUrl = dataUrlOrBase64.startsWith('data:')
    ? dataUrlOrBase64
    : `data:image/png;base64,${dataUrlOrBase64}`;

  const prompt = OPENAI_PROMPT.replace('{target_lang}', targetLang);

  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content: 'You are an expert manga and comic OCR and translation assistant.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: imageUrl },
          },
        ],
      },
    ],
    max_tokens: 2048,
    temperature: 0.1,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
  const url = `${cleanBaseUrl}/chat/completions`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resp.ok) {
      let detail = `OpenAI HTTP ${resp.status}`;
      try {
        const errJson: OpenAIErrorBody = await resp.json();
        detail = errJson?.error?.message ?? detail;
      } catch {
        // тело ошибки не JSON — оставляем статус
      }
      return {
        source_text: '',
        translation: '',
        model: `openai:${model}`,
        latency_ms: elapsed(),
        error: detail,
      };
    }

    const data: OpenAIChatResponse = await resp.json();
    const rawContent = data.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson(rawContent);

    return {
      source_text: parsed.source_text ?? '',
      translation: parsed.translation ?? rawContent,
      model: `openai:${model}`,
      detected_language: parsed.detected_language ?? null,
      boxes: Array.isArray(parsed.boxes) ? parsed.boxes : [],
      latency_ms: elapsed(),
    };
  } catch (err: unknown) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? 'OpenAI request timed out'
        : String(err);
    return {
      source_text: '',
      translation: '',
      model: `openai:${model}`,
      latency_ms: elapsed(),
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}
