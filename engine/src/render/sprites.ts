/**
 * Renders the original SWF art by walking the Flash scene graph the port
 * already maintains.
 *
 * The scene graph is simulation state, so this module is strictly read-only:
 * it never writes an `x`, a `visible` or a `currentFrame`.
 *
 * Two wrinkles drive the design.
 *
 * 1. JPEXS exports a sprite frame as a *composite*, with its named child
 *    instances baked in, but the game controls those children at runtime --
 *    FireBoy shows one of five pose clips by toggling `visible`. Drawing the
 *    composite stacks all five. So the exporter also writes a "base" copy with
 *    the named instances stripped out, and we draw base-then-children. Simply
 *    skipping the composite would throw away the sprite's OWN art, which is
 *    where the running body and legs and the platform plank live.
 *
 * 2. A named child's placement matrix can change per frame -- the head bobs
 *    across the 8 frames of the running cycle. The manifest carries the matrix
 *    for every frame, so we prefer it, and fall back to the child's own
 *    transform for any property the game has actually written to (a pose flip
 *    sets `mc_4.scaleX = -0.135`, and `mc_4.head.rotation` tracks velocity).
 */
import { DisplayObject, TextField } from "../flash/flash.js";
import { FontSet } from "./fonts.js";
import { cssFilter, hasVisibleFilter } from "./filters.js";
import { assetUrl } from "../asseturl.js";
import { assetRevision, imageAsset, jsonAsset } from "./assets.js";

export interface ChildPlacement {
  name: string;
  id: number | null;
  m: number[];
}
export interface FrameGeom {
  w: number; h: number; ox: number; oy: number;
  children: ChildPlacement[];
  /** Filename of the composite with named children removed. */
  base?: string;
}
export interface SpriteInfo {
  id: number; name?: string; frames: number; geom: FrameGeom[];
}
export interface Manifest {
  byName: Record<string, number>;
  sprites: Record<string, SpriteInfo>;
  /**
   * The raster format the sprite frames were shipped in, "png" unless a build
   * step converted them.
   *
   * Read from the manifest rather than passed in, so the format is a property
   * of the assets that are actually there. A caller that had to be told would
   * be a second place to keep in step, and getting it wrong looks like every
   * image failing to load.
   */
  raster?: string;
}

/** One character a button places in a given state. */
export interface ButtonPart { id: number; depth: number; m: number[]; }

/** The three states a button draws. */
export type ButtonState = "up" | "over" | "down";

export interface ButtonSpec {
  /** What is drawn at rest. */
  up: ButtonPart[];
  /** Under the pointer. Not a tint: most buttons swap in a different label
   *  character, and "Play" places its own label twice so it reads brighter. */
  over: ButtonPart[];
  /** Held down. "Play" scales to 0.9, so the text shrinks under the click. */
  down: ButtonPart[];
  /** What is clickable. Not the same thing again: the level map's node buttons
   *  draw nothing at all and are pure invisible hit areas over the node
   *  clips. */
  hit: ButtonPart[];
  /** The hit state's bounding box, in the button's own coordinates. */
  hitBox: { x: number; y: number; w: number; h: number } | null;
}

export interface PartGeom {
  w: number; h: number; ox: number; oy: number;
  /** "part" for a shape or baked text, "sprite" for a DefineSprite. */
  from?: "part" | "sprite";
}

export interface ButtonSet {
  buttons: Record<string, ButtonSpec>;
  parts: Record<string, PartGeom>;
}

/** A clickable button, placed on the stage. */
export interface ButtonHit {
  node: any;
  /** The hit box in the button's own coordinates. */
  box: { x: number; y: number; w: number; h: number };
  /** Button coordinates -> stage coordinates. */
  matrix: DOMMatrix;
  /** The hit box's centre, on the stage. Handy for driving it from a test. */
  centre: [number, number];
}

/** A resolved transform for one node. */
interface Xform { x: number; y: number; sx: number; sy: number; rot: number; }

const DEG = Math.PI / 180;
/** Flash pads every text field by 2px on each side. */
const GUTTER = 2;

/**
 * Decompose an SVG matrix into the Flash-style transform the shim uses.
 *
 * The scale signs come from the DETERMINANT, not from the signs of `a` and
 * `d`. Taking them per-axis double-counts a half turn: `[-1, 0, 0, -1]` is a
 * pure 180-degree rotation, but reading `a < 0` and `d < 0` as scales of -1
 * and then also rotating by the 180 degrees `atan2` reports cancels out to the
 * identity. That is what left the rope's chain hanging downwards from its
 * anchor instead of upwards, so it never overlapped its own mask and vanished.
 *
 * No `|| 1` fallback: Flash animations legitimately scale a part to zero to
 * hide it, and coercing that to 1 would blow the part up to full size.
 */
function decompose(m: number[]): Xform {
  const [a, b, c, d, tx, ty] = m;
  const sx = Math.hypot(a, b);
  const det = a * d - b * c;
  // A negative determinant is a mirror; it belongs on one axis, not both.
  const sy = sx === 0 ? Math.hypot(c, d) : det / sx;
  return { x: tx, y: ty, sx, sy, rot: Math.atan2(b, a) / DEG };
}

/**
 * The manifest placement for a child, on this frame.
 *
 * Matched by PLACEMENT INDEX, not by name: instance names are not unique.
 * MainMenu places eight different clips all called "node_1", so a name lookup
 * returned the first placement for every one of them -- the real level-1 node
 * was drawn at x = -235, off the side of the stage, and the map showed an
 * empty socket where its gem should be. The name is still checked, so if the
 * two extractors ever fall out of step this degrades to the old lookup rather
 * than silently drawing the wrong art.
 */
function placementFor(geom: FrameGeom | undefined,
                      child: any): ChildPlacement | undefined {
  if (!geom) return undefined;
  const i = child.__place;
  if (i != null) {
    const byIndex = geom.children[i];
    if (byIndex && byIndex.name === child.name) return byIndex;
  }
  return geom.children.find((c) => c.name === child.name);
}

export class SpriteRenderer {
  private images = new Map<string, HTMLImageElement>();
  private pending = new Set<string>();
  private failed = new Set<string>();
  /** Sprite ids whose whole animation has been requested. */
  private prefetched = new Set<number>();
  private layer: HTMLCanvasElement | null = null;
  private maskLayer: HTMLCanvasElement | null = null;
  private filterLayer: HTMLCanvasElement | null = null;
  /**
   * Filtered results, keyed by node. The terrain is a full-screen glow plus
   * drop shadow and never changes after load, so re-blurring it every frame
   * would be wasteful -- the original cached it into a BitmapData for the same
   * reason. Entries are invalidated when the transform changes.
   */
  private filterCache = new WeakMap<object, { key: string; c: HTMLCanvasElement }>();
  /**
   * Bumped whenever an image finishes loading. It is part of the filter cache
   * key, because a layer rendered before its art arrived would otherwise be
   * cached blank forever -- which silently erased the whole terrain.
   */
  private generation = 0;

  /** "png" from `extracted/`, "webp" from a build. See Manifest.raster. */
  private readonly raster: string;

  constructor(private manifest: Manifest, private base: string,
              private stageW = 640, private stageH = 480,
              private fonts: FontSet | null = null,
              private buttons: ButtonSet | null = null) {
    this.raster = manifest.raster ?? "png";
  }

  static async load(base: string, stageW = 640,
                    stageH = 480): Promise<SpriteRenderer> {
    const [manifest, fonts, buttons] = await Promise.all([
      jsonAsset<Manifest>(assetUrl(base, "sprites.json")),
      FontSet.load(base).catch(() => null),
      jsonAsset<ButtonSet>(assetUrl(base, "buttons.json")),
    ]);
    // A missing font must not cost us the art: the fields fall back to a serif
    // stack and everything else still renders.
    // Button art: the up-state characters JPEXS does not export as sprites.
    return new SpriteRenderer(manifest, base, stageW, stageH, fonts, buttons);
  }

  get loading(): number { return this.pending.size; }
  get missing(): number { return this.failed.size; }
  get revision(): number { return assetRevision(); }
  private loadingWork = new Set<Promise<void>>();

  /**
   * Draw the tree once into a scratch canvas so every image it reaches starts
   * downloading, then wait for those downloads to settle.
   *
   * Settle, not succeed. A frame that will not load is a hole in the art and
   * `missing` counts it, but it is not a reason to refuse to run the game --
   * the renderer has always drawn what it has and skipped what it has not, and
   * a level that is playable with one sprite absent is better than a level
   * nobody can start because a CDN blinked. What the count IS good for is
   * deciding that a run must not be ranked: two peers cannot agree about a
   * frame they are not both drawing.
   */
  async prepare(root: DisplayObject): Promise<void> {
    if (this.failed.size) this.prefetched.clear();
    for (const key of this.failed) this.images.delete(key);
    this.failed.clear();
    this.warm(root);
    const scratch = document.createElement("canvas");
    scratch.width = this.stageW; scratch.height = this.stageH;
    this.draw(scratch.getContext("2d")!, root);
    await Promise.allSettled([...this.loadingWork]);
  }

  private scratch(which: "layer" | "maskLayer" | "filterLayer"):
      HTMLCanvasElement {
    let c = this[which];
    if (!c) {
      c = document.createElement("canvas");
      c.width = this.stageW;
      c.height = this.stageH;
      this[which] = c;
    }
    return c;
  }

  private spriteFor(node: any): SpriteInfo | null {
    const id = node.spriteId;
    if (id != null) {
      const s = this.manifest.sprites[String(id)];
      if (s) return s;
    }
    const sym = node.symbol;
    if (sym) {
      const byName = this.manifest.byName[sym];
      if (byName != null) return this.manifest.sprites[String(byName)] ?? null;
    }
    return null;
  }

  /**
   * Cached <img> for an asset path under the base, kicking off the load on
   * first use; null until ready.
   */
  private image(key: string): HTMLImageElement | null {
    const hit = this.images.get(key);
    if (hit) return hit.complete && hit.naturalWidth > 0 ? hit : null;
    if (this.failed.has(key)) return null;

    const resource = imageAsset(assetUrl(this.base, key));
    const img = resource.image;
    this.images.set(key, img);
    this.pending.add(key);
    const work = resource.ready.then(() => { this.pending.delete(key); this.generation++; }, e => {
      this.pending.delete(key); this.failed.add(key); throw e;
    });
    this.loadingWork.add(work);
    void work.finally(() => this.loadingWork.delete(work)).catch(() => { /* prepare exposes failures; lazy effects remain optional. */ });
    return null;
  }

  /**
   * Request every frame of an animated sprite the first time one is drawn.
   *
   * Each frame is a separate file, fetched on the frame it first appears on --
   * so a 69-frame clip like the menu's fireflies popped in and out for its
   * first two and a half seconds of playback, and a character's run cycle
   * flickered the first time it ran. Asking for the rest up front costs one
   * burst of requests per clip and makes the animation whole from the start.
   *
   * Single-frame sprites, which are most of them, are skipped entirely.
   */
  private prefetch(sprite: SpriteInfo): void {
    if (sprite.frames < 2 || this.prefetched.has(sprite.id)) return;
    this.prefetched.add(sprite.id);
    for (let f = 1; f <= sprite.frames; f++) {
      const g = sprite.geom[f - 1];
      if (!g) continue;
      this.image(`sprites/${sprite.id}/` + (g.children.length === 0
        ? `${f}.${this.raster}`
        : (g.base ?? `${f}_base.svg`)));
    }
  }

  draw(ctx: CanvasRenderingContext2D, root: DisplayObject): void {
    this.drawNode(ctx, root);
  }

  /**
   * Request every image a display tree will need, without drawing it.
   *
   * Art is otherwise discovered lazily, one frame at a time, so a freshly
   * started level spends its first seconds filling in: the terrain appears,
   * then the doors, then the diamonds. Walking the tree once at the moment the
   * level is built turns that into a single burst of parallel requests, which
   * is what the browser is good at.
   *
   * Nothing waits on this. Every image still arrives through the same cache,
   * and a level whose art has not landed yet draws what it has -- the
   * simulation is unaffected either way, which is why this can be pure
   * optimisation rather than a loading screen.
   */
  warm(root: DisplayObject): void {
    const seen = new Set<number>();
    const visit = (node: any): void => {
      if (!node || node.visible === false) return;
      const sprite = this.spriteFor(node);
      if (sprite && !seen.has(sprite.id)) {
        seen.add(sprite.id);
        const geom = sprite.geom[0];
        if (geom) {
          this.image(`sprites/${sprite.id}/` + (geom.children.length === 0
            ? `1.${this.raster}`
            : (geom.base ?? `1_base.svg`)));
        }
        this.prefetch(sprite);
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
  }

  /**
   * Resolve a child's transform: the manifest's per-frame matrix wins, except
   * for properties the game has written to since construction.
   */
  private childXform(child: any, place: ChildPlacement): Xform {
    const fromFrame = decompose(place.m);
    const seed = child.__seed;
    if (!seed) return fromFrame;
    return {
      x: child.x === seed.x ? fromFrame.x : child.x,
      y: child.y === seed.y ? fromFrame.y : child.y,
      sx: child.scaleX === seed.sx ? fromFrame.sx : child.scaleX,
      sy: child.scaleY === seed.sy ? fromFrame.sy : child.scaleY,
      rot: child.rotation === seed.rot ? fromFrame.rot : child.rotation,
    };
  }

  private drawNode(ctx: CanvasRenderingContext2D, node: any,
                   xform?: Xform): void {
    if (!node || node.visible === false) return;
    // A mask is never painted, only used to clip (see DisplayObject.isMask).
    if (node.isMask) return;
    // Flash clamps alpha to [0, 1] on assignment. The ported code relies on
    // that: Recuento.Ease sets `Tapper.alpha = Math.abs((y + 164) / 390)`,
    // which settles at 1.02, and PauseMenu.Update does the same. Without the
    // clamp those values ride past 1 and behave unpredictably.
    const alpha = Math.min(1, Math.max(0, node.alpha ?? 1));
    if (alpha <= 0) return;

    // A mask lives in the PARENT's coordinate space, alongside the node it
    // clips -- not inside it. So this has to happen before the node's own
    // transform goes on the context, or the mask is offset by the node's
    // position twice. That is invisible for the moss texture (texture1 and
    // GroundMask are both at 0,0) and fatal for a floor button at (590,198)
    // whose mask sits at (590,200): the mask landed off-screen and
    // destination-in erased the button.
    if (node.mask) {
      this.drawMasked(ctx, node, xform);
      return;
    }

    ctx.save();
    const t: Xform = xform ?? {
      x: node.x ?? 0, y: node.y ?? 0,
      sx: node.scaleX ?? 1, sy: node.scaleY ?? 1,
      rot: node.rotation ?? 0,
    };
    this.applyHeight(node, t);
    ctx.translate(t.x, t.y);
    if (t.rot) ctx.rotate(t.rot * DEG);
    if (t.sx !== 1 || t.sy !== 1) ctx.scale(t.sx, t.sy);
    if (alpha !== 1) ctx.globalAlpha *= alpha;

    if (hasVisibleFilter(node.filters)) {
      this.drawFiltered(ctx, node);
      ctx.restore();
      return;
    }

    // A ClipDepth mask: a CHILD that clips its siblings. Unlike node.mask it
    // lives in this clip's own space, not the parent's, so it is applied after
    // the node transform rather than before. This is what makes a rope grow:
    // the game sets ropeMask.height and the chain is revealed to match.
    if (node.__clipMask) {
      this.drawSelfMasked(ctx, node);
      ctx.restore();
      return;
    }

    this.drawContent(ctx, node, false);
    ctx.restore();
  }

  /**
   * Paint a node's own art and its children.
   *
   * The caller has already put the node's transform on the context and will
   * restore it; this only paints. Split out so a clip that masks itself can
   * paint its content into one layer and its mask child into another.
   */
  private drawContent(ctx: CanvasRenderingContext2D, node: any,
                      skipMask: boolean): void {
    // A Bitmap standing in for a rasterised subtree (see BitmapData.draw):
    // draw what was rasterised, under the matrix it was drawn with.
    const bd = node.bitmapData;
    if (bd && bd.source) {
      const m = bd.sourceMatrix;
      ctx.save();
      if (m) ctx.transform(m.a, m.b, m.c, m.d, m.tx, m.ty);
      this.drawNode(ctx, bd.source);
      ctx.restore();
      return;
    }

    if (node instanceof TextField) {
      this.drawText(ctx, node);
      return;
    }

    // A SimpleButton placement: draw whichever state it is in.
    const button = this.buttons &&
                   this.buttons.buttons[String(node.spriteId)];
    if (button) {
      this.drawButton(ctx, button, node.__btnState);
      return;
    }

    const sprite = this.spriteFor(node);
    let geom: FrameGeom | undefined;
    /**
     * Whether this node expected its own art this frame and did not get it.
     *
     * Art loads asynchronously and the loop draws whatever is ready, which is
     * right for a level -- a tile arriving late is a tile arriving late. It is
     * wrong for a panel and its contents: the credits scroll is one 330 KB SVG
     * and the line drawn over it is text, so on the first open the text was on
     * screen a beat before the scroll it belongs to, floating over the menu on
     * its own. A child can now say it would rather wait.
     */
    let basePending = false;
    if (sprite) {
      const frame = Math.min(Math.max(node.currentFrame ?? 1, 1),
                             sprite.frames);
      geom = sprite.geom[frame - 1];
      if (geom) {
        // no named children -> the PNG composite is the whole picture;
        // otherwise the stripped SVG base, with the children drawn on top
        const file = geom.children.length === 0
          ? `${frame}.${this.raster}`
          : (geom.base ?? `${frame}_base.svg`);
        const img = this.image(`sprites/${sprite.id}/${file}`);
        if (img) ctx.drawImage(img, -geom.ox, -geom.oy);
        else basePending = true;
        this.prefetch(sprite);
      }
    }

    for (const child of node.children ?? []) {
      if (skipMask && child === node.__clipMask) continue;
      if (basePending && child.__afterBase) continue;
      const place = placementFor(geom, child);
      // A child is drawn on the frames its timeline places it on, and on no
      // others. A named child the frame's geometry does not place is already
      // baked into the composite -- JPEXS emits it as an anonymous <use> so
      // there is nothing to recover. Drawing it again puts it at the origin at
      // full size: that is what pasted a giant Watergirl head over the exit
      // door at the end of a level, on top of the correctly drawn one.
      //
      // A recovered placement matrix (`__seed`) is NOT a licence to keep
      // drawing. It says where a child goes, not which frames it is on, and it
      // is set once at construction while `place` is per frame. Treating it as
      // "always draw" pasted FireBoy's standing pose -- FireBoystairs' mc_1,
      // placed on frame 1 alone -- over all 24 remaining frames of his climb
      // out of the exit door, so his ending never appeared to animate while
      // WaterGirl's, whose only child carries no matrix, always had.
      if (geom && !place) continue;
      this.drawNode(ctx, child,
                    place ? this.childXform(child, place) : undefined);
    }
  }

  /**
   * Every visible, enabled button under `root`, in draw order, each with the
   * transform that puts it on the stage.
   *
   * This walk deliberately mirrors drawNode's -- same skip rules, same
   * transform order, same per-frame child matrices -- because a button that
   * draws in one place and is clickable in another is worse than one that is
   * not clickable at all. Keep the two in step.
   *
   * Transforms accumulate on a real 2D context rather than in hand-rolled
   * matrix code, so the ordering cannot drift from the drawing path.
   */
  buttonBoxes(root: DisplayObject): ButtonHit[] {
    const out: ButtonHit[] = [];
    if (!this.buttons) return out;
    const ctx = this.probeCtx();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const visit = (node: any, xform?: Xform): void => {
      if (!node || node.visible === false || node.isMask) return;
      if ((node.alpha ?? 1) <= 0) return;

      ctx.save();
      const t: Xform = xform ?? {
        x: node.x ?? 0, y: node.y ?? 0,
        sx: node.scaleX ?? 1, sy: node.scaleY ?? 1,
        rot: node.rotation ?? 0,
      };
      ctx.translate(t.x, t.y);
      if (t.rot) ctx.rotate(t.rot * DEG);
      if (t.sx !== 1 || t.sy !== 1) ctx.scale(t.sx, t.sy);

      const button = this.buttons!.buttons[String(node.spriteId)];
      // `enabled = false` is how CreateMainMenu locks a level the player has
      // not reached; an AS3 button stops taking clicks entirely when it is set.
      if (button && button.hitBox && node.enabled !== false) {
        const m = ctx.getTransform();
        const b = button.hitBox;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        out.push({
          node,
          box: b,
          matrix: m,
          centre: [m.a * cx + m.c * cy + m.e, m.b * cx + m.d * cy + m.f],
        });
      }

      /**
       * `mouseChildren = false` takes a whole subtree out of the pointer's
       * reach, exactly as it does in Flash.
       *
       * A panel laid over the intro menu -- Instructions, Credits -- draws on
       * top of it and stops there: the menu underneath kept its hit boxes, so
       * "Use A,W,D to move WaterGirl" was a click on Play, the line about
       * puzzle levels was a click on More Games, and OK sat inside Submit
       * Hiscore's box. Game.LoadInstructions now switches this off on the menu
       * while the panel is up, which leaves OK as the only thing on screen a
       * click can reach.
       */
      if (node.mouseChildren === false) { ctx.restore(); return; }

      const sprite = this.spriteFor(node);
      let geom: FrameGeom | undefined;
      if (sprite) {
        const frame = Math.min(Math.max(node.currentFrame ?? 1, 1),
                               sprite.frames);
        geom = sprite.geom[frame - 1];
      }
      for (const child of node.children ?? []) {
        const place = placementFor(geom, child);
        if (geom && !place) continue;
        visit(child, place ? this.childXform(child, place) : undefined);
      }
      ctx.restore();
    };

    visit(root);
    return out;
  }

  /**
   * The topmost button under a stage point, or null.
   *
   * The point is mapped back into each button's own coordinates, which is
   * where the manifest's hit box lives, so a rotated button would still be
   * exact. The LAST hit wins, because later siblings draw on top; a tie goes
   * to the smaller box, since hit boxes are axis-aligned and the map's nodes
   * are hexagons, so a generous box should never beat a tight one.
   */
  hitTest(root: DisplayObject, x: number, y: number): DisplayObject | null {
    let best: DisplayObject | null = null;
    let bestArea = Infinity;
    for (const h of this.buttonBoxes(root)) {
      const inv = h.matrix.inverse();
      const lx = inv.a * x + inv.c * y + inv.e;
      const ly = inv.b * x + inv.d * y + inv.f;
      const b = h.box;
      if (lx < b.x || lx > b.x + b.w || ly < b.y || ly > b.y + b.h) continue;
      const area = b.w * b.h;
      if (area <= bestArea) { best = h.node; bestArea = area; }
    }
    return best;
  }

  /** A throwaway context used only to accumulate transforms. */
  private probe: CanvasRenderingContext2D | null = null;
  private probeCtx(): CanvasRenderingContext2D {
    if (!this.probe) {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      this.probe = c.getContext("2d")!;
    }
    return this.probe;
  }

  /**
   * Draw one state of a button, back to front by placement depth.
   *
   * A state with no placements falls back to `up`: the level map's nodes have
   * no art of their own in any state, and their highlight is the `Glower` clip
   * the game itself toggles.
   */
  private drawButton(ctx: CanvasRenderingContext2D, button: ButtonSpec,
                     state: ButtonState | undefined): void {
    let parts = state ? button[state] : button.up;
    if (!parts || parts.length === 0) parts = button.up;
    for (const p of parts) {
      const g = this.buttons!.parts[String(p.id)];
      if (!g) continue;
      // Most parts are shapes or baked text exported into parts/; a few are
      // DefineSprites, which already live in the sprite export.
      const img = this.image(g.from === "sprite"
        ? `sprites/${p.id}/1.${this.raster}`
        : `parts/${p.id}.svg`);
      if (!img) continue;
      ctx.save();
      const [a, b, c, d, tx, ty] = p.m;
      ctx.transform(a, b, c, d, tx, ty);
      ctx.drawImage(img, -g.ox, -g.oy);
      ctx.restore();
    }
  }

  /**
   * Draw a DefineEditText field.
   *
   * Flash lays text out inside the character's bounds rect, which carries a
   * 2px gutter on every side (that is why the recorded box starts at -2,-2).
   * Stripping the gutter and drawing from the top of the inner box is what
   * lines the timer digits up with the watch face behind them.
   *
   * Only single-line fields exist among the ones the game writes to, so there
   * is no line breaking here -- if that ever changes it will be visibly wrong
   * rather than subtly so.
   */
  private drawText(ctx: CanvasRenderingContext2D, node: any): void {
    const text = String(node.text ?? "");
    if (!text) return;
    const b = node.bounds ?? { x: 0, y: 0, w: 0, h: 0 };
    const x0 = b.x + GUTTER;
    const y0 = b.y + GUTTER;
    const w = Math.max(0, b.w - GUTTER * 2);

    ctx.font = this.fonts
      ? this.fonts.css(node.fontId, node.size)
      : `${node.size}px Georgia, serif`;
    ctx.fillStyle = `#${((node.textColor ?? 0) >>> 0).toString(16)
                          .padStart(6, "0")}`;
    ctx.textBaseline = "top";
    ctx.textAlign = node.align === "center" ? "center"
      : node.align === "right" ? "right" : "left";
    const x = node.align === "center" ? x0 + w / 2
      : node.align === "right" ? x0 + w : x0;
    ctx.fillText(text, x, y0);
  }

  /**
   * Render a filtered subtree once into a layer, then blit it back through
   * `ctx.filter`. Cached per node and transform, because the terrain's glow is
   * full-screen and static.
   */
  private drawFiltered(ctx: CanvasRenderingContext2D, node: any): void {
    const t = ctx.getTransform();
    const key = [t.a, t.b, t.c, t.d, t.e, t.f].map((v) => v.toFixed(2))
      .join() + "|" + this.generation;
    let hit = this.filterCache.get(node);

    if (!hit || hit.key !== key) {
      const c = document.createElement("canvas");
      c.width = this.stageW;
      c.height = this.stageH;
      const lc = c.getContext("2d")!;
      lc.setTransform(t);
      const saved = node.filters;
      node.filters = [];                   // avoid recursing into ourselves
      this.drawNode(lc, node, { x: 0, y: 0, sx: 1, sy: 1, rot: 0 });
      node.filters = saved;
      hit = { key, c };
      this.filterCache.set(node, hit);
    }

    // the scale baked into the transform, so a 20px glow stays 20 Flash px
    const scale = Math.hypot(t.a, t.b) || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = cssFilter(node.filters, scale);
    ctx.drawImage(hit.c, 0, 0);
    ctx.filter = "none";
    ctx.restore();
  }

  /**
   * Flash's `height` sets an object's rendered height by SCALING it. The shim
   * cannot know how tall a clip's art is, so the conversion happens here,
   * where the manifest does.
   *
   * Only the rope masks use it -- `level.as` sets `ropeMask.height` to the
   * distance between the anchors, and that is what makes the rope grow.
   */
  private applyHeight(node: any, t: Xform): void {
    const h = node.height;
    if (typeof h !== "number" || !Number.isFinite(h)) return;
    const sprite = this.spriteFor(node);
    const geom = sprite && sprite.geom[0];
    if (!geom || !geom.h) return;
    t.sy = h / geom.h;
  }

  /**
   * Render a clip whose own child masks the rest of its content.
   *
   * `ctx` already carries this clip's transform, so the mask and the content
   * are drawn in the same space and each applies its own placement once. The
   * scratch layers are the stage size and drawn at the current transform, the
   * same way drawMasked works.
   */
  private drawSelfMasked(ctx: CanvasRenderingContext2D, node: any): void {
    const layer = this.scratch("layer");
    const maskLayer = this.scratch("maskLayer");
    const lc = layer.getContext("2d")!;
    const mc = maskLayer.getContext("2d")!;
    const t = ctx.getTransform();
    for (const c of [lc, mc]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.stageW, this.stageH);
      c.setTransform(t);
    }

    const mask = node.__clipMask;
    // draw the clip's own art and every child except the mask
    this.drawContent(lc, node, true);
    const wasMask = mask.isMask;
    mask.isMask = false;
    this.drawNode(mc, mask);
    mask.isMask = wasMask;

    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = "destination-in";
    lc.drawImage(maskLayer, 0, 0);
    lc.globalCompositeOperation = "source-over";

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  /**
   * Render a masked subtree through scratch layers, keeping the overlap.
   * `ctx` still holds the PARENT transform, so node and mask are drawn in the
   * same space -- each applying its own x/y exactly once.
   */
  private drawMasked(ctx: CanvasRenderingContext2D, node: any,
                     xform?: Xform): void {
    const layer = this.scratch("layer");
    const maskLayer = this.scratch("maskLayer");
    const lc = layer.getContext("2d")!;
    const mc = maskLayer.getContext("2d")!;
    const t = ctx.getTransform();
    for (const c of [lc, mc]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.stageW, this.stageH);
      c.setTransform(t);
    }
    const mask = node.mask;
    node.mask = null;                      // avoid recursing forever
    const wasMask = mask.isMask;
    mask.isMask = false;
    this.drawNode(lc, node, xform);
    this.drawNode(mc, mask);
    mask.isMask = wasMask;
    node.mask = mask;

    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = "destination-in";
    lc.drawImage(maskLayer, 0, 0);
    lc.globalCompositeOperation = "source-over";

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }
}
