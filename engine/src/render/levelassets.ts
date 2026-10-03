import { assetUrl } from "../asseturl.js";
import { createAssetOwner, type AssetOwner, type AssetOptions } from "./assets.js";

export interface LevelDependencyManifest {
  schema: 1; identity: string; common: { critical: string[] };
  fallbacks?: Record<string, string[]>;
  levels: Record<string, { symbols: number[]; critical: string[]; background: string[] }>;
}
export interface PreparationCounts { total: number; ready: number; failed: number; }
export type PreparationStatus = "ready" | "complete" | "partial";
export interface PreparedLevelAssets {
  owner: AssetOwner; identity: string; critical: PreparationCounts; background: PreparationCounts;
  status: PreparationStatus; complete: Promise<PreparationStatus>;
  /** Failed resources are explicitly retried, including after a partially successful preparation. */
  retry(): Promise<PreparationStatus>; release(): void;
}
export interface LevelPreparationOptions extends AssetOptions {
  onProgress?: (stage: "metadata" | "critical" | "background", counts: PreparationCounts) => void;
}

function safeFiles(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(file => typeof file === "string" &&
    !file.includes("..") && !file.includes("\\") && !file.startsWith("/") && !file.includes(":"));
}
/** Manifest barrier, with stable unique-resource denominators. Does not allocate a simulation world. */
export async function prepareLevelAssets(base: string, mode: string, num: number,
    options: LevelPreparationOptions = {}): Promise<PreparedLevelAssets> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const owner = createAssetOwner({ priority: "critical", signal: controller.signal });
  const started = performance.now(), deadline = options.deadlineMs ?? 30000;
  const timer = setTimeout(() => controller.abort(new Error("Level preparation deadline exceeded")), deadline);
  const release = (): void => {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort); owner.release();
  };
  const ensureLive = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Preparation cancelled", "AbortError");
    if (owner.released) throw new DOMException("Preparation cancelled", "AbortError");
  };
  try {
    options.onProgress?.("metadata", { total: 1, ready: 0, failed: 0 });
    const [manifest, sprites] = await Promise.all([
      owner.json<LevelDependencyManifest>(assetUrl(base, "levels.json"), { deadlineMs: deadline }),
      owner.json<{ levelDependencies?: string }>(assetUrl(base, "sprites.json"), { deadlineMs: deadline }),
    ]);
    ensureLive();
    options.onProgress?.("metadata", { total: 1, ready: 1, failed: 0 });
    if (manifest.schema !== 1 || !/^[a-f0-9]{64}$/.test(manifest.identity) || !safeFiles(manifest.common?.critical)) {
      throw new Error("Unsupported level dependency manifest");
    }
    if (sprites.levelDependencies && sprites.levelDependencies !== manifest.identity) {
      throw new Error("Sprite and level dependency releases disagree");
    }
    if (manifest.fallbacks && Object.values(manifest.fallbacks).some(files => !safeFiles(files))) {
      throw new Error("Unsupported atlas fallback resources");
    }
    const entry = manifest.levels[`${mode}-${String(num).padStart(2, "0")}`];
    if (!entry || !safeFiles(entry.critical) || !safeFiles(entry.background)) throw new Error("Level dependencies unavailable");
    const criticalFiles = [...new Set([...manifest.common.critical, ...entry.critical])];
    const backgroundFiles = [...new Set(entry.background)].filter(file => !criticalFiles.includes(file));
    const critical = { total: criticalFiles.length, ready: 0, failed: 0 };
    const background = { total: backgroundFiles.length, ready: 0, failed: 0 };
    const failed = new Set<string>();
    let retryWork: Promise<PreparationStatus> | null = null;
    let retryAttempts = 0;
    const load = async (files: string[], counts: PreparationCounts, stage: "critical" | "background", retry = false): Promise<void> => {
      await Promise.all(files.map(async file => {
        ensureLive();
        const remaining = retry ? 15000 : Math.max(1, deadline - (performance.now() - started));
        try {
          const resourceOptions = { priority: stage === "critical" ? "critical" as const : "background" as const, deadlineMs: Math.min(15000, remaining) };
          try { await owner.image(assetUrl(base, file), resourceOptions).ready; }
          catch (error) {
            ensureLive();
            const alternatives = manifest.fallbacks?.[file];
            if (!alternatives?.length) throw error;
            await Promise.all(alternatives.map(alternative => owner.image(assetUrl(base, alternative), resourceOptions).ready));
          }
          if (retry) counts.failed--;
          counts.ready++; failed.delete(file);
        } catch (error) {
          ensureLive();
          if (!retry) counts.failed++;
          failed.add(file);
          // Art failure is a partial state with an explicit retry, rather than an endless Preparing screen.
          if (error instanceof DOMException && error.name === "AbortError") throw error;
        }
        options.onProgress?.(stage, { ...counts });
      }));
      ensureLive();
    };
    await load(criticalFiles, critical, "critical");
    const result: PreparedLevelAssets = {
      owner, identity: manifest.identity, critical, background,
      status: critical.failed ? "partial" : "ready", release,
      complete: Promise.resolve("ready"),
      retry: () => retryWork ?? (retryWork = (async () => {
        ensureLive();
        await result.complete;
        // Coalesce repeated presses and bound retry cadence during a persistent outage.
        if (retryAttempts++) await new Promise<void>(resolve => setTimeout(resolve, Math.min(2000, 250 * 2 ** Math.min(retryAttempts - 2, 3))));
        ensureLive();
        await load(criticalFiles.filter(file => failed.has(file)), critical, "critical", true);
        await load(backgroundFiles.filter(file => failed.has(file)), background, "background", true);
        result.status = failed.size ? "partial" : "complete";
        return result.status;
      })().finally(() => { retryWork = null; })),
    };
    result.complete = load(backgroundFiles, background, "background").then(() => {
      result.status = failed.size ? "partial" : "complete";
      clearTimeout(timer);
      return result.status;
    });
    // Cancellation remains observable to callers without creating an unhandled rejection on optional work.
    void result.complete.catch(() => undefined);
    return result;
  } catch (error) { release(); throw error; }
}
