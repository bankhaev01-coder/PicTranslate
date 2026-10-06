#!/usr/bin/env python3
"""Chrome Native Messaging хост для расширения Image Translator.

Протокол (Chrome native messaging):
  * Сообщения — JSON, кодированный в UTF-8.
  * Каждому сообщению предшествует 4-байтовый беззнаковый little-endian размер.
  * stdin несёт запросы от расширения, stdout — ответы.
  * stderr зарезервирован под логирование (никогда не используйте его для данных протокола).

Действия
-------
  ping  -> сообщает версию хоста и доступен ли бинарник Tesseract.
  ocr   -> запускает OCR на base64 PNG и возвращает простой текст + пословные боксы.
           Боксы всегда в координатах ИСХОДНОГО изображения (даже если хост
           уменьшал картинку перед OCR). Необязательное поле запроса
           ``min_confidence`` (0–100) отбрасывает слова с меньшей уверенностью.

Хост запускается браузером по запросу
(``chrome.runtime.sendNativeMessage``), поэтому слушающего сокета и
долгоживущего демона нет.

Требования:
  * Python 3.8+
  * Pillow (``pip install pillow``) — необязательно, только для уменьшения картинок.
  * Бинарник Tesseract: в PATH или по пути из переменной TESSERACT_CMD.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

VERSION = "1.0.0"
HOST_NAME = "com.manga.translate.host"

# Порог уверенности по умолчанию — тот же, что ocrMinConfidence в расширении.
DEFAULT_MIN_CONFIDENCE = 40.0

# -- Поиск Tesseract ---------------------------------------------------------


def find_tesseract() -> str | None:
    """Найти исполняемый tesseract: через переменную окружения, PATH или типовые пути."""
    env_cmd = os.environ.get("TESSERACT_CMD", "").strip()
    if env_cmd and os.path.isfile(env_cmd):
        return env_cmd
    found = shutil.which("tesseract")
    if found:
        return found
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        os.path.expanduser(r"~\AppData\Local\Programs\Tesseract-OCR\tesseract.exe"),
        "/usr/bin/tesseract",
        "/usr/local/bin/tesseract",
        "/opt/homebrew/bin/tesseract",
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def tesseract_langs(cmd: str) -> list[str]:
    """Список установленных языков traineddata (best effort)."""
    try:
        out = subprocess.run(
            [cmd, "--list-langs"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        lines = (out.stdout or "").splitlines()
        return [ln.strip() for ln in lines[1:] if ln.strip()]
    except Exception:
        return []


# -- OCR ---------------------------------------------------------------------


def downscale_png(png_bytes: bytes, max_dim: int = 1600) -> tuple[bytes, float]:
    """При необходимости уменьшить PNG, чтобы OCR был быстрым.

    Возвращает (байты, scale), где scale = новый размер / исходный (1.0, если
    картинка не менялась). По scale боксы пересчитываются обратно в исходные
    координаты. При любом сбое возвращает вход и 1.0.
    """
    try:
        import io

        from PIL import Image  # optional dependency
    except Exception:
        return png_bytes, 1.0
    try:
        with Image.open(io.BytesIO(png_bytes)) as im:
            im = im.convert("RGB")
            if max(im.width, im.height) <= max_dim:
                return png_bytes, 1.0
            ratio = max_dim / max(im.width, im.height)
            im = im.resize((int(im.width * ratio), int(im.height * ratio)), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="PNG")
            return buf.getvalue(), ratio
    except Exception:
        return png_bytes, 1.0


def _parse_tsv(
    tsv_text: str,
    min_confidence: float = 0.0,
    scale: float = 1.0,
) -> tuple[str, list[dict]]:
    """Разобрать TSV-вывод tesseract в (source_text, boxes).

    * Слова с ``conf`` ниже ``min_confidence`` отбрасываются (шум с рисунка).
    * Координаты делятся на ``scale``, чтобы вернуть их в масштаб исходного
      изображения, если перед OCR картинку уменьшали.
    """
    rows = [line.rstrip("\n").split("\t") for line in tsv_text.splitlines() if line.strip()]
    if not rows:
        return "", []

    header = rows[0]
    idx = {name: i for i, name in enumerate(header)}
    boxes: list[dict] = []
    words: list[str] = []
    if not scale or scale <= 0:
        scale = 1.0

    def num(row: list[str], key: str) -> int:
        try:
            return int(float(row[idx[key]]))
        except Exception:
            return 0

    def conf(row: list[str]) -> float | None:
        if "conf" not in idx:
            return None
        try:
            return float(row[idx["conf"]])
        except Exception:
            return None

    def unscale(value: int) -> int:
        return int(round(value / scale))

    for row in rows[1:]:
        if len(row) < len(header):
            continue
        text = row[idx["text"]] if "text" in idx and idx["text"] < len(row) else ""
        if not text.strip():
            continue
        c = conf(row)
        if c is not None and c < min_confidence:
            continue
        boxes.append(
            {
                "x": unscale(num(row, "left")),
                "y": unscale(num(row, "top")),
                "width": unscale(num(row, "width")),
                "height": unscale(num(row, "height")),
                "text": text,
            }
        )
        words.append(text)

    return " ".join(words).strip(), boxes


def _min_confidence(value: object) -> float:
    """Порог уверенности из запроса: число 0–100, иначе значение по умолчанию."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return DEFAULT_MIN_CONFIDENCE
    return max(0.0, min(100.0, float(value)))


def run_ocr(
    image_base64: str,
    langs: list[str],
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
) -> dict:
    """Запустить Tesseract через CLI и вернуть {source_text, boxes}."""
    cmd = find_tesseract()
    if not cmd:
        return {
            "ok": False,
            "error": (
                "Tesseract binary not found. Install it "
                "(winget install UB-Mannheim.TesseractOCR) or set TESSERACT_CMD."
            ),
        }

    clean = image_base64.split(",", 1)[-1] if image_base64.startswith("data:") else image_base64
    try:
        raw = base64.b64decode(clean)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"invalid base64 image: {exc}"}

    if not langs:
        langs = ["eng", "rus"]

    tmp_dir = tempfile.mkdtemp(prefix="manga-ocr-")
    in_path = os.path.join(tmp_dir, "input.png")
    out_base = os.path.join(tmp_dir, "out")
    try:
        png_bytes, scale = downscale_png(raw)
        with open(in_path, "wb") as fh:
            fh.write(png_bytes)

        lang_arg = "+".join(langs)
        proc = subprocess.run(
            [cmd, in_path, out_base, "-l", lang_arg, "tsv"],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        tsv_path = out_base + ".tsv"
        if proc.returncode != 0 and not os.path.isfile(tsv_path):
            return {
                "ok": False,
                "error": (proc.stderr or proc.stdout or "tesseract failed").strip(),
            }

        source_text = ""
        boxes: list[dict] = []
        if os.path.isfile(tsv_path):
            with open(tsv_path, "r", encoding="utf-8") as fh:
                source_text, boxes = _parse_tsv(fh.read(), min_confidence, scale)
        else:
            txt_path = out_base + ".txt"
            if os.path.isfile(txt_path):
                with open(txt_path, "r", encoding="utf-8") as fh:
                    source_text = fh.read().strip()

        return {"ok": True, "source_text": source_text, "boxes": boxes}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "tesseract timed out"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)



# -- Протокольная обвязка ----------------------------------------------------


# Сообщения от браузера к хосту ограничены Chrome 4 ГБ; столько нам не нужно.
MAX_MESSAGE_BYTES = 64 * 1024 * 1024


class ProtocolError(Exception):
    """Сообщение нельзя разобрать: битый JSON, не объект или слишком большой размер."""


def read_message() -> dict | None:
    """Прочитать ровно одно JSON-сообщение с префиксом длины из stdin.

    None — stdin закрыт (браузер отключился). Битое сообщение даёт
    ProtocolError, а не пустой dict: раньше {} обрабатывался как ping.
    """
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    if length > MAX_MESSAGE_BYTES:
        raise ProtocolError(f"message too large: {length} bytes")
    payload = sys.stdin.buffer.read(length)
    if len(payload) < length:
        return None
    try:
        message = json.loads(payload.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ProtocolError(f"invalid JSON message: {exc}") from exc
    if not isinstance(message, dict):
        raise ProtocolError("message must be a JSON object")
    return message


def write_message(message: dict) -> None:
    """Записать одно JSON-сообщение с префиксом длины в stdout."""
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def handle(request: dict) -> dict:
    action = request.get("action")
    if not action:
        return {"ok": False, "error": "action is required"}

    if action == "ping":
        cmd = find_tesseract()
        return {
            "ok": True,
            "version": VERSION,
            "tesseract_available": bool(cmd),
            "tesseract_path": cmd or "",
            "langs": tesseract_langs(cmd) if cmd else [],
        }

    if action == "ocr":
        image = request.get("image_base64") or ""
        langs = request.get("langs") or []
        if not image:
            return {"ok": False, "error": "image_base64 is required"}
        return run_ocr(image, langs, _min_confidence(request.get("min_confidence")))

    return {"ok": False, "error": f"unknown action: {action}"}


def main() -> None:
    # Chrome использует бинарные кадры, поэтому stdout должен оставаться чистым.
    while True:
        try:
            request = read_message()
        except ProtocolError as exc:
            # Слишком большое сообщение могло не дочитаться — поток рассинхронизирован,
            # отвечаем ошибкой и выходим; битый JSON — отвечаем ошибкой и продолжаем.
            write_message({"ok": False, "error": str(exc)})
            if str(exc).startswith("message too large"):
                break
            continue
        if request is None:
            break
        try:
            response = handle(request)
        except Exception as exc:  # noqa: BLE001
            response = {"ok": False, "error": str(exc)}
        write_message(response)


if __name__ == "__main__":
    main()

