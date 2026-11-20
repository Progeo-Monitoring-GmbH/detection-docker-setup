/**
 * The locations overview's last loaded list, kept in the browser (IndexedDB)
 * per user: a reload shows it at once and refreshes it in the background
 * (LocationsOverview) - no empty table while /v1/location/min/ and the
 * details / alarm summaries load again.
 *
 * IndexedDB, not localStorage: with the details a few thousand rows exceed
 * localStorage's ~5 MB. Every failure (private window, blocked storage, no
 * IndexedDB at all as in jsdom) means "no cache" - the page loads as without.
 * Cleared on logout (CoreAuthProvider): the list names the user's projects.
 */

const DB_NAME = 'progeo-cache';
const STORE = 'kv';
/** Bumped when the shape of the cached rows changes - an old entry is ignored. */
const VERSION = 1;
const KEY_PREFIX = 'locations-overview:';

export type OverviewCacheEntry<Row, Summary> = {
  version: number;
  savedAt: number;
  rows: Row[];
  alarmSummary: Record<string, Summary>;
};

/** The cache key of a user - what /min lists depends on who asks (and on
 * "view as normal user", which the backend sees too). Null without a user. */
export const overviewCacheKey = (
  user: { user_id?: unknown } | null | undefined,
  viewAsUser = false,
): string | null => {
  const id = user?.user_id;
  if (id == null || id === '') {
    return null;
  }
  return `${KEY_PREFIX}${String(id)}${viewAsUser ? ':as-user' : ''}`;
};

let opening: Promise<IDBDatabase | null> | null = null;

const openDb = (): Promise<IDBDatabase | null> => {
  if (opening) {
    return opening;
  }
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  // A failed open is tried again next time (storage may be allowed later).
  void opening.then((db) => {
    if (!db) {
      opening = null;
    }
  });
  return opening;
};

/** Runs one request on the store; resolves `fallback` on any failure. */
const withStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
  fallback: T,
): Promise<T> => {
  const db = await openDb();
  if (!db) {
    return fallback;
  }
  return new Promise<T>((resolve) => {
    try {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve((request.result as T) ?? fallback);
      request.onerror = () => resolve(fallback);
    } catch {
      resolve(fallback);
    }
  });
};

/** The cached list of `key` - null when there is none (or it is unreadable / outdated). */
export const readOverviewCache = async <Row, Summary>(
  key: string | null,
): Promise<OverviewCacheEntry<Row, Summary> | null> => {
  if (!key) {
    return null;
  }
  const entry = await withStore<OverviewCacheEntry<Row, Summary> | null>(
    'readonly',
    (store) => store.get(key),
    null,
  );
  return entry && entry.version === VERSION && Array.isArray(entry.rows) ? entry : null;
};

export const writeOverviewCache = async <Row, Summary>(
  key: string | null,
  rows: Row[],
  alarmSummary: Record<string, Summary>,
): Promise<void> => {
  if (!key) {
    return;
  }
  const entry: OverviewCacheEntry<Row, Summary> = { version: VERSION, savedAt: Date.now(), rows, alarmSummary };
  await withStore('readwrite', (store) => store.put(entry, key), undefined);
};

/** Every user's cached list - on logout, so the next person at this browser sees none of it. */
export const clearOverviewCaches = async (): Promise<void> => {
  await withStore(
    'readwrite',
    (store) => store.delete(IDBKeyRange.bound(KEY_PREFIX, `${KEY_PREFIX}￿`)),
    undefined,
  );
};
