/** Moderate character-family atlases, retaining individual files as a recovery path. */
import sharp from "sharp";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ATLAS_EDGE = 1024, ATLAS_PAD = 2;
/** Stable shelf packing; input order and page extents are independent of encode concurrency. */
export function packFrames(frames, edge = ATLAS_EDGE, padding = ATLAS_PAD) {
  const pages = [];
  let page;
  for (const frame of frames) {
    const w = frame.w + padding * 2, h = frame.h + padding * 2;
    if (w > edge || h > edge) continue;
    if (!page) { page = { frames: [], x: 0, y: 0, row: 0, w: 0, h: 0 }; pages.push(page); }
    if (page.x + w > edge) { page.x = 0; page.y += page.row; page.row = 0; }
    if (page.y + h > edge) { page = { frames: [], x: 0, y: 0, row: 0, w: 0, h: 0 }; pages.push(page); }
    page.frames.push({ ...frame, x: page.x + padding, y: page.y + padding });
    page.x += w; page.row = Math.max(page.row, h);
    page.w = Math.max(page.w, page.x); page.h = Math.max(page.h, page.y + h);
  }
  return pages.map(({ frames, w, h }) => ({ frames, w, h }));
}

export async function buildCharacterAtlases(from, to, manifest, enabled = process.env.FBWG_CHARACTER_ATLAS === "1") {
  const result = [], entries = [];
  await mkdir(join(to, "atlases"), { recursive: true });
  for (const family of ["FireBoy", "WaterGirl"]) {
    const seen = new Set(), frames = [];
    const visit = async id => {
      if (seen.has(id) || id == null) return;
      seen.add(id);
      const sprite = manifest.sprites[String(id)];
      if (!sprite) return;
      for (let f = 1; f <= sprite.frames; f++) {
        const geom = sprite.geom[f - 1];
        if (geom.children.length) { for (const child of geom.children) await visit(child.id); continue; }
        const source = `sprites/${id}/${f}.png`;
        const bytes = await readFile(join(from, source));
        const meta = await sharp(bytes).metadata();
        frames.push({ id, f, w: meta.width, h: meta.height, source, bytes });
      }
    };
    await visit(manifest.byName[family]);
    frames.sort((a, b) => a.id - b.id || a.f - b.f);
    for (const page of packFrames(frames)) {
      // Copy unpremultiplied bytes directly. Alpha-over composition rounds semi-transparent RGB.
      const pixels = Buffer.alloc(page.w * page.h * 4);
      for (const frame of page.frames) {
        const input = await sharp(frame.bytes).ensureAlpha().raw().toBuffer();
        for (let y = -ATLAS_PAD; y < frame.h + ATLAS_PAD; y++) for (let x = -ATLAS_PAD; x < frame.w + ATLAS_PAD; x++) {
          const source = (Math.max(0, Math.min(frame.h - 1, y)) * frame.w + Math.max(0, Math.min(frame.w - 1, x))) * 4;
          input.copy(pixels, ((frame.y + y) * page.w + frame.x + x) * 4, source, source + 4);
        }
      }
      const bytes = await sharp(pixels, { raw: { width: page.w, height: page.h, channels: 4 } })
        .webp({ lossless: true, exact: true, effort: 4 }).toBuffer();
      const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 20);
      const file = `atlases/${family.toLowerCase()}-${digest}.webp`;
      await writeFile(join(to, file), bytes);
      for (const frame of page.frames) {
        const geom = manifest.sprites[String(frame.id)].geom[frame.f - 1];
        const source = { file, x: frame.x, y: frame.y, w: frame.w, h: frame.h };
        if (enabled) geom.source = source;
        entries.push({ id: frame.id, frame: frame.f, source });
      }
      result.push({ file, w: page.w, h: page.h, frames: page.frames.length, bytes: bytes.length });
    }
  }
  manifest.atlas = { schema: 1, enabled, padding: ATLAS_PAD, pages: result, frames: entries };
  return result;
}
