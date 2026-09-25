# Разработка: окружение и команды

> ОС рабочей станции: **Windows** (PowerShell 5.1). Различия для POSIX отмечены отдельно.

## Структура репозитория

```
translate/
├── extensions/                     # Браузерное расширение (WXT + React + TS, MV3)
│   ├── src/
│   │   ├── entrypoints/
│   │   │   ├── background.ts       # Service worker: роутер сообщений, captureVisibleTab, инъекция
│   │   │   ├── injected.ts         # Unlisted script: скан страницы, оверлей, выделение (инжектится по activeTab)
│   │   │   ├── popup/              # Popup (React): скан, скриншот-перевод, настройки
│   │   │   └── options/            # Options (React): бэкенд, модель, языки
│   │   ├── lib/
│   │   │   ├── api.ts              # HTTP-клиент бэкенда (/translate, /health)
│   │   │   ├── scanner.ts          # Поиск <img>, получение байтов, кроп скриншота
│   │   │   ├── overlay.ts          # Shadow-DOM: панель, статусы, ярлыки, выделение rect
│   │   │   ├── messaging.ts        # Promisified sendMessage + blob→dataURL
│   │   │   ├── storage.ts          # chrome.storage: настройки
│   │   │   ├── i18n.ts             # i18next init (ru/en)
│   │   │   ├── constants.ts        # Настройки по умолчанию, языки, модели
│   │   │   └── types.ts            # Общие типы (зеркало Pydantic-схем)
│   │   ├── locales/{en,ru}.json    # Строки UI
│   │   └── public/                 # _locales (манифест), icon/*.png
│   ├── wxt.config.ts               # Манифест MV3, permissions
│   └── package.json
├── backend/                        # FastAPI: модели, кэш, очередь
│   ├── app/
│   │   ├── main.py                 # create_app, CORS, роутеры
│   │   ├── config.py               # pydantic-settings (.env)
│   │   ├── api/{translate,health,models}.py
│   │   ├── models/                 # Адаптеры: tesseract, openai, gemini, custom
│   │   ├── translator.py           # Текстовый перевод (для local-OCR пути)
│   │   ├── cache.py                # Redis → file-cache fallback
│   │   ├── queue.py                # Bounded concurrency (asyncio.Semaphore)
│   │   └── schemas/translate.py    # Pydantic schemas
│   ├── tests/                      # pytest (mock-адаптеры, без сети)
│   ├── requirements.txt
│   ├── pytest.ini
│   └── Dockerfile                  # python:3.13-slim + tesseract-ocr + rus/eng
├── docker-compose.yml              # backend + redis (127.0.0.1:8000 / 6379)
├── .env.example                    # Шаблон переменных окружения бэкенда
└── pnpm-workspace.yaml             # (опционально) pnpm-монорепо
```

## Инструменты / зачем / установка

| Инструмент | Зачем | Windows-команда |
|---|---|---|
| Node.js ≥ 20 | Сборка расширения | уже есть (22.x) |
| npm | Пакеты расширения | уже есть |
| pnpm *(опц.)* | Монорепо-воркспейс | `npm i -g pnpm` |
| Python ≥ 3.10 | Бэкенд | уже есть (3.13.4) |
| venv | Изоляция Python | `python -m venv .venv` |
| Docker Desktop | Локальный бэкенд + Tesseract (офлайн-режим) | установлен; **daemon должен быть запущен** |
| Tesseract (системный) | Офлайн-OCR **без** Docker | `winget install tesseract` или установщик UB-Mannheim |
| pytest / pytest-asyncio | Тесты бэкенда | `pip install pytest pytest-asyncio` |
| Playwright *(позже)* | E2E расширения | `npm i -D @playwright/test` |

### VS Code расширения

| Расширение | Зачем |
|---|---|
| ESLint + Prettier | Линт/формат (TS) |
| Python (Microsoft) | Бэкенд, отладка |
| Docker | Compose/образы |
| Error Lens | Ошибки прямо в строке |
| REST Client | Проверка `/translate` вручную |

## Шаг 1. Инициализация

```powershell
cd <корень репозитория>
git init          # репозиторий проекта (не домашний!)
```

## Шаг 2. Бэкенд: venv, зависимости, .env

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install pytest pytest-asyncio        # dev-зависимости
Copy-Item ..\.env.example .env           # затем отредактировать .env
```

`backend/.env` (минимум для автономного офлайн-режима):

```
DEFAULT_MODE=local
LOCAL_TRANSLATION_PROVIDER=none
USE_FILE_CACHE_IF_NO_REDIS=true
FILE_CACHE_DIR=/app/cache
ALLOWED_ORIGINS=chrome-extension://*,http://localhost:5173
```

## 3) Автономная сборка расширения (рекомендуемый режим)

Автономный режим не требует запуска Python/FastAPI/Docker. `npm run vendor` один раз
загружает и проверяет модели, Tesseract и ORT, затем `npm run build` создаёт пакет.

```powershell
cd extensions
npm install
npm run vendor       # нужна сеть только на этом шаге
npm run build        # → dist/chrome-mv3
```

Готовую папку `dist\chrome-mv3` загрузите в Chrome через
`chrome://extensions` → **Режим разработчика** → **Загрузить распакованное расширение**.

В автономном пакете:
- 2 модели Opus-MT (`en-ru`, `ru-en`), 20 файлов;
- Tesseract Core/Worker и `eng/rus` traineddata;
- CPU ONNX Runtime Web (`wasm` + `asyncify`);
- `vendor.json` с перечнем включённых ресурсов.

`npm run vendor` проверяет размер и SHA-256 каждого файла модели. Повторный запуск
идемпотентен и не перезагружает корректные файлы. Если пакет отсутствует или
повреждён, локальный движок завершает задачу ошибкой, а не скачивает модель из CDN.

## 4) Необязательный backend

Backend нужен только для облачных моделей, собственного REST API или отдельного
экспериментального Tesseract-сервиса. Для полностью автономной работы его запускать
не нужно.

### Docker

```powershell
cd <корень репозитория>
docker compose up -d --build
curl.exe http://127.0.0.1:8000/health
```

### Нативно

```powershell
cd backend
.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000
```

## 5) Тесты

```powershell
# Автономный пакет и unit-тесты расширения
cd extensions
npm run compile
npm test

# Backend
cd ..\backend
.venv\Scripts\python.exe -m pytest -q
```

Текущий проверенный результат: `41 passed` для Vitest, `16 passed` для pytest,
`npm run compile` и `npm run build` — exit 0. Реальный локальный inference моделей
проверен: `en-ru` переводит `Hello world` в `Приветствую мир`, `ru-en` — `Привет мир`
в `Hello, peace`.

## Частые проблемы

| Симптом | Причина / решение |
|---|---|
| `docker: cannot connect ... dockerDesktopLinuxEngine` | Docker Desktop **не запущен** — запустите и дождитесь «Engine running». |
| `pydantic_settings ... error parsing value for "allowed_origins"` | Список через запятую, без JSON-кавычек (`NoDecode` уже настроен). |
| `pytesseract.TesseractNotFoundError` | Нет системного `tesseract` → используйте Docker-образ или установите Tesseract и добавьте в PATH. |
| `Image is not readable (CORS/blocked)` | Кросс-доменная картинка без CORS → кнопка «Перевести видимую область» (скриншот-режим). |
| PowerShell: `&&` не работает | В PS 5.1 используйте `;`. |
| Сборка расширения: esbuild install-script заблокирован npm | `npm rebuild esbuild` или `npm install-scripts approve esbuild`. |

## Definition of Done для изменений

- `pytest -q` — зелёный;
- `npm run compile` и `npm run build` — без ошибок;
- новые строки UI добавлены и в `ru.json`, и в `en.json`;
- изменение схемы API синхронизировано: `backend/app/schemas/translate.py` ↔ `extensions/src/lib/types.ts`.

