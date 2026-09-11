/** Evaluation-only regional selector; no deployed endpoint or paid dependency. */
export const LOCATION_HINTS = Object.freeze([
  "enam", "wnam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc",
]);

function summary(samples) {
  // A timeout is a failed candidate, not a sample to delete and bias low.
  if (!Array.isArray(samples) || samples.length < 3 || samples.length > 8 ||
      samples.some(n => !Number.isFinite(n) || n < 0 || n > 5000)) return null;
  const sorted = [...samples].sort((a,b) => a-b);
  return {p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1]};
}

/** Both players probe the SAME regional object identities before choosing.
 * Reports must come from the already-authorized attempt-scoped pair channel.
 * Caller validates attempt IDs/auth; input here is timing only, never authority.
 */
export function chooseJointRegion(first, second) {
  const candidates = [];
  for(const region of LOCATION_HINTS) {
    const a = summary(first?.[region]), b = summary(second?.[region]);
    if (!a || !b) continue;
    candidates.push({region,worstP95Ms:Math.max(a.p95,b.p95),sumP50Ms:a.p50+b.p50,
      playerP50Ms:[a.p50,b.p50],playerP95Ms:[a.p95,b.p95]});
  }
  candidates.sort((a,b) => a.worstP95Ms-b.worstP95Ms || a.sumP50Ms-b.sumP50Ms ||
    LOCATION_HINTS.indexOf(a.region)-LOCATION_HINTS.indexOf(b.region));
  return candidates[0] ?? null;
}
