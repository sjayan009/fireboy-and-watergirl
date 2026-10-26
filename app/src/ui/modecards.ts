/**
 * How to play, asked between the title screen's Play and the map.
 *
 * Two cards a screen -- Local Play or Online Play, then the two ways of each --
 * drawn over the stage in the game's own type. Every number is a stage pixel
 * (the overlay is a 640x480 stage scaled with the canvas) and is measured, not
 * chosen:
 *
 *   - the face is the SWF's font 49, Trajan Pro Bold, the one every menu word
 *     is set in; titles are the menu's 29.7px (37px x 0.8031), the rest use the
 *     sizes its own text fields use (18 and 15);
 *   - the cards are centred in the band between the title art, whose ink ends
 *     at y=170, and Back's cap height at y=457.4, so the ring clears each by
 *     the same 31.7px; inside a card the art, title and line below are
 *     centred too, 15.2px from the top and the bottom;
 *   - Back takes the map button's colours, #89681D lifting to #FFCC00, and its
 *     black outline. The title screen's Watergirl stands where the map draws
 *     that button, so Back sits in the corner under her, at 18px -- a size the
 *     SWF's own text uses -- 9px in from both edges, as the title's own corner
 *     text is;
 *   - the soft glow around the chosen card is the menu's own hover glow, a
 *     white GlowFilter of blur 29, three passes, strength 4.3. Three box passes
 *     of width 29 are a Gaussian of sigma sqrt(3(29^2-1)/12) = 14.49, and
 *     strength is a clamped alpha multiplier, so the filter below is exactly
 *     that rather than a CSS shadow that looks about right.
 *
 * The ring marks what you are choosing; nothing is ever filled in. Exactly one
 * card holds it, moved by the pointer and the arrow keys alike, so hover and
 * focus can never ring two cards at once.
 *
 * ## The pictures
 *
 * Each card says what it does in a picture before a word is read: one screen
 * for the same computer, two linked screens for different ones, a shared
 * keyboard, a robot buddy, a stranger's "?" and a heart for friends. The
 * screens show the landing page's own two-doors scene -- its temple wall, its
 * exit doors and its runners -- at that scene's measured layout and scale
 * (doors 166x177 at x=136 and 338, runners on one floor line), so everything in
 * them is one drawing at one size. Only the selected card moves: the runners
 * run, the link flows, the "?" pulses and the heart beats; reduced motion
 * keeps them all still.
 */
import { el } from "./dom.js";
import fireRun from "../../../design/landing/assets/sprites/fire-run.webp";
import waterRun from "../../../design/landing/assets/sprites/water-run.webp";
import fireDoor from "../../../design/landing/assets/doors/fire.webp";
import waterDoor from "../../../design/landing/assets/doors/water.webp";
import templeWall from "../../../design/landing/assets/wall.webp";

const STAGE_W = 640;
/** The Flash glow's sigma in stage pixels, from blur 29 at quality 3. */
const GLOW_SIGMA = Math.sqrt(3 * (29 * 29 - 1) / 12);
const GLOW_STRENGTH = 4.3;
/**
 * The map button's own text treatment: a black GlowFilter, blur 2 at one pass
 * (sigma sqrt((2^2-1)/12) = 0.5), strength 10 -- a hard outline that keeps the
 * word legible over vines, wood and the title screen's characters.
 */
const OUTLINE_SIGMA = Math.sqrt((2 * 2 - 1) / 12);
const OUTLINE_STRENGTH = 10;
const reduce = matchMedia("(prefers-reduced-motion: reduce)");

type Screen = "root" | "local" | "online";

export interface ModeCardsOptions {
  /** Signed out: the online cards say an account is needed, and lead to one. */
  guest: boolean;
  onTwoPlayers(): void;
  onQuickMatch(): void;
  onFriends(): void;
  /** Escape or Back from the first screen: the title screen's own menu again. */
  onClose(): void;
}

// ---- the pictures ---------------------------------------------------------
//
// Static markup: nothing in it comes from a player.

/**
 * A screen on a stand, `w` stage px wide, looking at the window [x, y, vw] of
 * the landing scene's 640 x 500 grid. The grid is drawn in its own pixels and
 * scaled by `--k` (CSS px per stage px, set from the overlay's width), so the
 * art inside keeps the scene's proportions at any size.
 */
function screenOf(w: number, [x, y, vw]: [number, number, number], scene: string): string {
  return `<span class="mc-mon"><span class="mc-scr" style="width:calc(${w} * var(--u));height:calc(${w * 500 / 640} * var(--u))">` +
    `<span class="mc-grid" style="transform:scale(calc(var(--k) * ${w / vw})) translate(${-x}px, ${-y}px)">` +
    `<span class="mc-wall" style="background-image:url(&quot;${templeWall}&quot;)"></span><span class="mc-shade"></span>${scene}</span>` +
    `</span><span class="mc-neck"></span><span class="mc-foot"></span></span>`;
}
const door = (src: string, left: number, open = false) =>
  `<span class="mc-door" style="left:${left}px;background-image:url(&quot;${src}&quot;);background-position:${open ? 100 : 0}% 0"></span>`;
const fireAt = (left: number) => `<span class="mc-run mc-fire" style="left:${left}px;background-image:url(&quot;${fireRun}&quot;)"></span>`;
const waterAt = (left: number) => `<span class="mc-run mc-water" style="left:${left}px;background-image:url(&quot;${waterRun}&quot;)"></span>`;
const robotAt = (left: number) => `<svg class="mc-robot" style="left:${left}px" viewBox="0 0 110 124">` +
  `<g stroke="#000" stroke-width="6" stroke-linejoin="round"><line x1="55" y1="22" x2="55" y2="6"/><circle cx="55" cy="6" r="7" fill="#8fe3ff"/>` +
  `<rect x="18" y="22" width="74" height="56" rx="16" fill="#9fb7c4"/><circle cx="40" cy="50" r="11" fill="#e9fbff"/><circle cx="70" cy="50" r="11" fill="#e9fbff"/>` +
  `<rect x="34" y="82" width="42" height="24" rx="8" fill="#7f97a4"/><rect x="36" y="104" width="12" height="16" rx="4" fill="#6b8290"/>` +
  `<rect x="62" y="104" width="12" height="16" rx="4" fill="#6b8290"/></g>` +
  `<circle cx="42" cy="50" r="5" fill="#21b6f2"/><circle cx="72" cy="50" r="5" fill="#21b6f2"/></svg>`;
/** The "?", centred on its cap height (0.753em) in Watergirl's window below. */
const mystery = `<svg class="mc-mystery" viewBox="0 0 280 218.75">` +
  `<text x="140" y="173.4" text-anchor="middle" font-family="swf-font-49" font-size="170" fill="#ffcc00" stroke="#000" stroke-width="5" paint-order="stroke">?</text></svg>`;
const link = `<svg class="mc-link" viewBox="0 0 40 30"><path d="M2 22 Q20 -6 38 22" fill="none" stroke="#ffcc00" stroke-width="2.4" stroke-dasharray="3.5 3" stroke-linecap="round"/></svg>`;
const heart = `<svg class="mc-heart" viewBox="0 0 44 40">` +
  `<path d="M22 37 C4 25 1 14 6 8 C11 2 19 4 22 11 Z" fill="#ff5a26" stroke="#000" stroke-width="3" stroke-linejoin="round"/>` +
  `<path d="M22 37 C40 25 43 14 38 8 C33 2 25 4 22 11 Z" fill="#21b6f2" stroke="#000" stroke-width="3" stroke-linejoin="round"/></svg>`;
/** A keyboard with Watergirl's keys lit blue and Fireboy's red, where they really are. */
const keyboard = (() => {
  const key = (k: string, cls = "") => `<span class="mc-key${cls ? " " + cls : ""}">${k}</span>`;
  const row = (keys: string[]) => `<span class="mc-krow">${keys.join("")}</span>`;
  const plain = (ks: string) => [...ks].map(k => key(k));
  return `<span class="mc-kb">` +
    row([key("Q"), key("W", "w"), ...plain("ERTYUIOP")]) +
    row([key("A", "w"), key("S"), key("D", "w"), ...plain("FGHJK"), key("↑", "f"), key("L")]) +
    row([...plain("ZXC"), key("", "space"), key("M"), key("←", "f"), key("↓"), key("→", "f")]) + `</span>`;
})();

/** Windows onto the scene: both doors, or one player's side. */
const BOTH: [number, number, number] = [130, 176, 380];
const FIRE_SIDE: [number, number, number] = [96, 240, 280];
const WATER_SIDE: [number, number, number] = [288, 240, 280];
const ART = {
  local: screenOf(140, BOTH, door(fireDoor, 136) + door(waterDoor, 338) + fireAt(160) + waterAt(352)),
  online: screenOf(94, FIRE_SIDE, door(fireDoor, 136) + fireAt(176)) + link + screenOf(94, WATER_SIDE, door(waterDoor, 338) + waterAt(318)),
  solo: screenOf(140, BOTH, door(fireDoor, 136) + door(waterDoor, 338) + fireAt(160) + robotAt(362)),
  // Running at each other: Watergirl on the left over A W D, Fireboy on the right over the arrows.
  two: `<span class="mc-pair"><span class="mc-run mc-onkeys mc-left" style="background-image:url(&quot;${waterRun}&quot;)"></span>` +
    `<span class="mc-run mc-onkeys mc-right" style="background-image:url(&quot;${fireRun}&quot;)"></span></span>${keyboard}`,
  quick: screenOf(94, FIRE_SIDE, door(fireDoor, 136) + fireAt(176)) + link + screenOf(94, WATER_SIDE, mystery),
  friends: screenOf(94, FIRE_SIDE, door(fireDoor, 136, true) + fireAt(176)) + heart + screenOf(94, WATER_SIDE, door(waterDoor, 338, true) + waterAt(318)),
};

interface Card { title: string; sub: string; art: string; kind: string; act?: () => void; }

export class ModeCards {
  readonly root = el("div", { class: "mode-cards" });
  private readonly screenEl = el("div", { class: "mc-screen", hidden: true });
  private readonly row = el("div", { class: "mc-row", role: "group" });
  private readonly crumb = el("p", { class: "mc-crumb" });
  private readonly back = el("button", { type: "button", class: "mc-back" }, "Back");
  private readonly blur: SVGFEGaussianBlurElement;
  private screen: Screen = "root";

  constructor(private readonly o: ModeCardsOptions) {
    // The glow, as Flash computes it: blur the alpha, multiply it by the
    // strength and clamp, fill it white, and put the original back on top.
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("mc-defs");
    svg.innerHTML = `<filter id="mc-glow" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="${GLOW_SIGMA}" result="blur"/>
      <feComponentTransfer in="blur" result="strong"><feFuncA type="linear" slope="${GLOW_STRENGTH}"/></feComponentTransfer>
      <feFlood flood-color="#fff" result="white"/>
      <feComposite in="white" in2="strong" operator="in" result="glow"/>
      <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="mc-outline" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="${OUTLINE_SIGMA}" result="blur"/>
      <feComponentTransfer in="blur" result="strong"><feFuncA type="linear" slope="${OUTLINE_STRENGTH}"/></feComponentTransfer>
      <feMerge><feMergeNode in="strong"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`;
    const [glowBlur, outlineBlur] = svg.querySelectorAll("feGaussianBlur");
    this.blur = glowBlur;
    this.screenEl.append(this.crumb, this.row, this.back);
    this.root.append(svg, this.screenEl);
    this.back.addEventListener("click", () => this.goBack());
    this.root.addEventListener("keydown", (e) => this.key(e));
    // The filter works in CSS pixels, so its sigma follows the stage's scale.
    new ResizeObserver(() => {
      const scale = this.root.clientWidth / STAGE_W;
      this.root.style.setProperty("--k", String(scale));
      this.blur.setAttribute("stdDeviation", String(GLOW_SIGMA * scale));
      outlineBlur.setAttribute("stdDeviation", String(OUTLINE_SIGMA * scale));
    }).observe(this.root);
  }

  get open(): boolean { return !this.screenEl.hidden; }

  /** Open on a given screen -- the first, or the one a Back returns to. */
  show(screen: Screen = "root"): void {
    this.screenEl.hidden = false;
    this.draw(screen, 0, undefined, false);
    // Not during the press that opened us: an Enter on the canvas would go on
    // to click whichever card had just been focused, and skip a screen.
    setTimeout(() => this.row.querySelector<HTMLElement>("[data-selected]")?.focus({ preventScroll: true }));
  }

  hide(): void {
    this.screenEl.hidden = true;
  }

  private cards(screen: Screen): Card[] {
    const needAccount = "Needs a free account";
    switch (screen) {
      case "root": return [
        { title: "Local Play", sub: "Same computer", art: ART.local, kind: "screens", act: () => this.draw("local", 1) },
        { title: "Online Play", sub: "Different computers", art: ART.online, kind: "screens", act: () => this.draw("online", 1) },
      ];
      case "local": return [
        { title: "Solo + AI", sub: "With a robot buddy · soon", art: ART.solo, kind: "screens" },
        { title: "Two Players", sub: "Share one keyboard", art: ART.two, kind: "keys", act: () => this.o.onTwoPlayers() },
      ];
      case "online": return [
        { title: "Quick Match", sub: this.o.guest ? needAccount : "Play someone new", art: ART.quick, kind: "screens", act: () => this.o.onQuickMatch() },
        { title: "Friends", sub: this.o.guest ? needAccount : "Play with your friends", art: ART.friends, kind: "screens", act: () => this.o.onFriends() },
      ];
    }
  }

  /**
   * One screen of cards. `from` is the direction it arrives from: forward
   * screens come in from the right and Back returns them the way they came.
   */
  private draw(screen: Screen, from: -1 | 0 | 1, focus?: number, takeFocus = true): void {
    this.screen = screen;
    this.crumb.textContent = screen === "local" ? "Play / Local Play" : screen === "online" ? "Play / Online Play" : "Play";
    this.row.setAttribute("aria-label", screen === "root" ? "How to play" : screen === "local" ? "Local Play" : "Online Play");
    const buttons = this.cards(screen).map(card => {
      const b = el("button", { type: "button", class: "mc-card", "aria-disabled": card.act ? null : "true" },
        el("span", { class: "mc-ring", "aria-hidden": "true" }),
        el("span", { class: `mc-art mc-${card.kind}`, "aria-hidden": "true", html: card.art }),
        el("span", { class: "mc-title" }, card.title),
        el("span", { class: "mc-sub" }, card.sub));
      if (card.act) b.addEventListener("click", card.act);
      // Moving, not entering: a card drawn under a pointer that is resting
      // where the last click left it must not take the ring from the default.
      b.addEventListener("pointermove", () => { if (!b.hasAttribute("data-selected")) this.select(b); });
      b.addEventListener("focus", () => this.select(b));
      return b;
    });
    this.row.replaceChildren(...buttons);
    // Arriving, the ring starts on the first card that can be chosen.
    const at = focus ?? Math.max(0, buttons.findIndex(b => !b.hasAttribute("aria-disabled")));
    if (takeFocus) buttons[at]?.focus({ preventScroll: true });
    this.select(buttons[at]);
    if (from && !reduce.matches) {
      this.row.animate([{ opacity: 0, transform: `translateX(calc(${16 * from} * var(--u)))` }, { opacity: 1, transform: "none" }],
        { duration: 220, easing: "cubic-bezier(.23,1,.32,1)" });
    }
  }

  private select(card: HTMLElement | undefined): void {
    for (const b of this.row.children) b.toggleAttribute("data-selected", b === card);
  }

  private goBack(): void {
    if (this.screen === "root") this.o.onClose();
    else this.draw("root", -1, this.screen === "local" ? 0 : 1);
  }

  private key(e: KeyboardEvent): void {
    const cards = [...this.row.querySelectorAll<HTMLButtonElement>(".mc-card")];
    const at = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      cards[at < 0 ? 0 : (at + (e.key === "ArrowRight" ? 1 : -1) + cards.length) % cards.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Backspace") {
      this.goBack();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }
}
