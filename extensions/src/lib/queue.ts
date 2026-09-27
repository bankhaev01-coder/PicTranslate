/**
 * Пул воркеров с ограниченной параллельностью: элементы разбираются из FIFO-
 * очереди, следующий стартует, как только освободился воркер.
 *
 * Ошибка одной задачи не обрывает очередь (иначе одно нечитаемое изображение
 * оставило бы без перевода все следующие): исключение уходит в `onError`,
 * а оставшиеся задачи продолжают выполняться.
 *
 * `isCancelled` — элемент, для которого предикат вернул true, не запускается
 * и не считается ошибкой (пользователь убрал картинку из очереди).
 */
export async function runConcurrent<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
  onError?: (item: T, index: number, error: unknown) => void,
  isCancelled?: (item: T, index: number) => boolean,
): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const workers = Math.max(1, Math.min(normalizeLimit(limit), queue.length || 1));

  const run = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      if (isCancelled?.(next.item, next.index)) continue;
      try {
        await task(next.item, next.index);
      } catch (error) {
        onError?.(next.item, next.index, error);
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, run));
}

/** Рабочее значение лимита: минимум 1; NaN и дробные нормализуются. */
function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
}
