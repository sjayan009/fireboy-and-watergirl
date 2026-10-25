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
 *   - the cards sit between the title art, whose ink ends at y=170, and the
 *     map's bottom-left button, whose cap height starts at y=428;
 *   - Back IS that button: 24.45px (41 x 0.49 x 1.2168), #89681D lifting to
 *     #FFCC00, on its baseline, y=446.5. The map draws it from x=29.5, which on
 *     the title screen is where Watergirl stands (ink x=69..93), so Back starts
 *     12px to her right instead;
 *   - the soft glow around the chosen card is the menu's own hover glow, a
 *     white GlowFilter of blur 29, three passes, strength 4.3. Three box passes
 *     of width 29 are a Gaussian of sigma sqrt(3(29^2-1)/12) = 14.49, and
 *     strength is a clamped alpha multiplier, so the filter below is exactly
 *     that rather than a CSS shadow that looks about right.
 *
 * The ring marks what you are choosing; nothing is ever filled in. Exactly one
 * card holds it, moved by the pointer and the arrow keys alike, so hover and
 * focus can never ring two cards at once.
 */
import { el } from "./dom.js";
import fireRun from "../../../design/landing/assets/sprites/fire-run.webp";
import waterRun from "../../../design/landing/assets/sprites/water-run.webp";
import fireDoor from "../../../design/landing/assets/doors/fire.webp";
import waterDoor from "../../../design/landing/assets/doors/water.webp";

const STAGE_W = 640;
/** The Flash glow's sigma in stage pixels, from blur 29 at quality 3. */
const GLOW_SIGMA = Math.sqrt(3 * (29 * 29 - 1) / 12);
const GLOW_STRENGTH = 4.3;
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

/** A frame of one of the landing's sprite strips, at a given stage height. */
function frame(src: string, frames: number, w: number, h: number, height: number, index: number, flip = false): HTMLElement {
  const width = height * w / h;
  const art = el("span", { class: "mc-frame", "aria-hidden": "true" });
  art.style.cssText = `--w:${width};--h:${height};background-image:url("${src}");` +
    `background-size:calc(${width * frames} * var(--u)) 100%;` +
    `background-position:${index / (frames - 1) * 100}% 0;${flip ? "transform:scaleX(-1);" : ""}`;
  return art;
}
const fire = () => frame(fireRun, 8, 205, 162, 66, 0);
const water = (dim = false) => {
  const art = frame(waterRun, 8, 225, 186, 74, 0, true);
  if (dim) art.classList.add("mc-dim");
  return art;
};
const door = (src: string, open: boolean) => frame(src, 22, 237, 253, 92, open ? 21 : 0);

interface Card { title: string; sub: string; art: () => HTMLElement[]; act?: () => void; }

export class ModeCards {
  readonly root = el("div", { class: "mode-cards", hidden: true });
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
    </filter>`;
    this.blur = svg.querySelector("feGaussianBlur")!;
    this.root.append(svg, this.crumb, this.row, this.back);
    this.back.addEventListener("click", () => this.goBack());
    this.root.addEventListener("keydown", (e) => this.key(e));
    // The filter works in CSS pixels, so its sigma follows the stage's scale.
    new ResizeObserver(() => {
      this.blur.setAttribute("stdDeviation", String(GLOW_SIGMA * this.root.clientWidth / STAGE_W));
    }).observe(this.root);
  }

  get open(): boolean { return !this.root.hidden; }

  show(): void {
    this.root.hidden = false;
    this.draw("root", 0, 0, false);
    // Not during the press that opened us: an Enter on the canvas would go on
    // to click whichever card had just been focused, and skip a screen.
    setTimeout(() => this.row.querySelector<HTMLElement>("[data-selected]")?.focus({ preventScroll: true }));
  }

  hide(): void {
    this.root.hidden = true;
  }

  private cards(screen: Screen): Card[] {
    const needAccount = "Needs a free account";
    switch (screen) {
      case "root": return [
        { title: "Local Play", sub: "On this device", art: () => [fire(), water()], act: () => this.draw("local", 1) },
        { title: "Online Play", sub: "Two places, one temple", art: () => [door(fireDoor, true), door(waterDoor, true)], act: () => this.draw("online", 1) },
      ];
      case "local": return [
        { title: "Solo + AI", sub: "Coming soon", art: () => [fire(), water(true)] },
        { title: "Two Players", sub: "Couch co-op, one keyboard", art: () => [fire(), water()], act: () => this.o.onTwoPlayers() },
      ];
      case "online": return [
        { title: "Quick Match", sub: this.o.guest ? needAccount : "Paired with someone new", art: () => [door(fireDoor, true), door(waterDoor, false)], act: () => this.o.onQuickMatch() },
        { title: "Friends", sub: this.o.guest ? needAccount : "Invite someone you know", art: () => [door(fireDoor, true), door(waterDoor, true)], act: () => this.o.onFriends() },
      ];
    }
  }

  /**
   * One screen of cards. `from` is the direction it arrives from: forward
   * screens come in from the right and Back returns them the way they came.
   */
  private draw(screen: Screen, from: -1 | 0 | 1, focus?: number, takeFocus = true): void {
    this.screen = screen;
    this.crumb.textContent = screen === "local" ? "Local Play" : screen === "online" ? "Online Play" : "";
    this.back.hidden = screen === "root";
    this.row.setAttribute("aria-label", screen === "root" ? "How to play" : this.crumb.textContent);
    const buttons = this.cards(screen).map(card => {
      const b = el("button", { type: "button", class: "mc-card", "aria-disabled": card.act ? null : "true" },
        el("span", { class: "mc-ring", "aria-hidden": "true" }),
        el("span", { class: "mc-art" }, ...card.art()),
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
