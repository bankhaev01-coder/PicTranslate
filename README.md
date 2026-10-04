# Перевод текста на изображениях — автономное браузерное расширение

Расширение Chrome/Chromium (Manifest V3) переводит **все изображения на странице сразу**. Три движка на выбор: безсерверный AI (Gemini/OpenAI Vision), полностью локальный (Tesseract.js + ONNX Opus-MT) или свой FastAPI-бэкенд. Инструмент выделения поддерживает три формы — прямоугольник, овал и лассо — и позволяет набрать несколько областей, чтобы перевести их одной пачкой (Enter).

## Что работает локально

- OCR всех `<img>` на странице через **Tesseract.js**.
- Перевод распознанного текста через **Transformers.js + ONNX Runtime Web**.
- В пакет входят модели `en-ru` и `ru-en`, CPU-WASM, Tesseract Core и языки `eng/rus`.
- После установки пакета перевод не требует Python, Docker, API-ключей или интернета.
- Интерфейс и сообщения ошибок: русский/английский.
- Скриншот вкладки и выделение одной или нескольких областей (прямоугольник / овал / лассо) — дополнительные сценарии.
- Необязательно: Chrome Native Messaging хост для ускорения Tesseract (`native_host/`).

## Быстрый старт

```powershell
cd extensions
npm install
npm run vendor       # один раз: сборка и проверка офлайн-моделей
npm run build        # production-пакет
```

Готовый пакет:

```text
extensions\dist\chrome-mv3
```

Установка в Chrome:

1. Откройте `chrome://extensions`.
2. Включите **Режим разработчика**.
3. Нажмите **Загрузить распакованное расширение**.
4. Выберите папку `extensions\dist\chrome-mv3`.

`npm run vendor` требует интернет только во время сборки. На этапе загрузки файлы проверяются по размеру и SHA-256; в runtime внешние URL не используются.

## Основные команды

```powershell
cd extensions
npm run vendor       # Tesseract + ORT + модели в public/
npm run compile      # TypeScript без emit
npm test             # unit-тесты
npm run build        # dist/chrome-mv3
npm run zip          # ZIP для публикации
```

Backend FastAPI и Docker остаются **необязательными**: они нужны только для облачных моделей, собственного REST API или экспериментального Tesseract-сервиса.

## Режимы перевода

| Движок | Что делает | Что нужно |
|---|---|---|
| `ai` (по умолчанию) | Gemini/OpenAI Vision напрямую из браузера, без сервера | API-ключ в Настройках |
| `local` | Tesseract.js + Opus-MT ONNX внутри расширения | `npm run vendor` один раз |
| `backend` | Ваш FastAPI-сервис | запущенный backend |

## Проверенный статус

| Проверка | Результат |
|---|---|
| `npm run vendor` | ✅ exit 0, 20 файлов моделей, SHA-256 проверены |
| `npm run compile` | ✅ exit 0 |
| `npm test` | ✅ 92 passed |
| `backend\.venv\Scripts\python.exe -m pytest -q` | ✅ 16 passed, 1 стороннее предупреждение |
| `npm run build` | ✅ MV3-пакет, 69 файлов, ≈384.5 MB |
| Локальный inference `en-ru` | ✅ `Hello world` → `Приветствую мир` |
| Локальный inference `ru-en` | ✅ `Привет мир` → `Hello, peace` |

## Документация

- [`docs/README.dev.md`](docs/README.dev.md) — разработка, команды и troubleshooting.
- [`docs/decisions/01-arch.md`](docs/decisions/01-arch.md) — архитектура, поток данных, автономный режим и roadmap.

## Перевод страниц и видимой области

[Изменения, установка в Windows и проверка на манге](docs/testing/page-bubbles.md). Доступна лёгкая OCR-сборка без локального Opus-MT (`npm run vendor:ocr`) для явного использования внешнего текстового переводчика. Groq настраивается по желанию через Custom AI.

## Экспериментальный TeleOCR

Необязательный сервис для повторного OCR выделенного фрагмента: [инструкция](experiments/teleocr_service/README.md). Работает в отдельном Python-окружении через серверный CustomAdapter; по умолчанию не включён. Качество на манге и скорость реальной модели ещё требуют проверки.

## Лицензия

MIT. См. [LICENSE](LICENSE).

