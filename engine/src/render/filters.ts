/**
 * Flash filters, approximated with CSS `drop-shadow` on a canvas context.
 *
 * `level.as` applies exactly four, and all four are visible:
 *
 *   pers1.filters  = [GlowFilter(0xFF6600, 1, 20, 20, 1, 1)]      orange glow
 *   pers2.filters  = [GlowFilter(0x8AE7FF, 1, 20, 20, 1, 1)]      blue glow
 *   texture1       = [GlowFilter(0, 100, 1.2, 1.2, 1000, 3)]      hard outline
 *   GroundMC       = [GlowFilter(0, 100, 1.2, 1.2, 1000, 5),
 *                     DropShadowFilter(8, 45, 0, 1, 4, 4, 0.5, 3)]
 *
 * A Flash glow is a blur of the shape's alpha in a flat colour, composited
 * behind it -- which is what `drop-shadow` with no offset does. `strength` is
 * an alpha multiplier that Flash applies before clamping, so a large value
 * means "opaque outline" rather than "very blurry"; chaining the shadow a few
 * times reproduces that, and the chain is capped because each pass costs a
 * full-layer blur and the result saturates almost immediately.
 */

export interface FlashFilter {
  // GlowFilter and DropShadowFilter share these
  color?: number;
  alpha?: number;
  blurX?: number;
  blurY?: number;
  strength?: number;
  // DropShadowFilter only
  distance?: number;
  angle?: number;
  inner?: boolean;
  knockout?: boolean;
  hideObject?: boolean;
}

const DEG = Math.PI / 180;
/** Beyond a few passes a drop-shadow chain is visually identical and just slow. */
const MAX_PASSES = 3;

function rgba(color: number, alpha: number): string {
  const c = (color ?? 0) >>> 0;
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  // Flash allows alpha > 1 (the terrain asks for 100) as a saturation trick
  const a = Math.max(0, Math.min(1, alpha ?? 1));
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Build a CSS filter string for a Flash filter list, or "" if there is
 * nothing we can express. `scale` converts Flash pixels to the current
 * canvas units so a glow does not grow when the stage is scaled.
 */
export function cssFilter(filters: FlashFilter[], scale = 1): string {
  const parts: string[] = [];
  for (const f of filters ?? []) {
    if (!f || f.inner || f.knockout) continue;   // not expressible; skip
    // CSS blur radius is roughly half Flash's blurX
    const blur = Math.max(0, ((f.blurX ?? 0) + (f.blurY ?? 0)) / 4) * scale;
    const dist = (f.distance ?? 0) * scale;
    const ang = (f.angle ?? 45) * DEG;
    const dx = dist ? dist * Math.cos(ang) : 0;
    const dy = dist ? dist * Math.sin(ang) : 0;
    const col = rgba(f.color ?? 0, f.alpha ?? 1);
    const passes = Math.max(1, Math.min(MAX_PASSES,
                                        Math.round(f.strength ?? 1)));
    const one = `drop-shadow(${dx.toFixed(2)}px ${dy.toFixed(2)}px ` +
                `${blur.toFixed(2)}px ${col})`;
    for (let i = 0; i < passes; i++) parts.push(one);
  }
  return parts.join(" ");
}

/** Does this filter list produce anything worth a separate render pass? */
export function hasVisibleFilter(filters: FlashFilter[] | undefined): boolean {
  if (!filters || filters.length === 0) return false;
  return filters.some((f) => f && !f.inner && !f.knockout);
}
