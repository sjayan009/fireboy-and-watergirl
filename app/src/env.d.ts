/**
 * Injected by vite.config.ts, which names the two public values explicitly so
 * that a secret cannot reach the bundle by being mis-prefixed.
 */
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_KEY__: string;

/**
 * A JSON array of RTCIceServer, or an empty string for the built-in STUN pair.
 * Replaced at build time, so nothing about it reaches the browser as a lookup.
 */
declare const __ICE_SERVERS__: string;

/** Public rollout switches; TURN credentials are fetched only at runtime. */
declare const __PATH_MANAGER__: boolean;
declare const __LEGACY_RELAY_BATCHING__: boolean;
declare const __ROLLBACK_SMOOTHING__: boolean;
declare const __DESCENDANT_INTERPOLATION__: boolean;

/**
 * Where the extracted art and audio are fetched from.
 *
 * A bare path in development and a path with a release marker on the query in a
 * build, so that the one-year `immutable` cache policy the deployment applies
 * to that subtree is a promise the build can keep. See `app/scripts/release.mjs`.
 */
declare const __ASSETS__: string;
