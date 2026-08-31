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
