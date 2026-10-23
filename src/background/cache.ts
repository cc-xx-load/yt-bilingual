import { CACHE_KEEP_ENTRIES, CACHE_MAX_ENTRIES } from '../shared/constants.ts';

const DB_NAME = 'ytb-cache';
const STORE = 'translations';
const DB_VERSION = 1;

interface CacheRecord {
  k: string;
  v: string;
  at: number;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'k' });
        store.createIndex('at', 'at');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('无法打开翻译缓存数据库'));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('翻译缓存数据库被占用'));
    };
  });
  return databasePromise;
}

export async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function cacheGetMany(keys: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (keys.length === 0) return result;
  const db = await openDatabase();
  return new Promise<Map<string, string>>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result as CacheRecord | undefined;
        if (record && typeof record.v === 'string') result.set(key, record.v);
      };
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error('读取翻译缓存失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('读取翻译缓存被中止'));
  });
}

export async function cachePutMany(entries: Map<string, string>): Promise<void> {
  if (entries.size === 0) return;
  const db = await openDatabase();
  const at = Date.now();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    for (const [key, value] of entries) {
      store.put({ k: key, v: value, at } satisfies CacheRecord);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('写入翻译缓存失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('写入翻译缓存被中止'));
  });
}

export async function clearCache(): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('清空翻译缓存失败'));
  });
}

/** 启动时裁剪：超过上限就从最旧的开始删到 CACHE_KEEP_ENTRIES。 */
export async function pruneCache(): Promise<void> {
  const db = await openDatabase();
  const total = await new Promise<number>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('统计翻译缓存失败'));
  });
  if (total <= CACHE_MAX_ENTRIES) return;

  let remaining = total - CACHE_KEEP_ENTRIES;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const cursorRequest = transaction.objectStore(STORE).index('at').openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || remaining <= 0) return;
      cursor.delete();
      remaining -= 1;
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('裁剪翻译缓存失败'));
  });
}
