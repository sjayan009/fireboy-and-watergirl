/**
 * Account settings: rename yourself, and turn on a second factor.
 *
 * Two-factor is optional and, once enrolled, is enforced at every sign-in --
 * `auth.ts` holds the session at the `locked` stage until the code is answered.
 */
import {
  auth, claimUsername, enrolTotp, listFactors, unenrolTotp, verifyTotp,
} from "../auth.js";
import { card, el, field, form, inputOf, note } from "../ui/dom.js";

export function settingsScreen(host: HTMLElement): void {
  const profile = auth().profile;

  const name = field("Username", {
    required: true, minlength: 3, maxlength: 20,
    pattern: "[A-Za-z0-9](_?[A-Za-z0-9]){2,19}",
    value: profile?.username ?? "",
  });
  const saved = note("Saved.");
  saved.hidden = true;

  const factors = el("div", { class: "factors" }, note("Checking…"));

  host.append(card("Settings",
    el("h2", {}, "Name"),
    note("Changing it does not cost another invite code."),
    form({
      submit: "Save",
      children: [name, saved],
      onSubmit: async () => {
        // Already through the gate, so no code: the database only asks for one
        // when a profile does not yet exist.
        await claimUsername(inputOf(name).value.trim(), null);
        saved.hidden = false;
        // Deliberately no re-render. `claimUsername` publishes the new profile,
        // so everything reading it updates on its own -- and rebuilding this
        // screen would throw away the confirmation the moment it appeared,
        // leaving a save that looks like nothing happened.
      },
    }),
    el("h2", {}, "Two-factor"),
    factors,
    el("p", { class: "note" },
      el("a", { href: "#/play" }, "Back to the game"))));

  void drawFactors(factors);
}

async function drawFactors(host: HTMLElement): Promise<void> {
  let enrolled;
  try {
    enrolled = (await listFactors()).filter((f) => f.status === "verified");
  } catch (e) {
    host.replaceChildren(note((e as Error).message));
    return;
  }

  if (enrolled.length > 0) {
    host.replaceChildren(
      note("An authenticator app is enrolled. You will be asked for a code " +
           "every time you sign in."),
      el("button", {
        class: "ghost",
        onclick: async () => {
          for (const f of enrolled) await unenrolTotp(f.id);
          await drawFactors(host);
        },
      }, "Turn it off"));
    return;
  }

  host.replaceChildren(
    note("Optional. Adds a six-digit code from an authenticator app to every " +
         "sign-in."),
    el("button", {
      class: "ghost",
      onclick: async (e: Event) => {
        (e.target as HTMLButtonElement).disabled = true;
        try {
          await drawEnrolment(host);
        } catch (err) {
          host.replaceChildren(note((err as Error).message));
        }
      },
    }, "Turn it on"));
}

async function drawEnrolment(host: HTMLElement): Promise<void> {
  const { factorId, qr, secret } = await enrolTotp();
  const code = field("Six-digit code", {
    inputmode: "numeric", pattern: "[0-9]{6}", required: true,
    autocomplete: "one-time-code",
  });

  host.replaceChildren(
    note("Scan this with your authenticator app, then type the code it shows."),
    // Supabase returns the QR as an SVG data URL.
    el("img", { class: "qr", src: qr, alt: "Two-factor QR code",
                width: "180", height: "180" }),
    note("Or enter the key by hand: ", el("code", {}, secret)),
    form({
      submit: "Confirm",
      children: [code],
      onSubmit: async () => {
        await verifyTotp(factorId, inputOf(code).value.trim());
        await drawFactors(host);
      },
    }));
}
