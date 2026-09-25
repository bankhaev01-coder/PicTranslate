#!/usr/bin/env python3
"""Standalone-проба native messaging хоста (браузер не нужен).

Использование:
    python -X utf8 native_host/probe.py            # только ping
    python -X utf8 native_host/probe.py <image.png>  # ping + OCR файла
"""
from __future__ import annotations

import base64
import json
import os
import struct
import subprocess
import sys

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "host.py")


def call_host(request: dict) -> dict:
    payload = json.dumps(request).encode("utf-8")
    frame = struct.pack("<I", len(payload)) + payload
    proc = subprocess.run(
        [sys.executable, "-X", "utf8", HOST],
        input=frame,
        capture_output=True,
    )
    out = proc.stdout
    if len(out) < 4:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace") or "empty response")
    (length,) = struct.unpack("<I", out[:4])
    return json.loads(out[4 : 4 + length].decode("utf-8"))


def main() -> int:
    print("ping ->", json.dumps(call_host({"action": "ping"}), ensure_ascii=False))

    if len(sys.argv) > 1:
        with open(sys.argv[1], "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("ascii")
        res = call_host({"action": "ocr", "image_base64": b64, "langs": ["eng", "rus"]})
        print("ocr  ->", json.dumps(res, ensure_ascii=False)[:1000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
