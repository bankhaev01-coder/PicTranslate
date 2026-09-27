import { describe, expect, it } from 'vitest';
import { runConcurrent } from '../queue';

const tick = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms));

describe('runConcurrent', () => {
  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await runConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
      await tick(0);
    });
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('passes the original index to the task', async () => {
    const pairs: Array<[string, number]> = [];
    await runConcurrent(['a', 'b', 'c'], 3, async (item, index) => {
      pairs.push([item, index]);
      await tick(0);
    });
    expect([...pairs].sort((a, b) => a[1] - b[1])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('never exceeds the requested parallelism', async () => {
    let active = 0;
    let peak = 0;
    await runConcurrent(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(1);
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('keeps going after a failed task and reports it through onError', async () => {
    const completed: number[] = [];
    const failures: Array<[number, unknown]> = [];
    await runConcurrent(
      [1, 2, 3, 4],
      1,
      async (n) => {
        if (n === 2) throw new Error('boom');
        completed.push(n);
        await tick(0);
      },
      (item, _index, error) => failures.push([item, error]),
    );
    expect(completed).toEqual([1, 3, 4]);
    expect(failures).toHaveLength(1);
    const failure = failures.at(0);
    expect(failure?.[0]).toBe(2);
    expect(String(failure?.[1])).toContain('boom');
  });

  it('treats a non-positive or invalid concurrency as 1', async () => {
    let active = 0;
    let peak = 0;
    await runConcurrent([1, 2, 3], 0, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(1);
      active -= 1;
    });
    expect(peak).toBe(1);
  });

  it('resolves for an empty input', async () => {
    await expect(runConcurrent([], 3, async () => tick(0))).resolves.toBeUndefined();
  });

  it('skips cancelled items without running or reporting them', async () => {
    const ran: number[] = [];
    const failures: number[] = [];
    await runConcurrent(
      [1, 2, 3, 4],
      1,
      async (n) => {
        ran.push(n);
        await tick(0);
      },
      (item) => failures.push(item),
      (n) => n === 2 || n === 3,
    );
    expect(ran).toEqual([1, 4]);
    expect(failures).toEqual([]);
  });

  it('does not treat a cancelled in-flight item as an error', async () => {
    // Отмена проверяется только перед стартом: уже начатая задача дорабатывает.
    let cancelled = false;
    const ran: string[] = [];
    await runConcurrent(
      ['a', 'b'],
      1,
      async (n) => {
        ran.push(n);
        if (n === 'a') cancelled = true; // пользователь убрал первую картинку
        await tick(0);
      },
      () => {
        throw new Error('onError must not fire');
      },
      () => cancelled,
    );
    expect(ran).toEqual(['a']); // 'b' пропущена после отмены
  });
});
