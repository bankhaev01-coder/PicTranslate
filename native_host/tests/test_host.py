"""Тесты разбора OCR-вывода native host (запуск: python -m unittest discover native_host/tests)."""
from __future__ import annotations

import base64
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import host  # noqa: E402

HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"


def tsv(*rows: str) -> str:
    return "\n".join([HEADER, *rows]) + "\n"


class ParseTsvTest(unittest.TestCase):
    def test_drops_words_below_min_confidence(self) -> None:
        text, boxes = host._parse_tsv(
            tsv(
                "5\t1\t1\t1\t1\t1\t10\t10\t40\t12\t91.5\tHELLO",
                "5\t1\t1\t1\t1\t2\t60\t10\t20\t12\t12.0\t~#",
            ),
            min_confidence=40,
        )
        self.assertEqual(text, "HELLO")
        self.assertEqual([b["text"] for b in boxes], ["HELLO"])

    def test_scales_boxes_back_to_original_image(self) -> None:
        _, boxes = host._parse_tsv(
            tsv("5\t1\t1\t1\t1\t1\t100\t50\t40\t10\t90\tWORD"),
            scale=0.5,
        )
        self.assertEqual(boxes, [{"x": 200, "y": 100, "width": 80, "height": 20, "text": "WORD"}])

    def test_defaults_keep_previous_behaviour(self) -> None:
        _, boxes = host._parse_tsv(tsv("5\t1\t1\t1\t1\t1\t1\t2\t3\t4\t5\tlow"))
        self.assertEqual(boxes, [{"x": 1, "y": 2, "width": 3, "height": 4, "text": "low"}])


class MinConfidenceTest(unittest.TestCase):
    def test_request_value_is_validated(self) -> None:
        self.assertEqual(host._min_confidence(55), 55.0)
        self.assertEqual(host._min_confidence(150), 100.0)
        self.assertEqual(host._min_confidence(-3), 0.0)
        self.assertEqual(host._min_confidence(None), host.DEFAULT_MIN_CONFIDENCE)
        self.assertEqual(host._min_confidence("60"), host.DEFAULT_MIN_CONFIDENCE)
        self.assertEqual(host._min_confidence(True), host.DEFAULT_MIN_CONFIDENCE)

    def test_handle_passes_threshold_to_ocr(self) -> None:
        with mock.patch.object(host, "run_ocr", return_value={"ok": True}) as run:
            host.handle({"action": "ocr", "image_base64": "AA==", "langs": ["eng"], "min_confidence": 70})
        run.assert_called_once_with("AA==", ["eng"], 70.0)


class DownscaleTest(unittest.TestCase):
    def setUp(self) -> None:
        try:
            from PIL import Image  # noqa: F401
        except Exception:  # pragma: no cover
            self.skipTest("Pillow is not installed")

    def _png(self, width: int, height: int) -> bytes:
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (width, height), "white").save(buf, format="PNG")
        return buf.getvalue()

    def test_small_image_is_untouched(self) -> None:
        png = self._png(800, 600)
        self.assertEqual(host.downscale_png(png), (png, 1.0))

    def test_large_image_reports_scale(self) -> None:
        _, scale = host.downscale_png(self._png(3200, 1000))
        self.assertAlmostEqual(scale, 0.5)

    def test_run_ocr_returns_original_coordinates_for_downscaled_image(self) -> None:
        image = base64.b64encode(self._png(3200, 1000)).decode()

        def fake_tesseract(args, **_kwargs):
            with open(args[2] + ".tsv", "w", encoding="utf-8") as fh:
                fh.write(tsv("5\t1\t1\t1\t1\t1\t100\t50\t40\t10\t95\tWORD"))
            return mock.Mock(returncode=0, stderr="", stdout="")

        with mock.patch.object(host, "find_tesseract", return_value="tesseract"), \
                mock.patch.object(host.subprocess, "run", side_effect=fake_tesseract):
            result = host.run_ocr(image, ["eng"])
        self.assertTrue(result["ok"])
        self.assertEqual(result["boxes"], [{"x": 200, "y": 100, "width": 80, "height": 20, "text": "WORD"}])


if __name__ == "__main__":
    unittest.main()
