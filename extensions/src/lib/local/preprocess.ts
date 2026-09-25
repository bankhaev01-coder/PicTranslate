/**
 * Чистые пиксельные хелперы для OCR-предобработки (без DOM — юнит-тестируемые).
 * Порт backend-функции `_preprocess` (оттенки серого) на RGBA-данные in place.
 */
export function grayscaleInPlace(rgba: Uint8ClampedArray): void {
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    // Luma по ITU-R BT.601 — те же коэффициенты, что в Python-бэкенде (PIL 'L').
    const l = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) | 0;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = l;
  }
}
