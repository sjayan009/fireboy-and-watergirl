/**
 * The SWF's five embedded fonts, made available to canvas text.
 *
 * Families are named by CHARACTER ID (`swf-font-767`), never by the font's own
 * name. Characters 49 and 767 are two different faces -- DefineFontName calls
 * them "Trajan Pro Bold" and "Trajan Pro" -- but both TTFs carry the internal
 * name "Trajan Pro", so a name-keyed family would silently collide and the
 * timer would render in the wrong weight.
 *
 * These are subsets holding only the glyphs the SWF used. Everything the game
 * writes at runtime is digits, a colon or a space, all of which appear in the
 * fields' own authored text, so the subsets cover it. The fallback stack is
 * there for the case where the TTF fails to load at all, not for missing
 * glyphs.
 */
import { assetUrl } from "../asseturl.js";
import { createAssetOwner } from "./assets.js";

export interface FontInfo { file: string; name: string; }

const FALLBACK = 'Georgia, "Times New Roman", serif';

export class FontSet {
  private constructor(private index: Record<string, FontInfo>, readonly missing = 0) {}

  /**
   * The set for a given asset base, loaded at most once per document.
   *
   * The faces are a property of the DOCUMENT -- `document.fonts` is global and
   * a family named `swf-font-767` means the same thing to every canvas on the
   * page -- so loading them per `GameView` added five more `FontFace` objects
   * to the document on every visit to play or watch and removed none of them.
   * Navigating between the two a dozen times left sixty faces registered for
   * five families, all identical, all still holding their decoded tables.
   *
   * Caching the PROMISE rather than the result matters: two views built in the
   * same tick would otherwise both miss the cache and both load.
   */
  private static cache = new Map<string, Promise<FontSet>>();
  /** Successful faces survive a partial retry without duplicate registration. */
  private static faces = new Map<string, FontFace>();

  /** Injects @font-face rules and resolves once the faces are usable. */
  static load(base: string, deadlineMs = 15000): Promise<FontSet> {
    const hit = FontSet.cache.get(base);
    if (hit !== undefined) return hit;
    const loading = FontSet.fetchAndRegister(base, deadlineMs).then(set => {
      if (set.missing) FontSet.cache.delete(base);
      return set;
    }).catch((e) => {
      // A failure must not be cached: the next view should try again rather
      // than inherit a network blip forever.
      FontSet.cache.delete(base);
      throw e;
    });
    FontSet.cache.set(base, loading);
    return loading;
  }

  private static async fetchAndRegister(base: string, deadlineMs: number): Promise<FontSet> {
    const started = Date.now(), deadline = Math.max(1, deadlineMs);
    const owner = createAssetOwner({ priority: "background" });
    let index: Record<string, FontInfo>;
    try { index = await owner.json<Record<string, FontInfo>>(assetUrl(base, "fonts/fonts.json"), { deadlineMs: deadline }); }
    finally { owner.release(); }

    // FontFace over a <style> tag: it reports load failure instead of quietly
    // falling back, which is the difference between "the timer looks wrong"
    // and a diagnosable error.
    const faces = Object.entries(index).map(async ([id, info]) => {
      const family = `swf-font-${id}`;
      const url = assetUrl(base, `fonts/${info.file}`), identity = `${family}:${url}`;
      if (FontSet.faces.has(identity)) return;
      const face = new FontFace(family, `url("${url}")`);
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([face.load(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Font loading deadline exceeded")), Math.max(1, deadline - (Date.now() - started)));
        })]);
        (document.fonts as FontFaceSet & { add(face: FontFace): void }).add(face);
        FontSet.faces.set(identity, face);
      } finally { clearTimeout(timer!); }
    });
    const results = await Promise.allSettled(faces);
    return new FontSet(index, results.filter(result => result.status === "rejected").length);
  }

  /** A canvas `font` string for a DefineEditText field. */
  css(fontId: number, sizePt: number): string {
    const family = this.index[String(fontId)]
      ? `"swf-font-${fontId}", ${FALLBACK}`
      : FALLBACK;
    return `${sizePt}px ${family}`;
  }

  get known(): number { return Object.keys(this.index).length; }
}
