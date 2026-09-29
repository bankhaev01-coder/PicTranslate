import { describe, expect, it, vi } from 'vitest';
import { createJobQueue } from '../jobQueue';

/** Deterministic worker: record starts, release manually. */
function controlledWorker(starts: number[]) {
  const releases: Array<() => void> = [];
  const worker = vi.fn((n: number) => {
    starts.push(n);
    return new Promise<void>((resolve) => releases.push(resolve));
  });
  return {
    worker,
    releaseOne: () => releases.shift()?.(),
    pendingReleases: () => releases.length,
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createJobQueue', () => {
  it('держит лимит параллельности и разбирает задачи по FIFO', async () => {
    const starts: number[] = [];
    const { worker, releaseOne, pendingReleases } = controlledWorker(starts);
    const q = createJobQueue<number>(2, worker);

    for (const n of [1, 2, 3, 4, 5]) q.push(n);

    // first two started, the rest wait for a slot.
    expect(starts).toEqual([1, 2]);
    expect(q.pending).toBe(3);

    releaseOne(); // освободился слот → стартует третий
    await tick();
    expect(starts).toEqual([1, 2, 3]);

    while (pendingReleases() > 0) {
      releaseOne();
      await tick();
    }
    expect(starts).toEqual([1, 2, 3, 4, 5]);
    await q.drain();
  });

  it('setLimit поднимает параллелизм для ожидающих задач', async () => {
    const starts: number[] = [];
    const { worker, releaseOne } = controlledWorker(starts);
    const q = createJobQueue<number>(1, worker);

    for (const n of [1, 2, 3]) q.push(n);
    expect(starts).toEqual([1]);

    q.setLimit(3);
    expect(starts).toEqual([1, 2, 3]);
    expect(q.pending).toBe(0);

    releaseOne();
    releaseOne();
    releaseOne();
    await q.drain();
  });

  it('drain на пустой очереди резолвится сразу, после задач — дожидается всех', async () => {
    const starts: number[] = [];
    const { worker, releaseOne } = controlledWorker(starts);
    const q = createJobQueue<number>(1, worker);

    await expect(q.drain()).resolves.toBeUndefined();

    q.push(1);
    q.push(2);
    let drained = false;
    void q.drain().then(() => (drained = true));
    await tick();
    expect(drained).toBe(false);

    releaseOne();
    await tick();
    expect(drained).toBe(false); // вторая ещё активна

    releaseOne();
    await tick();
    expect(drained).toBe(true);
  });

  it('ошибка worker не останавливает очередь', async () => {
    const seen: number[] = [];
    const q = createJobQueue<number>(1, async (n) => {
      seen.push(n);
      if (n === 1) throw new Error('boom');
    });

    q.push(1);
    q.push(2);
    await q.drain();
    expect(seen).toEqual([1, 2]);
  });

  it('задача, поставленная во время работы, входит в тот же drain', async () => {
    const starts: number[] = [];
    const { worker, releaseOne } = controlledWorker(starts);
    const q = createJobQueue<number>(1, worker);

    q.push(1);
    const drained = q.drain();
    q.push(2); // добавлено после drain — ожидающий всё равно дождётся
    releaseOne();
    await tick();
    releaseOne();
    await drained;
    expect(starts).toEqual([1, 2]);
  });

  it('некорректный лимит нормализуется к минимуму 1', async () => {
    const starts: number[] = [];
    const { worker, releaseOne } = controlledWorker(starts);
    const q = createJobQueue<number>(Number.NaN, worker);

    q.push(1);
    q.push(2);
    expect(starts).toEqual([1]); // не 0 (мёртвая очередь) и не 2

    q.setLimit(0);
    expect(starts).toEqual([1]);
    releaseOne();
    await tick();
    releaseOne();
    await q.drain();
    expect(starts).toEqual([1, 2]);
  });
});