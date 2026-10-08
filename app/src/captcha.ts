/**
 * Cloudflare Turnstile, the check Supabase asks for before it sends an email
 * or tries a password.
 *
 * Supabase verifies the token on sign-up, password sign-in, "send it again"
 * and password reset -- the requests that mail somebody or guess at an
 * account. It does NOT check `/verify`, where codes are typed; that is held by
 * the per-IP rate limit and the code's length and lifetime instead.
 *
 * Invisible unless Cloudflare wants an interaction, so most people never see
 * it. Tokens are single-use and live five minutes, so each one is taken once
 * and the widget is reset straight away to make the next.
 *
 * No site key, no widget: the token is `undefined` and Supabase, if it asks,
 * refuses with its own message. That is the state of a fork's build.
 */
import { el } from "./ui/dom.js";

interface Turnstile {
  render(node: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window { turnstile?: Turnstile }
}

const KEY = __TURNSTILE_SITE_KEY__;
const BLOCKED = "The check that keeps bots out did not load. Something may be " +
                "blocking challenges.cloudflare.com; allow it and reload.";
const FAILED = "Could not check that you are a person. Try again in a moment.";

let script: Promise<Turnstile> | null = null;

function load(): Promise<Turnstile> {
  return script ??= new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (window.turnstile ? ok(window.turnstile) : no(new Error(BLOCKED)));
    // Forgotten on failure, so the next screen tries again rather than
    // inheriting a refusal from a network blip.
    s.onerror = () => { script = null; no(new Error(BLOCKED)); };
    document.head.append(s);
  });
}

export interface Captcha {
  /** Where the widget goes; empty space unless Cloudflare wants a click. */
  node: HTMLElement;
  /** A fresh token, waiting for one if it is still being made. */
  token: () => Promise<string | undefined>;
  /** Take the widget down with the screen it was on. */
  remove: () => void;
}

export function captcha(): Captcha {
  const node = el("div", { class: "captcha" });
  if (!KEY) return { node, token: () => Promise.resolve(undefined), remove: () => {} };

  let ts: Turnstile | undefined;
  let id: string | undefined;
  let current = "";
  let problem = "";
  const waiting: Array<() => void> = [];
  const wake = () => { for (const f of waiting.splice(0)) f(); };

  const ready = load().then((t) => {
    ts = t;
    id = t.render(node, {
      sitekey: KEY,
      theme: "dark",
      size: "flexible",
      appearance: "interaction-only",
      "response-field": false,
      "refresh-expired": "auto",
      callback: (token: string) => { current = token; problem = ""; wake(); },
      "expired-callback": () => { current = ""; },
      "error-callback": () => { problem = FAILED; wake(); },
      // Room is made only while Cloudflare is asking for a click; the rest of
      // the time the widget is empty and takes none.
      "before-interactive-callback": () => node.classList.add("asking"),
      "after-interactive-callback": () => node.classList.remove("asking"),
    });
  }, (e: Error) => { problem = e.message; });

  return {
    node,
    token: async () => {
      await ready;
      // Long enough for somebody to notice the widget and click it, when
      // Cloudflare asks for that.
      if (!current && !problem) {
        await new Promise<void>((r) => { waiting.push(r); setTimeout(r, 120_000); });
      }
      const token = current;
      current = "";
      if (ts && id) ts.reset(id);
      if (!token) {
        const why = problem || FAILED;
        problem = "";
        throw new Error(why);
      }
      return token;
    },
    remove: () => { if (ts && id) ts.remove(id); },
  };
}
