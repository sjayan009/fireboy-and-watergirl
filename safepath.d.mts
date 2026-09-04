/** Types for safepath.mjs, so `vite.config.ts` can use it under strict TS. */

/** The path segments a request is asking for, or null if it is not one. */
export function requestPath(url: string | undefined | null): string[] | null;

/** Where `url` lands under `root`, or null if it does not land under it. */
export function resolveUnder(root: string, url: string | undefined | null):
  string | null;

/** The same, for a request served from one of several prefixed roots. */
export function resolveMounted(
  url: string | undefined | null,
  mounts: [string, string][],
  fallback: string,
): string | null;
