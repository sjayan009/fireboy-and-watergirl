/*
 * The Watch panel, without the engine.
 *
 * The clip is the engine's own frames, recorded once by tools/watch-video.mjs
 * (103 frames, the same finish shared/watch.js runs live) into a ~200 KB
 * animated WebP. Running the engine here cost ~6.6 MB and ~470 requests on the
 * landing page to play five seconds; the live engine now lives only on the
 * For Developers Netcode page, which is the page that is about it.
 *
 *   - a poster (the first frame) is in the markup, so the panel has its final
 *     size and picture from the first paint: no layout shift
 *   - the clip is fetched only when the panel is about to scroll into view
 *   - it plays once, then shows "Level complete" and Replay; Replay restarts
 *     it from memory (a fresh blob URL of the same bytes), no second download
 *   - reduced motion: the last frame, still, with Replay
 */
const CLIP = new URL("../assets/watch-finish.webp", import.meta.url);
const END = new URL("../assets/watch-end.webp", import.meta.url);
const DURATION = 5665;   // tools/watch-video.mjs: 103 frames x 55 ms

export function createWatchClip(host) {
  const img = host.querySelector("img");
  const replay = host.querySelector(".watch-replay");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let bytes = null, url = "", timer = 0;

  const done = () => { host.setAttribute("data-done", ""); replay.hidden = false; };
  async function play() {
    clearTimeout(timer);
    host.removeAttribute("data-done");
    replay.hidden = true;
    try {
      bytes ??= await fetch(CLIP).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); });
    } catch { done(); return; }                       // the poster stays; nothing breaks
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(bytes);                 // a new URL restarts the animation
    img.src = url;
    timer = setTimeout(done, DURATION + 200);
  }
  replay.addEventListener("click", () => { void play(); });

  if (reduce) { img.src = END.href; done(); return { play }; }
  const io = new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting)) { io.disconnect(); void play(); }
  }, { threshold: 0.5 });
  io.observe(host);
  return { play };
}
