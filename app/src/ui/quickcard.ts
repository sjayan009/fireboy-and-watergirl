/**
 * The Quick Match card: pick a character, search, and the moment two players meet.
 *
 * ## The search, drawn
 *
 * The emblem is two halves -- fire and water -- and while the server looks for
 * a partner they sit apart and two comets, one of each, circle the ring in
 * opposite directions at different speeds, so they keep passing each other
 * somewhere new. When a match is found both turn for the top and arrive
 * together, sparks fly, the ring lights, and the halves lock into the emblem.
 *
 * Every orbit is a Web Animation on `transform` alone, so it runs on the
 * compositor and stays smooth while the network code is busy. Each move starts
 * from the angle on screen right now and leaves at the speed the comet already
 * has, so a match arriving mid-orbit never jumps or brakes. Reduced motion
 * keeps the bar (it is information) and replaces the motion with a glow.
 *
 * The bar is the search window, not progress: matchmaking has none to show.
 */
import { el } from "./dom.js";
import { moveTo, spring } from "./spring.js";
import type { Role } from "../quickmatch.js";

const EASE_OUT = "cubic-bezier(.23,1,.32,1)";
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const FIRE = "M23 4C24 15 9 17 9 29a14 14 0 0 0 14 14V30c-6-1-6-7-3-10 1 4 3 5 3 5V4Z";
const WATER = "M29 6c0 9 12 14 12 23a14 14 0 0 1-14 14V29c7-2 8-7 2-13V6Z";

/** One comet. Every move begins from where it is on screen, never from a target. */
class Orbit {
  private anim: Animation | null = null;
  private angle: number;
  private readonly v: number;
  constructor(private readonly el: HTMLElement, period: number, dir: 1 | -1) {
    this.v = 360 / period * dir;
    this.angle = dir > 0 ? -40 : 160;
    this.el.style.transform = `rotate(${this.angle}deg)`;
  }
  private now(): number {
    const m = getComputedStyle(this.el).transform;
    if (!m || m === "none") return this.angle;
    const [a, b] = m.slice(7, -1).split(",").map(Number);
    const seen = Math.atan2(b, a) * 180 / Math.PI;
    return seen + Math.round((this.angle - seen) / 360) * 360;
  }
  stop(): void {
    this.angle = this.now();
    this.anim?.cancel(); this.anim = null;
    this.el.style.transform = `rotate(${this.angle}deg)`;
  }
  private loop(): void {
    const a = this.angle;
    this.anim = this.el.animate([{ transform: `rotate(${a}deg)` }, { transform: `rotate(${a + 360 * Math.sign(this.v)}deg)` }],
      { duration: 360 / Math.abs(this.v) * 1000, iterations: Infinity, easing: "linear" });
  }
  /** From rest to cruising speed; the curve ends at the loop's own speed, so there is no seam. */
  spinUp(): void {
    this.stop();
    const T = 650, d = this.v * (T / 1000) / 2, a = this.angle;
    const anim = this.el.animate([{ transform: `rotate(${a}deg)` }, { transform: `rotate(${a + d}deg)` }],
      { duration: T, easing: "cubic-bezier(.6,0,.8,.6)", fill: "forwards" });
    this.anim = anim;
    anim.finished.then(() => { if (this.anim !== anim) return; this.angle = a + d; anim.cancel(); this.loop(); }, () => {});
  }
  /** Travel to `target`, leaving at exactly the current speed. */
  glide(target: number, T: number, x2 = .2, y2 = 1): Promise<unknown> {
    this.stop();
    const a = this.angle, s0 = Math.abs(this.v) * (T / 1000) / Math.max(1, Math.abs(target - a));
    this.anim = this.el.animate([{ transform: `rotate(${a}deg)` }, { transform: `rotate(${target}deg)` }],
      { duration: T, easing: `cubic-bezier(.3,${Math.min(1, .3 * s0)},${x2},${y2})`, fill: "forwards" });
    this.angle = target;
    return this.anim.finished.catch(() => {});
  }
  /** Coast to a stop: an ease-out whose opening slope is 2 covers v*T/2. */
  coast(T = 900): void { void this.glide(this.now() + this.v * (T / 1000) / 2, T, .66, 1); }
  /** The next pass over the top, far enough off that meeting reads as travel. */
  topAhead(min = 120): number {
    const a = this.now(), s = Math.sign(this.v);
    let t = s > 0 ? Math.ceil(a / 360) * 360 : Math.floor(a / 360) * 360;
    if (Math.abs(t - a) < min) t += 360 * s;
    return t;
  }
}

export interface QuickCardOptions {
  onStart(role: Role): void;
  onCancel(): void;
  /** The search window ran out; the caller stops searching. */
  onTimeout(): void;
  windowMs: number;
}

export class QuickCard {
  readonly root: HTMLElement;
  private idleView: HTMLElement;
  private liveView: HTMLElement;
  private go: HTMLButtonElement;
  private note: HTMLElement;
  private ring: HTMLElement;
  private fill: HTMLElement;
  private bar: HTMLElement;
  private pct: HTMLElement;
  private title: HTMLElement;
  private sub: HTMLElement;
  private words: HTMLElement;
  private searchRow: HTMLElement;
  private timeoutRow: HTMLElement;
  private halves: HTMLElement[];
  private comets: HTMLElement[];
  private complete: HTMLElement;
  private bloom: HTMLElement;
  private fire: Orbit;
  private water: Orbit;
  private role: Role = "either";
  private barAnim: Animation | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private state: "idle" | "search" | "found" | "timeout" = "idle";
  private swapTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: QuickCardOptions) {
    /*
     * The character picker, as a real segmented control: one thumb that slides
     * between the options on a spring and wears the colour of the choice --
     * ember for Fireboy, water for Watergirl, the two blended for Either -- so
     * what is picked never reads as plain white. Each option answers the
     * pointer in its own colour. A radio group, so it is announced as one.
     */
    const roles: [Role, string, string][] = [["fireboy", "Fireboy", "fire"], ["either", "Either", "either"], ["watergirl", "Watergirl", "water"]];
    const thumb = el("span", { class: "qm-thumb", "aria-hidden": "true" });
    const seg = el("div", { class: "qm-seg", role: "radiogroup", "aria-label": "Play as", "data-pick": this.role }, thumb);
    const slide = spring(.82, .32);
    const place = (i: number, animate: boolean) => {
      const to = `translateX(${i * 100}%)`;
      if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) moveTo(thumb, to, slide);
      else thumb.style.transform = to;
    };
    roles.forEach(([role, label, tone], i) => {
      seg.append(el("button", { type: "button", role: "radio", class: tone, "aria-checked": String(role === this.role), onclick: (e: Event) => {
        if (this.role === role) return;
        this.role = role;
        seg.dataset.pick = role;
        for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-checked", String(b === e.currentTarget));
        place(i, true);
      } }, tone === "either" ? el("span", { class: "split" }, label) : label));
    });
    place(roles.findIndex(([role]) => role === this.role), false);
    this.go = el("button", { type: "button", class: "qm-go", onclick: () => o.onStart(this.role) }, "Quick Match");
    this.note = el("p", { class: "note qm-note", role: "status", hidden: true });
    this.idleView = el("div", { class: "qm-view" },
      el("h4", {}, "Quick Match"),
      el("p", { class: "qm-sub" }, "Play with someone new who is online now."),
      seg, this.go, this.note);

    const svg = (d: string, fill: string) => `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="${d}" fill="${fill}"/></svg>`;
    const orbit = (kind: string) => el("div", { class: `qm-orbit ${kind}` }, el("div", { class: "qm-tail" }), el("div", { class: "qm-head" }));
    this.comets = [orbit("fire"), orbit("water")];
    this.halves = [el("div", { class: "qm-half fire", html: `<div class="qm-inner">${svg(FIRE, "var(--fire)")}</div>` }),
                   el("div", { class: "qm-half water", html: `<div class="qm-inner">${svg(WATER, "var(--water)")}</div>` })];
    this.complete = el("div", { class: "qm-complete" });
    this.bloom = el("div", { class: "qm-bloom" });
    this.ring = el("div", { class: "qm-ring" },
      el("div", { class: "qm-ripple" }), el("div", { class: "qm-ripple" }), el("div", { class: "qm-track" }),
      this.bloom, this.complete, ...this.comets, el("div", { class: "qm-emblem" }, ...this.halves));
    this.fire = new Orbit(this.comets[0], 2.3, 1);
    this.water = new Orbit(this.comets[1], 3.1, -1);

    this.title = el("h4", {}, "Finding a partner");
    this.pct = el("span", { class: "qm-pct" }, "0%");
    this.fill = el("i");
    this.bar = el("div", { class: "qm-bar", role: "progressbar", "aria-label": "Search time", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" },
      this.fill, el("b"));
    this.sub = el("p", { class: "qm-sub" });
    this.words = el("div", { class: "qm-words", role: "status", "aria-live": "polite" },
      el("div", { class: "qm-headline" }, this.title, this.pct), this.bar, this.sub);
    this.searchRow = el("div", { class: "qm-row" }, el("button", { type: "button", class: "ghost", onclick: () => o.onCancel() }, "Cancel"));
    this.timeoutRow = el("div", { class: "qm-row", hidden: true },
      el("button", { type: "button", class: "ghost", onclick: () => o.onCancel() }, "Not now"),
      el("button", { type: "button", class: "qm-go qm-keep", onclick: () => o.onStart(this.role) }, "Keep waiting"));
    this.liveView = el("div", { class: "qm-view", hidden: true, "data-out": "" },
      el("div", { class: "qm-stage", "aria-hidden": "true" }, this.ring), this.words, this.searchRow, this.timeoutRow);
    this.root = el("section", { class: "qm" }, this.idleView, this.liveView);
  }

  /** Whether Quick Match can be started right now (not while already playing). */
  setBusy(busy: boolean): void {
    this.go.disabled = busy;
    this.go.title = busy ? "Finish or leave the current game first" : "";
  }

  /** Back to the start, optionally saying why. */
  idle(message = ""): void {
    this.state = "idle";
    this.stopClock();
    this.ring.classList.remove("searching");
    this.note.textContent = message; this.note.hidden = !message;
    if (!this.liveView.hidden) this.swap(this.liveView, this.idleView, () => {
      this.fire.stop(); this.water.stop();
      this.fill.style.transform = "scaleX(0)";
      for (const el of [this.complete, this.bloom, ...this.halves, ...this.comets]) el.getAnimations().forEach(a => a.cancel());
    });
  }

  /** Start, or keep, searching. */
  searching(): void {
    const fresh = this.state === "idle";
    this.state = "search";
    this.ring.classList.add("searching");
    this.searchRow.hidden = false; this.timeoutRow.hidden = true;
    this.note.hidden = true;
    const words = () => this.say("Finding a partner", `Playing as ${this.role === "either" ? "either" : this.role === "fireboy" ? "Fireboy" : "Watergirl"} · Usually under a minute`, "0%");
    if (fresh) {
      this.place(6, 1); this.fade(1, 1);
      this.title.textContent = "Finding a partner"; words();
      this.swap(this.idleView, this.liveView);
    } else {
      this.place(6, 500, EASE_OUT); this.fade(1);
      this.crossfade(words);
    }
    this.startClock();
    if (!reduce.matches) { this.fire.spinUp(); this.water.spinUp(); }
  }

  /** The window ran out with nobody found. */
  timedOut(): void {
    if (this.state !== "search") return;
    this.state = "timeout";
    this.stopClock();
    this.ring.classList.remove("searching");
    if (!reduce.matches) { this.fire.coast(); this.water.coast(); }
    this.fade(.28, 900);
    this.place(9, 900, EASE_OUT);
    this.crossfade(() => this.say("No one's around right now", "Keep waiting, or try again in a little while.", "100%"));
    this.searchRow.hidden = true; this.timeoutRow.hidden = false;
  }

  /** Somebody was found: the two meet, then the halves lock. */
  async found(name: string, iAmFireboy: boolean): Promise<void> {
    if (this.state !== "search") return;
    this.state = "found";
    this.stopClock(true);
    this.ring.classList.remove("searching");
    this.searchRow.hidden = true;
    const scale = this.fillScale();
    this.fill.animate([{ transform: `scaleX(${scale})` }, { transform: "scaleX(1)" }], { duration: 320, easing: EASE_OUT, fill: "forwards" });
    this.pct.textContent = "100%";
    if (!reduce.matches) {
      await Promise.all([this.fire.glide(this.fire.topAhead(), 720), this.water.glide(this.water.topAhead(), 720)]);
      if (this.state !== "found") return;
      this.burst();
    }
    this.fade(0, 260);
    this.complete.animate([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "scale(1)" }], { duration: 380, easing: EASE_OUT, fill: "forwards" });
    this.bloom.animate([{ opacity: 0, transform: "scale(.7)" }, { opacity: 1, transform: "scale(1.08)", offset: .35 }, { opacity: .45, transform: "scale(1)" }],
      { duration: 900, easing: EASE_OUT, fill: "forwards" });
    // They met with momentum, so the lock may bounce a little.
    if (reduce.matches) this.place(0, 200, EASE_OUT);
    else this.place(0, spring(.72, .42));
    this.crossfade(() => this.say(`Matched with ${name}`, `You're ${iAmFireboy ? "Fireboy" : "Watergirl"} · Connecting…`, ""));
  }

  private say(title: string, sub: string, pct: string): void {
    this.title.textContent = title; this.sub.textContent = sub; this.pct.textContent = pct;
  }

  private crossfade(change: () => void): void {
    if (reduce.matches) { change(); return; }
    this.words.dataset.out = "";
    setTimeout(() => { change(); delete this.words.dataset.out; }, 160);
  }

  /** The halves' gap; one spring or one curve, from wherever they are now. */
  private place(dx: number, timing: number | { easing: string; duration: number }, easing = "linear"): void {
    const opts = typeof timing === "number" ? { duration: timing, easing } : timing;
    this.halves.forEach((half, i) => {
      const from = getComputedStyle(half).transform;
      half.getAnimations().forEach(a => a.cancel());
      const to = `translateX(${i ? dx : -dx}px)`;
      half.animate([{ transform: from }, { transform: to }], opts);
      half.style.transform = to;
    });
  }

  private fade(opacity: number, duration = 400): void {
    for (const comet of this.comets) {
      const from = getComputedStyle(comet).opacity;
      comet.getAnimations().filter(a => (a.effect as KeyframeEffect | null)?.getKeyframes().some(k => "opacity" in k)).forEach(a => a.cancel());
      comet.animate([{ opacity: from }, { opacity }], { duration, easing: EASE_OUT, fill: "forwards" });
    }
  }

  private burst(): void {
    for (let i = 0; i < 10; i++) {
      const color = i % 2 ? "var(--water)" : "var(--fire)";
      const spark = el("i", { class: "qm-spark" });
      spark.style.background = color; spark.style.boxShadow = `0 0 6px ${color}`;
      this.ring.append(spark);
      const a = (-90 + (i - 4.5) * 22) * Math.PI / 180, r = 16 + (i % 3) * 6;
      spark.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 },
                     { transform: `translate(${Math.cos(a) * r}px,${Math.sin(a) * r}px) scale(.3)`, opacity: 0 }],
        { duration: 560 + (i % 3) * 80, easing: EASE_OUT, delay: i * 12 }).finished.then(() => spark.remove(), () => spark.remove());
    }
  }

  private fillScale(): number {
    const m = getComputedStyle(this.fill).transform;
    return m === "none" ? 0 : Number(m.slice(7, -1).split(",")[0]);
  }

  private startClock(): void {
    this.stopClock();
    this.barAnim = this.fill.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: this.o.windowMs, easing: "linear", fill: "forwards" });
    const anim = this.barAnim;
    anim.finished.then(() => { if (this.barAnim === anim && this.state === "search") this.o.onTimeout(); }, () => {});
    this.ticker = setInterval(() => this.paint(), 250);
    this.paint();
  }

  /** Stop the clock; `keep` leaves the bar where it stands for `found` to finish. */
  private stopClock(keep = false): void {
    if (this.ticker !== null) { clearInterval(this.ticker); this.ticker = null; }
    if (this.barAnim) {
      if (keep) this.fill.style.transform = `scaleX(${this.fillScale()})`;
      this.barAnim.cancel(); this.barAnim = null;
    }
    this.paint();
  }

  private paint(): void {
    const p = Math.round(this.fillScale() * 100);
    if (this.state === "search") this.pct.textContent = `${p}%`;
    this.bar.setAttribute("aria-valuenow", String(p));
  }

  /**
   * Swap the two views in place, with the card's height following.
   *
   * Height is the one thing here that cannot be a transform -- the views are
   * different heights and the sections below have to move -- so it is
   * measured before and after and animated once, the accordion exception.
   */
  private swap(from: HTMLElement, to: HTMLElement, after?: () => void): void {
    if (this.swapTimer !== null) clearTimeout(this.swapTimer);
    const card = this.root;
    const start = card.getBoundingClientRect().height;
    from.dataset.out = "";
    const finish = () => {
      this.swapTimer = null;
      from.hidden = true; to.hidden = false;
      after?.();
      const end = card.getBoundingClientRect().height;
      if (!reduce.matches && Math.abs(end - start) > 1) {
        card.animate([{ height: `${start}px` }, { height: `${end}px` }], { duration: 260, easing: EASE_OUT });
      }
      requestAnimationFrame(() => delete to.dataset.out);
    };
    if (reduce.matches) finish();
    else this.swapTimer = setTimeout(finish, 180);
  }
}
