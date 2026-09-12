/** Build-time ICE is public STUN only; short-lived TURN is loaded at runtime. */
export function freeIceServers(value) {
  if (!value.trim()) return "";
  let servers;
  try { servers = JSON.parse(value); } catch { throw new Error("ICE_SERVERS must be a JSON array of STUN-only servers"); }
  if (!Array.isArray(servers) || servers.length > 8) throw new Error("ICE_SERVERS must contain at most eight STUN servers");
  for (const server of servers) {
    if (!server || typeof server !== "object" || Array.isArray(server) || Object.keys(server).some(k => k !== "urls")) throw new Error("Static ICE accepts STUN URLs only; use the runtime broker for short-lived TURN credentials");
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8 || urls.some(u => typeof u !== "string" || !/^stuns?:[^\s/@]+(?::\d+)?$/i.test(u))) throw new Error("Static ICE_SERVERS accepts only stun: or stuns: URLs; load short-lived TURN through the runtime broker");
  }
  return JSON.stringify(servers);
}
