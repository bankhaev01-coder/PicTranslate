# Native Messaging host (local Tesseract OCR)

Этот хост даёт расширению доступ к **локальному Tesseract** через
Chrome Native Messaging. Он запускается браузером по требованию
(`chrome.runtime.sendNativeMessage`) — никаких слушающих портов и демонов.

## Требования

| Компонент | Зачем | Установка |
|---|---|---|
| Python 3.8+ | запуск `host.py` | <https://www.python.org/downloads/> (галочка «Add to PATH») |
| Tesseract OCR | распознавание текста | `winget install UB-Mannheim.TesseractOCR` |
| Pillow *(опционально)* | даунскейл больших картинок | `pip install pillow` |

Tesseract должен быть в `PATH` **или** задайте переменную окружения
`TESSERACT_CMD=C:\путь\к\tesseract.exe`.

## Установка

1. Соберите/загрузите расширение: `chrome://extensions` → «Загрузить
   распакованное» → папка `extensions/dist/chrome-mv3` (или `npm run build`).
2. Включите «Режим разработчика» и скопируйте **ID расширения** с карточки.
3. Запустите установщик из этой папки:

   ```bat
   install_host.bat <EXTENSION_ID>
   ```

   Скрипт создаст `host_launcher.bat`, отрендерит
   `com.manga.translate.host.json` и пропишет манифест в реестр для
   Chrome / Edge / Brave.

## Проверка

В настройках расширения нажмите **«Проверить Native Host»**. Успешный ответ
выглядит так:

```json
{ "ok": true, "version": "1.0.0", "tesseract_available": true, "langs": ["eng","rus"] }
```

## Ручная проверка хоста (без браузера)

```powershell
python -X utf8 native_host/probe.py
```

## Удаление

```bat
install_host.bat --uninstall
```
