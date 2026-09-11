/** This production build never embeds a billable TURN endpoint or credential. */
export function freeIceServers(value) {
  if (!value.trim()) return "";
  let servers;
  try { servers = JSON.parse(value); } catch { throw new Error("ICE_SERVERS must be a JSON array of STUN-only servers"); }
  if (!Array.isArray(servers) || servers.length > 8) throw new Error("ICE_SERVERS must contain at most eight STUN servers");
  for (const server of servers) {
    if (!server || typeof server !== "object" || Object.keys(server).some(k => k !== "urls")) throw new Error("Only STUN URLs are permitted; TURN credentials are excluded by the $0 policy");
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8 || urls.some(u => typeof u !== "string" || !/^stuns?:[^\s/@]+(?::\d+)?$/i.test(u))) throw new Error("ICE_SERVERS accepts only stun: or stuns: URLs; paid TURN is prohibited");
  }
  return JSON.stringify(servers);
}
