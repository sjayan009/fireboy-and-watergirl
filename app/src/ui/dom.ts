/**
 * Just enough DOM to build six screens and a game canvas.
 *
 * No framework, deliberately. The app is a handful of forms wrapped around a
 * 640x480 canvas, and every kilobyte of framework is kilobytes in front of the
 * first frame. Lists here are small enough to redraw whole.
 */

import { emblem } from "./brand.js";

type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => unknown)>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      on(node, k.slice(2).toLowerCase(), v);
    } else if (k === "value" && node instanceof HTMLInputElement) {
      node.value = String(v);
    } else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * Add a listener that may be async, and hear about it when it fails.
 *
 * `addEventListener` wants a function returning void, so an `async` handler
 * hands it a promise nobody holds: a rejection inside one is an unhandled
 * rejection in the console and, on screen, a button that was pressed and did
 * nothing. Half the handlers in these screens catch their own errors and half
 * relied on never having any.
 *
 * This is deliberately not a UI: it reports to the console and lets the screen
 * decide whether anything visible should happen, because most of the callers
 * already have a place to put a message and the ones that do not want one at
 * the point the promise is created rather than here.
 */
export function on(target: EventTarget, type: string,
                   handler: (e: Event) => unknown): () => void {
  const wrapped = (e: Event) => {
    let result: unknown;
    try {
      result = handler(e);
    } catch (err) {
      console.error(`the ${type} handler threw:`, err);
      return;
    }
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch((err: unknown) => {
        console.error(`the ${type} handler failed:`, err);
      });
    }
  };
  target.addEventListener(type, wrapped);
  return () => target.removeEventListener(type, wrapped);
}

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

/** A labelled input, which is most of what these screens are made of. */
export function field(label: string, attrs: Attrs = {}): HTMLLabelElement {
  const input = el("input", { autocomplete: "off", ...attrs });
  const wrap = el("label", { class: "field" }, el("span", {}, label), input);
  return wrap;
}

export function inputOf(label: HTMLLabelElement): HTMLInputElement {
  return label.querySelector("input")!;
}

/**
 * A form whose submit button disables itself while the promise is in flight and
 * shows whatever went wrong underneath.
 *
 * Every screen needs exactly this, and getting it wrong -- a double submit that
 * spends two invite codes, or an error that vanishes without being read -- is
 * the sort of thing that only shows up in front of a real person.
 */
export function form(o: {
  submit: string;
  onSubmit: () => Promise<void>;
  children: Child[];
  footer?: Child;
}): HTMLFormElement {
  const error = el("p", { class: "error", role: "alert" });
  error.hidden = true;
  const button = el("button", { type: "submit", class: "primary" }, o.submit);

  const node = el("form", {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      error.hidden = true;
      button.disabled = true;
      const was = button.textContent;
      button.textContent = "…";
      try {
        await o.onSubmit();
      } catch (err) {
        error.textContent = (err as Error).message || String(err);
        error.hidden = false;
      } finally {
        button.disabled = false;
        button.textContent = was;
      }
    },
  }, ...o.children, error, button, o.footer);
  return node;
}

/**
 * The official four-colour G, unmodified.
 *
 * Inline `<svg>` rather than an `<img>`, as `emblem()` is, and for a second
 * reason besides matching it: the deployment's `Content-Security-Policy` allows
 * images only from `'self'` and `data:`, and an inline element is not an image
 * fetch at all. Nothing about adding Google to the sign-in screens loosens that
 * header.
 *
 * The hexes are hard-coded where every other colour on screen is a variable.
 * That is deliberate -- Google's guidelines forbid recolouring the mark, so it
 * must not follow the theme, and a `--fire`-tinted G would be a licence
 * problem rather than a nice touch.
 */
function googleMark(): HTMLElement {
  const mark = el("span", { class: "google-g", "aria-hidden": "true" });
  mark.innerHTML =
    '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">' +
    '<path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>' +
    '<path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>' +
    '<path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>' +
    '<path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>' +
    "</svg>";
  return mark;
}

/**
 * "Continue with Google", in the app's own secondary face.
 *
 * One string for both screens because it is one flow: the same press signs a
 * new person up and an existing one in, and Google decides which. Labelling it
 * "Sign up" on one screen would be a promise the button cannot read.
 *
 * ## Why it holds the press
 *
 * `signInWithOAuth` builds the authorize URL in the browser and hands it to
 * `location.assign`, which does not stop this page: it stays on screen, and
 * stays clickable, for the whole DNS-TLS-redirect walk to Supabase and on to
 * Google. So a slow connection shows a button that was pressed and did
 * nothing, and gets pressed again -- and the second press mints a FRESH PKCE
 * verifier over the stored one. If the first navigation has already committed
 * by then, the `?code=` that comes back was issued against a challenge whose
 * verifier no longer exists, and the exchange fails on a screen that says
 * nothing about why.
 *
 * So it borrows the in-flight treatment from `form` below: disabled, and
 * saying so, until the page actually leaves.
 *
 * It does not put the label back on success, deliberately. Success means this
 * page is on its way out, and restoring an enabled button on the way would
 * flash a second press people can actually land.
 */
export function googleButton(onPress: () => Promise<void>): HTMLElement {
  const said = "Continue with Google";
  const error = el("p", { class: "error", role: "alert" });
  error.hidden = true;
  const label = el("span", {}, said);
  const button = el("button", {
    type: "button", class: "ghost provider",
    onclick: async () => {
      error.hidden = true;
      button.disabled = true;
      label.textContent = "…";
      try {
        await onPress();
      } catch (err) {
        error.textContent = (err as Error).message || String(err);
        error.hidden = false;
        button.disabled = false;
        label.textContent = said;
      }
    },
  }, googleMark(), label);

  return el("div", { class: "provider-block" }, button, error);
}

/** The hairline between the button above and the password form below. */
export function orDivider(): HTMLElement {
  return el("p", { class: "or" }, el("span", {}, "or"));
}

/** A centred card, which is every screen that is not the game itself. */
export function card(title: string, ...children: Child[]): HTMLElement {
  return el("div", { class: "card" },
    el("div", { class: "account-brand" }, emblem(), el("span", {}, "Fireboy & Watergirl", el("br"), "The Forest Temple")),
    el("h1", {}, title), ...children);
}

export function link(text: string, href: string): HTMLAnchorElement {
  return el("a", { href }, text);
}

export function note(...children: Child[]): HTMLElement {
  return el("p", { class: "note" }, ...children);
}
