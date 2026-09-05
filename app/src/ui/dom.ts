/**
 * Just enough DOM to build six screens and a game canvas.
 *
 * No framework, deliberately. The app is a handful of forms wrapped around a
 * 640x480 canvas, and every kilobyte of framework is kilobytes in front of the
 * first frame. Lists here are small enough to redraw whole.
 */

import { emblem } from "./brand.js";

type Attrs = Record<string, unknown>;
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
      on(node, k.slice(2).toLowerCase(), v as (e: Event) => unknown);
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
  (wrap as any).input = input;
  return wrap as HTMLLabelElement;
}

export function inputOf(label: HTMLLabelElement): HTMLInputElement {
  return (label as any).input as HTMLInputElement;
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
