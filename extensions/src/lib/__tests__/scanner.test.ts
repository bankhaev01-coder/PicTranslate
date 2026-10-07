// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { scanImages } from '../scanner';

function addImg(src: string): HTMLImageElement {
  const img = document.createElement('img');
  img.src = src;
  Object.defineProperty(img, 'naturalWidth', { value: 200 });
  Object.defineProperty(img, 'naturalHeight', { value: 200 });
  img.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 200, bottom: 200, width: 200, height: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(img);
  return img;
}

describe('scanImages ids', () => {
  it('keeps the id of an already scanned image when new images appear before it', () => {
    document.body.innerHTML = '';
    const a = addImg('https://x.test/a.png');
    const idA = scanImages(50)[0].id;
    const b = addImg('https://x.test/b.png');
    document.body.insertBefore(b, a); // b теперь первый в DOM
    const second = scanImages(50);
    expect(second.find((i) => i.src.endsWith('a.png'))?.id).toBe(idA);
    expect(second.find((i) => i.src.endsWith('b.png'))?.id).not.toBe(idA);
  });
  it('re-assigns a duplicated id copied with a cloned node', () => {
    document.body.innerHTML = '';
    const a = addImg('https://x.test/a.png');
    scanImages(50);
    const clone = addImg('https://x.test/c.png');
    clone.dataset.translateExtId = a.dataset.translateExtId;
    const ids = scanImages(50).map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
  });
});
