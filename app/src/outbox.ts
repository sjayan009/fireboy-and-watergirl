/** Account-owned, transactionally merged progress. No credentials are stored. */
export interface ProgressArrays { stats: number[]; times: number[]; timesString: string[] }
export interface PendingProgress extends ProgressArrays {
  key: string; owner: string; friendId: string; revision: string; at: number;
  attempts?: number; retryAt?: number; quarantine?: boolean; error?: string;
}

export function mergeProgress(a: ProgressArrays, b: ProgressArrays): ProgressArrays {
  const stats = Array.from({ length: 32 }, (_, i) => Math.max(a.stats[i] ?? -1, b.stats[i] ?? -1));
  const times = stats.map((medal, i) => {
    if (medal <= 0) return 0;
    const valid = [a.times[i], b.times[i]].filter(t => Number.isInteger(t) && t >= 3 && t <= 5999);
    return valid.length ? Math.min(...valid) : 0;
  });
  return { stats, times, timesString: times.map(t => t ? `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` : "") };
}

let database: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise((resolve, reject) => {
      let failed = false;
      const request = indexedDB.open("fbwg.progress", 1);
      const timer = setTimeout(() => { failed = true; reject(new Error("Progress storage timed out. Keep the page open and retry.")); }, 6000);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("outbox", { keyPath: "key" });
        store.createIndex("owner", "owner");
      };
      request.onerror = () => { clearTimeout(timer); failed = true; reject(request.error ?? new Error("Progress storage unavailable")); };
      request.onblocked = () => { clearTimeout(timer); failed = true; reject(new Error("Close older game tabs to update progress storage")); };
      request.onsuccess = () => {
        clearTimeout(timer);
        const db = request.result;
        if (failed) { db.close(); return; }
        db.onversionchange = () => { db.close(); database = null; };
        resolve(db);
      };
    });
    void database.catch(() => { database = null; });
  }
  return database;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { request.transaction?.abort(); } catch { /* already complete */ }
      reject(new Error("Progress storage request timed out"));
    }, 6000);
    request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
    request.onerror = () => { clearTimeout(timer); reject(request.error ?? new Error("Progress request failed")); };
  });
}
function done(tx: IDBTransaction): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { tx.abort(); } catch { /* already complete */ }
      reject(new Error("Progress storage transaction timed out"));
    }, 6000);
    tx.oncomplete = () => { clearTimeout(timer); resolve(); };
    tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(tx.error ?? new Error("Progress transaction failed")); };
  });
  // A failed request may reject before the caller can await transaction completion.
  void completed.catch(() => {});
  return completed;
}

export async function remember(owner: string, friendId: string, data: ProgressArrays): Promise<PendingProgress> {
  const db = await open();
  const tx = db.transaction("outbox", "readwrite");
  const completed = done(tx);
  const store = tx.objectStore("outbox");
  const key = `${owner}:${[owner, friendId].sort().join(":")}`;
  const previous = await result(store.get(key)) as PendingProgress | undefined;
  const pending = { ...mergeProgress(previous ?? data, data), key, owner, friendId, revision: crypto.randomUUID(), at: Date.now() };
  store.put(pending);
  await completed;
  return pending;
}

export async function pendingFor(owner: string): Promise<PendingProgress[]> {
  const db = await open();
  return result(db.transaction("outbox").objectStore("outbox").index("owner").getAll(owner)) as Promise<PendingProgress[]>;
}

export async function acknowledge(p: PendingProgress): Promise<void> {
  const db = await open();
  const tx = db.transaction("outbox", "readwrite");
  const completed = done(tx);
  const store = tx.objectStore("outbox");
  const current = await result(store.get(p.key)) as PendingProgress | undefined;
  if (current?.revision === p.revision && current.owner === p.owner) store.delete(p.key);
  await completed;
}

/** Delivery metadata belongs to a revision; an older failure cannot hide newer work. */
export async function deliveryFailed(p: PendingProgress, error: string, quarantine: boolean, retryAt: number): Promise<void> {
  const db = await open();
  const tx = db.transaction("outbox", "readwrite"), completed = done(tx);
  const store = tx.objectStore("outbox");
  const current = await result(store.get(p.key)) as PendingProgress | undefined;
  if (current?.revision === p.revision && current.owner === p.owner) {
    store.put({ ...current, attempts: (current.attempts ?? 0) + 1, error, quarantine, retryAt });
  }
  await completed;
}

/** Explicit retry keeps the earned arrays intact, including refused records. */
export async function retryDelivery(owner: string, friendId?: string): Promise<void> {
  const db = await open();
  const tx = db.transaction("outbox", "readwrite"), completed = done(tx);
  const store = tx.objectStore("outbox");
  const records = await result(store.index("owner").getAll(owner)) as PendingProgress[];
  for (const p of records) if (!friendId || p.friendId === friendId) {
    store.put({ ...p, retryAt: 0, quarantine: false, error: undefined });
  }
  await completed;
}
