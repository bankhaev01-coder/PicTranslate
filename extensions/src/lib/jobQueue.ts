/**
 * Dynamic job queue with a concurrency limit.
 *
 * Unlike `runConcurrent`, jobs are appended while consuming (region selected
 * -> crop from the captured frame -> translation request) instead of one
 * fixed list. The limit can be raised at runtime: the new parallelism applies
 * to the next starts, already running jobs are not interrupted.
 *
 * A failed job does not break the queue: the worker handles its own
 * exceptions, and the safety net swallows them so one failure cannot stop
 * the rest. `drain()` resolves when the queue is empty and no jobs are active
 * (it may be awaited repeatedly - all waiters respond in order).
 */

export interface JobQueue<T> {
  /** Enqueue a job; starts right away if a slot is free. */
  push(job: T): void;
  /** New concurrency limit (at least 1); applies to the next starts. */
  setLimit(limit: number): void;
  /** Resolves when the queue is empty and all active jobs have finished. */
  drain(): Promise<void>;
  /** How many jobs are waiting to start. */
  readonly pending: number;
}
export function createJobQueue<T>(limit: number, worker: (job: T) => Promise<void>): JobQueue<T> {
  const queue: T[] = [];
  const waiters: Array<() => void> = [];
  let active = 0;
  let max = normalizeLimit(limit);

  const settleIdle = () => {
    if (active === 0 && queue.length === 0) {
      for (const resolve of waiters.splice(0)) resolve();
    }
  };

  const pump = () => {
    while (active < max && queue.length > 0) {
      const job = queue.shift()!;
      active += 1;
      // Асинхронная обёртка стартует worker синхронно (старт виден сразу) и
      // превращает синхронное исключение в rejected promise.
      void (async () => worker(job))()
        .catch(() => undefined) // страховка: worker обязан глотать свои ошибки
        .then(() => {
          active -= 1;
          pump();
          settleIdle();
        });
    }
    settleIdle();
  };

  return {
    push(job) {
      queue.push(job);
      pump();
    },
    setLimit(next) {
      max = normalizeLimit(next);
      pump();
    },
    drain() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    get pending() {
      return queue.length;
    },
  };
}

/** Рабочее значение лимита: минимум 1; NaN и дробные нормализуются. */
function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
}