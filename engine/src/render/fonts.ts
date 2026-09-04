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

export interface FontInfo { file: string; name: string; }

const FALLBACK = 'Georgia, "Times New Roman", serif';

export class FontSet {
  private constructor(private index: Record<string, FontInfo>) {}

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

  /** Injects @font-face rules and resolves once the faces are usable. */
  static load(base: string): Promise<FontSet> {
    const hit = FontSet.cache.get(base);
    if (hit !== undefined) return hit;
    const loading = FontSet.fetchAndRegister(base).catch((e) => {
      // A failure must not be cached: the next view should try again rather
      // than inherit a network blip forever.
      FontSet.cache.delete(base);
      throw e;
    });
    FontSet.cache.set(base, loading);
    return loading;
  }

  private static async fetchAndRegister(base: string): Promise<FontSet> {
    const res = await fetch(assetUrl(base, "fonts/fonts.json"),
                            { cache: "force-cache" });
    const index: Record<string, FontInfo> = await res.json();

    // FontFace over a <style> tag: it reports load failure instead of quietly
    // falling back, which is the difference between "the timer looks wrong"
    // and a diagnosable error.
    const faces = Object.entries(index).map(async ([id, info]) => {
      const family = `swf-font-${id}`;
      const face = new FontFace(family,
                                `url("${assetUrl(base, `fonts/${info.file}`)}")`);
      await face.load();
      (document as any).fonts.add(face);
    });
    await Promise.allSettled(faces);
    return new FontSet(index);
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
