/**
 * The neutral age screen in front of every way to make an account.
 *
 * Accounts are 13 and up (COPPA): an under-13 account would need verifiable
 * parental consent, which this app does not collect. The screen asks for a
 * birth month and year without hinting at the cut-off, and keeps only the
 * answer's outcome in this browser -- never the date -- so pressing Back and
 * trying a different year shows the same refusal. Local play (`guest.ts`)
 * needs no account and stays open to everyone.
 */
import { el, form, note } from "./ui/dom.js";

const KEY = "fbwg.age";
export const MIN_AGE = 13;

/** Whole years old, counting a birthday in the current month as not yet had. */
export function ageFrom(year: number, month: number, now = new Date()): number {
  const m = now.getMonth() + 1;
  return now.getFullYear() - year - (m <= month ? 1 : 0);
}

function read(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export const ageCleared = () => read() === "ok";
const refused = () => read() === "under";

/**
 * The age question, or its refusal. `onCleared` runs once the answer is 13+.
 *
 * Built from the same `form` and `.field` / `.pick` pieces as the sign-up form
 * it stands in front of, so the two read as one screen: same labels, same
 * controls, same primary button and inline error.
 */
export function ageGate(onCleared: () => void): HTMLElement {
  const refusal = () => el("div", { class: "age-refusal" },
    note(`Online accounts are for players ${MIN_AGE} and older. You can still play together on this computer, no account needed.`),
    el("a", { class: "secondary", href: "#/local" }, "Play on This Computer"));
  if (refused()) return refusal();

  const year = new Date().getFullYear();
  const select = (label: string, first: string, options: [string, string][]) => {
    const pick = el("select", { class: "pick", required: true },
      el("option", { value: "" }, first), ...options.map(([v, t]) => el("option", { value: v }, t)));
    return { pick, field: el("label", { class: "field" }, el("span", {}, label), pick) };
  };
  const month = select("Birth month", "Month",
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
      .map((n, i) => [String(i + 1), n]));
  const yearPick = select("Birth year", "Year",
    Array.from({ length: 100 }, (_, i) => [String(year - i), String(year - i)]));

  const box: HTMLFormElement = form({
    submit: "Continue",
    children: [note("To make an account, first tell us your date of birth."),
      el("div", { class: "age-row" }, month.field, yearPick.field)],
    onSubmit: () => {
      const ok = ageFrom(Number(yearPick.pick.value), Number(month.pick.value)) >= MIN_AGE;
      try { localStorage.setItem(KEY, ok ? "ok" : "under"); } catch { /* the answer still applies to this visit */ }
      if (ok) onCleared(); else box.replaceWith(refusal());
      return Promise.resolve();
    },
  });
  return box;
}
