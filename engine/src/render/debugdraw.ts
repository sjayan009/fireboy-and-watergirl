/**
 * Canvas renderer for the ported world.
 *
 * This draws the *physics*, not the original art: every Box2D shape, coloured
 * by the userData tag the game gives it. That makes it a verification tool as
 * much as a display -- if the collision world is wrong, you see it directly,
 * which sprite art would hide.
 *
 * CreateGround positions its clips at `col * 20`, so the world is 20px/tile.
 */
import { b2Shape } from
  "../box2d/box2d.js";

export const PPU = 20;              // pixels per world unit (tile)
export const WORLD_COLS = 39;
export const WORLD_ROWS = 29;

/**
 * Colour by the shape's userData tag, the body's userData name, or -- for
 * things the game never names, like diamonds -- the SWF library symbol of the
 * MovieClip attached to the body.
 */
function colorFor(shapeData: any, bodyName: string,
                  symbol: string): [string, string] {
  const s = typeof shapeData === "string" ? shapeData : "";
  if (s === "fire") return ["#ff5722", "#ff8a65"];
  if (s === "water") return ["#2196f3", "#64b5f6"];
  if (s === "black") return ["#43a047", "#81c784"];
  if (s === "FinishBoy") return ["#e53935", "#ef9a9a"];
  if (s === "FinishGirl") return ["#1e88e5", "#90caf9"];

  if (bodyName === "pers1") return ["#ff1744", "#ff8a65"];
  if (bodyName === "pers2") return ["#00b0ff", "#80d8ff"];
  if (bodyName === "ground") return ["#5d4037", "#8d6e63"];
  if (bodyName === "box") return ["#8d6e63", "#d7ccc8"];
  if (bodyName === "rot" || bodyName === "PulleyPlatform" ||
      bodyName === "HangingPlatform") return ["#6d4c41", "#a1887f"];
  if (bodyName === "wind") return ["#26c6da", "#80deea"];

  if (symbol === "RedDiamond") return ["#d50000", "#ff5252"];
  if (symbol === "BlueDiamond") return ["#2962ff", "#448aff"];
  if (symbol === "SilverDiamond") return ["#00c853", "#69f0ae"];
  if (symbol === "FireBoy") return ["#ff1744", "#ff8a65"];
  if (symbol === "WaterGirl") return ["#00b0ff", "#80d8ff"];
  if (symbol === "LeverMc" || symbol === "LeverBase") {
    return ["#ffab00", "#ffd54f"];
  }
  return ["#546e7a", "#90a4ae"];
}

export interface DrawOptions {
  showGrid?: boolean;
}

export function draw(ctx: CanvasRenderingContext2D, lv: any,
                     opts: DrawOptions = {}): void {
  const w = WORLD_COLS * PPU;
  const h = WORLD_ROWS * PPU;

  ctx.save();
  ctx.fillStyle = "#0f1418";
  ctx.fillRect(0, 0, w, h);

  if (opts.showGrid) {
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= WORLD_COLS; c++) {
      ctx.moveTo(c * PPU, 0); ctx.lineTo(c * PPU, h);
    }
    for (let r = 0; r <= WORLD_ROWS; r++) {
      ctx.moveTo(0, r * PPU); ctx.lineTo(w, r * PPU);
    }
    ctx.stroke();
  }

  for (let b: any = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
    const pos = b.GetPosition();
    const angle = b.GetAngle();
    const ud = b.GetUserData();
    const bodyName = (ud && typeof ud.name === "string") ? ud.name : "";
    const symbol = (ud && typeof ud.symbol === "string") ? ud.symbol : "";

    // A collected diamond is removed from the display list but its sensor
    // shape survives: ContactListener runs inside world.Step(), where the
    // world is locked, so DestroyShape returns early -- in the original game
    // too. The display list is the truth about what is on screen, so a body
    // whose clip has been detached or hidden must not be drawn.
    if (ud && "parent" in ud && ud.parent === null) continue;
    if (ud && ud.visible === false) continue;

    for (let s: any = b.GetShapeList(); s; s = s.GetNext()) {
      const [stroke, fill] = colorFor(s.GetUserData(), bodyName, symbol);
      ctx.save();
      ctx.translate(pos.x * PPU, pos.y * PPU);
      ctx.rotate(angle);
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;

      if (s.GetType() === b2Shape.e_polygonShape) {
        const poly = s as any;
        const verts = poly.m_vertices;
        const n = poly.m_vertexCount;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const vx = verts[i].x * PPU;
          const vy = verts[i].y * PPU;
          if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (s.GetType() === b2Shape.e_circleShape) {
        const c = s as any;
        ctx.beginPath();
        ctx.arc(c.m_localPosition.x * PPU, c.m_localPosition.y * PPU,
                c.m_radius * PPU, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // a radius line makes rotation visible
        ctx.beginPath();
        ctx.moveTo(c.m_localPosition.x * PPU, c.m_localPosition.y * PPU);
        ctx.lineTo(c.m_localPosition.x * PPU + c.m_radius * PPU,
                   c.m_localPosition.y * PPU);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  ctx.restore();
}
