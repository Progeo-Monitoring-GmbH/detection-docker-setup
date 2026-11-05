/**
 * The chunked build of the device statistics (GET /v1/status/device_statistics/
 * ?plan=1 / ?build=..&chunk=k / ?build=..&finish=1): the page scans the project
 * databases chunk by chunk and shows the counts so far - they are sums, so
 * the chunks' counts add up to the finished snapshot's.
 */

export type TypeCount = { type: string; label: string; count: number };

/** a + b per key (keys of either). */
export const addCounts = <T extends Record<string, number>>(a: T, b: Partial<T>): T => {
  const sum = { ...a } as Record<string, number>;
  Object.entries(b).forEach(([key, value]) => {
    sum[key] = (sum[key] ?? 0) + (Number(value) || 0);
  });
  return sum as T;
};

/** The type counts of both, ordered like the backend: most devices first, then by type. */
export const mergeTypeCounts = (a: TypeCount[], b: TypeCount[]): TypeCount[] => {
  const merged = new Map(a.map((row) => [row.type, { ...row }]));
  b.forEach((row) => {
    const known = merged.get(row.type);
    if (known) {
      known.count += row.count;
    } else {
      merged.set(row.type, { ...row });
    }
  });
  return [...merged.values()].sort((x, y) => y.count - x.count || x.type.localeCompare(y.type));
};

/**
 * worker(0) .. worker(count - 1), at most `concurrency` at a time (each chunk
 * request already queries its databases in parallel on the server). Stops
 * starting new ones once one failed (its error is thrown) or `cancelled()`.
 */
export const runChunks = async (
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
  cancelled: () => boolean = () => false,
): Promise<void> => {
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (next < count && !failed && !cancelled()) {
      const index = next;
      next += 1;
      try {
        await worker(index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(concurrency, count)) }, lane));
};
