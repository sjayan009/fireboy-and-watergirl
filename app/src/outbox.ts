/** Account-owned, transactionally merged progress. No credentials are stored. */
export interface ProgressArrays { stats: number[]; times: number[]; timesString: string[] }
export interface PendingProgress extends ProgressArrays {
  key: string; owner: string; friendId: string; revision: string; at: number;
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
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("outbox", { keyPath: "key" });
        store.createIndex("owner", "owner");
      };
      request.onerror = () => { failed = true; reject(request.error ?? new Error("Progress storage unavailable")); };
      request.onblocked = () => { failed = true; reject(new Error("Close older game tabs to update progress storage")); };
      request.onsuccess = () => {
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Progress request failed"));
  });
}
function done(tx: IDBTransaction): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Progress transaction failed"));
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
