/**
 * @owner       src::core::bounded-top-k
 * @does        Retain the best k values from an iterable with a bounded worst-first binary heap.
 * @needs       A total ordering supplied by the caller.
 * @feeds       Discovery ranking and local compute-ref observation.
 * @breaks      Reversing the comparator or losing tie order changes public ranking results.
 * @invariants  compareBest follows Array.sort semantics; heap[0] is the worst retained value; the returned array is best-first.
 * @side-effects None.
 * @perf        O(n log k) time and O(k) space.
 * @concurrency Pure and reentrant.
 * @test        tests/unit/search.test.ts, tests/unit/compute-observe.test.ts
 * @stability   stable
 * @since       2026-07-31
 */

export type BestFirstComparator<T> = (left: T, right: T) => number;

export class BoundedTopK<T> {
  private readonly heap: T[] = [];
  readonly limit: number;

  constructor(
    limit: number,
    private readonly compareBest: BestFirstComparator<T>,
  ) {
    this.limit = Math.max(0, Math.floor(limit));
  }

  get size(): number {
    return this.heap.length;
  }

  add(value: T): void {
    if (this.limit === 0) return;
    pushBounded(this.heap, value, this.limit, this.compareBest);
  }

  values(): T[] {
    return [...this.heap].sort(this.compareBest);
  }
}

export function boundedTopK<T>(
  values: Iterable<T>,
  limit: number,
  compareBest: BestFirstComparator<T>,
): T[] {
  const topK = new BoundedTopK(limit, compareBest);
  for (const value of values) {
    topK.add(value);
  }
  return topK.values();
}

function pushBounded<T>(
  heap: T[],
  value: T,
  limit: number,
  compareBest: BestFirstComparator<T>,
): void {
  if (heap.length < limit) {
    heap.push(value);
    siftWorstUp(heap, heap.length - 1, compareBest);
    return;
  }

  const worst = heap[0];
  if (worst === undefined || compareBest(value, worst) >= 0) return;
  heap[0] = value;
  siftWorstDown(heap, 0, compareBest);
}

function siftWorstUp<T>(
  heap: T[],
  start: number,
  compareBest: BestFirstComparator<T>,
): void {
  let child = start;
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2);
    if (!isWorse(heap[child]!, heap[parent]!, compareBest)) return;
    [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
    child = parent;
  }
}

function siftWorstDown<T>(
  heap: T[],
  start: number,
  compareBest: BestFirstComparator<T>,
): void {
  let parent = start;
  while (true) {
    const left = parent * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    const worstChild =
      right < heap.length && isWorse(heap[right]!, heap[left]!, compareBest)
        ? right
        : left;
    if (!isWorse(heap[worstChild]!, heap[parent]!, compareBest)) return;
    [heap[parent], heap[worstChild]] = [heap[worstChild]!, heap[parent]!];
    parent = worstChild;
  }
}

function isWorse<T>(
  left: T,
  right: T,
  compareBest: BestFirstComparator<T>,
): boolean {
  return compareBest(left, right) > 0;
}
