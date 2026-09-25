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


def downscale_png(png_bytes: bytes, max_dim: int = 1600) -> bytes:
    """При необходимости уменьшить PNG, чтобы OCR был быстрым. При сбое вернёт вход."""
    try:
        import io

        from PIL import Image  # optional dependency
    except Exception:
        return png_bytes
    try:
        with Image.open(io.BytesIO(png_bytes)) as im:
            im = im.convert("RGB")
            if max(im.width, im.height) <= max_dim:
                return png_bytes
            ratio = max_dim / max(im.width, im.height)
            im = im.resize((int(im.width * ratio), int(im.height * ratio)), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="PNG")
            return buf.getvalue()
    except Exception:
        return png_bytes


def _parse_tsv(tsv_text: str) -> tuple[str, list[dict]]:
    """Разобрать TSV-вывод tesseract в (source_text, boxes)."""
    rows = [line.rstrip("\n").split("\t") for line in tsv_text.splitlines() if line.strip()]
    if not rows:
        return "", []

    header = rows[0]
    idx = {name: i for i, name in enumerate(header)}
    boxes: list[dict] = []
    words: list[str] = []

    def num(row: list[str], key: str) -> int:
        try:
            return int(float(row[idx[key]]))
        except Exception:
            return 0

    for row in rows[1:]:
        if len(row) < len(header):
            continue
        text = row[idx["text"]] if "text" in idx and idx["text"] < len(row) else ""
        if not text.strip():
            continue
        boxes.append(
            {
                "x": num(row, "left"),
                "y": num(row, "top"),
                "width": num(row, "width"),
                "height": num(row, "height"),
                "text": text,
            }
        )
        words.append(text)

    return " ".join(words).strip(), boxes



def run_ocr(image_base64: str, langs: list[str]) -> dict:
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
        with open(in_path, "wb") as fh:
            fh.write(downscale_png(raw))

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
                source_text, boxes = _parse_tsv(fh.read())
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


def read_message() -> dict | None:
    """Прочитать ровно одно JSON-сообщение с префиксом длины из stdin."""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    if length == 0:
        return {}
    payload = sys.stdin.buffer.read(length)
    try:
        return json.loads(payload.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def write_message(message: dict) -> None:
    """Записать одно JSON-сообщение с префиксом длины в stdout."""
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def handle(request: dict) -> dict:
    action = request.get("action", "ping")

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
        return run_ocr(image, langs)

    return {"ok": False, "error": f"unknown action: {action}"}


def main() -> None:
    # Chrome использует бинарные кадры, поэтому stdout должен оставаться чистым.
    while True:
        request = read_message()
        if request is None:
            break
        try:
            response = handle(request)
        except Exception as exc:  # noqa: BLE001
            response = {"ok": False, "error": str(exc)}
        write_message(response)


if __name__ == "__main__":
    main()

