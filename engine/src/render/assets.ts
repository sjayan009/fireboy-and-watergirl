/** Shared downloads with bounded decode concurrency. Failed requests are retryable. */
const documents = new Map<string, Promise<unknown>>();
const images = new Map<string, { image: HTMLImageElement; ready: Promise<void> }>();
const queue: (() => void)[] = [];
let active = 0;
let revision = 0;
const LANES = 12;
function pump(): void {
  while (active < LANES && queue.length) { active++; queue.shift()!(); }
}
export function assetRevision(): number { return revision; }
export function jsonAsset<T>(url: string): Promise<T> {
  let pending = documents.get(url);
  if (pending === undefined) {
    pending = fetch(url, { cache: "force-cache" }).then(async r => {
      if (!r.ok) throw new Error(`Asset unavailable (${r.status})`);
      return r.json() as Promise<unknown>;
    }).catch(e => { documents.delete(url); throw e; });
    documents.set(url, pending);
  }
  return pending as Promise<T>;
}
export function imageAsset(url: string): { image: HTMLImageElement; ready: Promise<void> } {
  const hit = images.get(url);
  if (hit) return hit;
  const image = new Image();
  const ready = new Promise<void>((resolve, reject) => {
    queue.push(() => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true; clearTimeout(timer); active--; revision++;
        if (error) { images.delete(url); reject(error); } else resolve();
        pump();
      };
      const timer = setTimeout(() => finish(new Error("Art loading timed out")), 15000);
      image.onload = () => { void image.decode().then(() => finish(), () => finish()); };
      image.onerror = () => finish(new Error("Some game art could not be loaded"));
      image.src = url;
    });
  });
  const entry = { image, ready };
  images.set(url, entry); pump();
  return entry;
}
