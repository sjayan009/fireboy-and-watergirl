/**
 * The fan's airflow, drawn as rising streaks instead of the SWF's wind art.
 *
 * The original `Wind` clip is a 250x400 bitmap of blurry grey haze. The
 * renderer applies the clip's height but not its width, so it was drawn at its
 * full 394 px art width and spilled well past the shaft (measured: 80-100
 * canvas px of visible haze over a 32 px force area), reading as smoke, not
 * moving air. This draws what the fan does instead: thin light
 * streaks travelling downstream inside the area that actually pushes, brightest
 * at the fan mouth and thinning out with distance, over a faint column.
 *
 * Visual only. It reads the clip's transform and its `insideWind` rotation and
 * writes nothing, so the simulation, its digest and ENGINE_VERSION are
 * untouched. The game still decides where a fan is and whether it is on
 * (`winder.visible`); this only changes how an on fan looks.
 *
 * Sizes are in level pixels (20 per tile), so streaks keep their thickness
 * whatever the fan's box and the output scale.
 */
import type { Ported } from "../ported.js";

/** CreateWind pads the box 15 level px each side across the flow; the push stops at the box. */
const PAD = 30;
const TINT = "219, 247, 255";

interface Streak { x: number; len: number; speed: number; phase: number; width: number; alpha: number; sway: number }

/** Deterministic per-index streak parameters, so every fan of a size looks alike. */
function streak(i: number): Streak {
  let s = (i + 1) * 0x9e3779b9;
  const rnd = (): number => {
    s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d);
    s = Math.imul(s ^ (s >>> 12), 0x297a2d39);
    return ((s ^= s >>> 15) >>> 0) / 4294967296;
  };
  return {
    x: 0.12 + 0.76 * rnd(), len: 0.10 + 0.14 * rnd(), speed: 120 + 100 * rnd(), phase: rnd(),
    width: 1.2 + rnd(), alpha: 0.35 + 0.35 * rnd(), sway: rnd() * Math.PI * 2,
  };
}
const STREAKS = Array.from({ length: 64 }, (_, i) => streak(i));

let reduced: MediaQueryList | null | undefined;

function reducedMotion(): boolean {
  if (reduced === undefined) reduced = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  return reduced?.matches ?? false;
}

/**
 * Draw a Wind clip whose transform is already on `ctx`. `now` is the
 * renderer's presentation clock, in ms.
 */
export function drawWind(ctx: CanvasRenderingContext2D, node: Ported, now: number): void {
  const m = ctx.getTransform();
  const rot = (((node.insideWind?.rotation ?? 0) % 360) + 360) % 360;
  // Downstream in the clip's space: the art blows up (-y) and insideWind turns it.
  const rad = rot * Math.PI / 180;
  const dx = Math.round(Math.sin(rad)), dy = Math.round(-Math.cos(rad));
  const vertical = dx === 0;

  // The box comes from the game, not the art: CreateWind puts the clip at the
  // centre of the fan's area and sets width/height to it in level px (plus PAD
  // across the flow). The matrix only supplies position, direction and zoom --
  // its own stretch is the renderer's, which applies height but not width.
  const along = vertical ? node.height : node.width;
  const cross = vertical ? node.width : node.height;
  const unit = Math.hypot(m.a, m.b) / Math.abs(node.scaleX || 1);
  const [ax, ay] = [m.a * dx + m.c * dy, m.b * dx + m.d * dy];
  const n = Math.hypot(ax, ay);
  if (!(along > 0 && cross > 0 && unit > 0 && n > 0)) return;
  const ux = ax / n, uy = ay / n;
  const length = along;
  const width = Math.max(4, cross - PAD);
  const cx = m.e, cy = m.f;

  // Reduced motion: the same picture, held still.
  const t = reducedMotion() ? 0 : now / 1000;

  ctx.save();
  // Level px along (s, from the fan at -length/2 downstream) and across (c).
  ctx.setTransform(ux * unit, uy * unit, -uy * unit, ux * unit, cx, cy);
  ctx.globalCompositeOperation = "screen";
  const s0 = -length / 2;

  // The column: faint, strongest at the fan, soft at its sides. Canvas has no
  // two-axis gradient, so the side falloff is the fill and the fade along the
  // flow is stepped in slices.
  const col = ctx.createLinearGradient(0, -width / 2, 0, width / 2);
  col.addColorStop(0, `rgba(${TINT}, 0)`);
  col.addColorStop(0.3, `rgba(${TINT}, 1)`);
  col.addColorStop(0.7, `rgba(${TINT}, 1)`);
  col.addColorStop(1, `rgba(${TINT}, 0)`);
  ctx.fillStyle = col;
  const base = ctx.globalAlpha;
  const SLICES = 12;
  for (let i = 0; i < SLICES; i++) {
    ctx.globalAlpha = base * (0.13 - 0.10 * (i + 0.5) / SLICES);
    ctx.fillRect(s0 + length * i / SLICES, -width / 2, length / SLICES + 0.5, width);
  }
  ctx.globalAlpha = base;

  // A soft glow at the fan mouth.
  ctx.save();
  ctx.translate(s0, 0);
  ctx.scale(Math.max(1, length * 0.12) / width, 1);
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, width * 0.6);
  glow.addColorStop(0, `rgba(${TINT}, 0.24)`);
  glow.addColorStop(1, `rgba(${TINT}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(-width * 0.6, -width * 0.6, width * 1.2, width * 1.2);
  ctx.restore();

  // The streaks: about one per 470 square level px, the density the mockup chose.
  const count = Math.min(STREAKS.length, Math.max(6, Math.round(length * width / 470)));
  ctx.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const k = STREAKS[i];
    const p = ((k.phase + t * k.speed / length) % 1 + 1) % 1;
    const len = Math.min(60, k.len * length);
    const head = s0 + p * length, tail = head - len;
    const c = (k.x - 0.5) * width + 1.3 * Math.sin(k.sway + t * 6.5);
    const life = Math.pow(Math.sin(Math.PI * Math.min(1, p * 1.15)), 0.7);
    const a = k.alpha * life;
    if (a < 0.01) continue;
    const g = ctx.createLinearGradient(tail, 0, head, 0);
    g.addColorStop(0, `rgba(${TINT}, 0)`);
    g.addColorStop(1, `rgba(${TINT}, ${a.toFixed(3)})`);
    ctx.strokeStyle = g;
    ctx.lineWidth = k.width;
    ctx.beginPath();
    ctx.moveTo(Math.max(s0, tail), c);
    ctx.lineTo(head, c);
    ctx.stroke();
  }
  ctx.restore();
}
