// Minimal promise wrapper around one IndexedDB object store. Every call fails
// soft (resolves undefined / no-op) so private windows or blocked storage only
// lose persistence, never the scan itself.

const DB_NAME = "sk-brickhouse";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export const idbGet = <T>(key: string) => run<T>("readonly", (store) => store.get(key));
export const idbSet = (key: string, value: unknown) => run("readwrite", (store) => store.put(value, key));
export const idbDelete = (key: string) => run("readwrite", (store) => store.delete(key));
