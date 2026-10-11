/**
 * An Apple-style spring -- damping ratio and response in seconds -- sampled
 * into a CSS `linear()` easing, so a Web Animation can carry it.
 *
 * Damping 1 settles without overshoot; below 1 it overshoots, which is kept for
 * motion that arrives with momentum. Response is how quickly it gets there, not
 * a duration: the duration is wherever the curve has settled.
 */
export function spring(damping: number, response: number): { easing: string; duration: number } {
  const w = 2 * Math.PI / response, wd = w * Math.sqrt(1 - damping * damping), points: string[] = [];
  let t = 0;
  for (; t < 3; t += 1 / 60) {
    const x = 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + (damping * w / wd) * Math.sin(wd * t));
    points.push(x.toFixed(4));
    if (Math.abs(1 - x) < 0.002 && t > response) break;
  }
  return { easing: `linear(${points.join(",")})`, duration: Math.round(t * 1000) };
}

/**
 * Animate `el` to `transform` from wherever it is on screen right now.
 *
 * Interruptible by construction: a new move reads the presented transform, so
 * reversing mid-flight continues from the visible position instead of jumping
 * to where the last animation was headed.
 */
export function moveTo(el: HTMLElement, transform: string, timing: KeyframeAnimationOptions): void {
  const from = getComputedStyle(el).transform;
  el.getAnimations().forEach(a => a.cancel());
  el.animate([{ transform: from === "none" ? "none" : from }, { transform }], timing);
  el.style.transform = transform;
}
