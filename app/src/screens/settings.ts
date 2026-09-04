/**
 * Account settings: everything about the account that is not playing the game.
 *
 * Two-factor is optional and, once enrolled, is enforced at every sign-in --
 * `auth.ts` holds the session at the `locked` stage until the code is answered.
 * Recovery codes are minted here, ten at a time, shown once and stored hashed;
 * `supabase/unenrol.mjs` remains the answer for somebody who has lost both the
 * authenticator and the codes.
 */
import {
  auth, changeEmail, changePassword, claimUsername, deleteAccount, enrolTotp,
  generateRecoveryCodes, listFactors, recoveryCodesLeft, unenrolTotp,
  verifyTotp,
} from "../auth.js";
import { supabase } from "../supabase.js";
import { card, el, field, form, inputOf, note, on } from "../ui/dom.js";

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
    el("h2", {}, "Password"),
    passwordSection(),
    el("h2", {}, "Email"),
    emailSection(),
    el("h2", {}, "Two-factor"),
    factors,
    el("h2", {}, "Leaderboard"),
    boardSection(),
    el("h2", {}, "Delete this account"),
    dangerSection(),
    el("p", { class: "note" },
      el("a", { href: "#/play" }, "Back to the game"))));

  void drawFactors(factors);
}

/**
 * Whether this account's pairs appear on the board.
 *
 * Per account, and it takes the whole entry off wherever it appears: a row on
 * the board belongs to two people, and there is no half of one to publish. That
 * also means nobody can put somebody else on it.
 */
function boardSection(): HTMLElement {
  const box = el("input", { type: "checkbox" });
  const label = el("label", { class: "check" }, box,
    el("span", {}, "Keep my times off the leaderboard"));
  const said = note("Saved.");
  said.hidden = true;

  // Disabled until the current value is known. Reading the box before the
  // answer arrives showed "listed" to somebody who had opted out, and a click
  // on that box would have written the false default straight back.
  box.disabled = true;
  void supabase.from("profiles")
    .select("hide_from_leaderboard")
    .eq("id", auth().user?.id ?? "")
    .maybeSingle()
    .then(({ data, error }) => {
      if (error) {
        said.textContent = `Could not read this setting: ${error.message}`;
        said.hidden = false;
        return;
      }
      box.checked = !!data?.hide_from_leaderboard;
      box.disabled = false;
    });

  on(box, "change", async () => {
    said.hidden = true;
    const { error } = await supabase.from("profiles")
      .update({ hide_from_leaderboard: box.checked })
      .eq("id", auth().user?.id ?? "");
    if (error) {
      // Put the box back AND say why. Silently reverting it looks like a
      // checkbox that does not work.
      box.checked = !box.checked;
      said.textContent = `That did not save: ${error.message}`;
      said.hidden = false;
      return;
    }
    said.textContent = "Saved.";
    said.hidden = false;
  });

  return el("div", {},
    note("Best times per level, across everybody. Both names are shown."),
    label, said);
}

/** Change the password, proving the old one on the way through. */
function passwordSection(): HTMLElement {
  const current = field("Current password", {
    type: "password", required: true, autocomplete: "current-password",
  });
  const next = field("New password", {
    type: "password", required: true, minlength: 8,
    autocomplete: "new-password",
  });
  const done = note("Changed.");
  done.hidden = true;

  return el("div", {}, form({
    submit: "Change password",
    children: [current, next, done],
    onSubmit: async () => {
      done.hidden = true;
      await changePassword(inputOf(current).value, inputOf(next).value);
      inputOf(current).value = "";
      inputOf(next).value = "";
      done.hidden = false;
    },
  }));
}

/**
 * Move the account to another address.
 *
 * Says "check your email", not "done", because nothing has changed yet: the
 * link in the message is the thing that changes it, and reporting success here
 * would have somebody sign out believing an address they cannot yet sign in
 * with.
 */
function emailSection(): HTMLElement {
  const current = auth().user?.email ?? "";
  const next = field("New email", {
    type: "email", required: true, autocomplete: "email",
  });
  const sent = note("Check your new address for the confirmation link. " +
                    "Nothing changes until you follow it.");
  sent.hidden = true;

  return el("div", {},
    note("Signed in as ", el("code", {}, current), "."),
    form({
      submit: "Send the confirmation",
      children: [next, sent],
      onSubmit: async () => {
        sent.hidden = true;
        await changeEmail(inputOf(next).value.trim());
        sent.hidden = false;
      },
    }));
}

/**
 * Leaving, which is not undoable and says so.
 *
 * Typed confirmation rather than a `confirm()`, because the thing being
 * destroyed includes every level a pair finished together and those belong to
 * the other person too. A dialog you dismiss by reflex is the wrong weight for
 * that.
 */
function dangerSection(): HTMLElement {
  const name = auth().profile?.username ?? "";
  const typed = field(`Type ${name} to confirm`, {
    required: true, autocomplete: "off",
  });

  return el("div", {},
    note("This deletes your profile, your friendships, and the progress every " +
         "pair you played with earned together. It cannot be undone."),
    form({
      submit: "Delete my account",
      children: [typed],
      onSubmit: async () => {
        if (inputOf(typed).value.trim() !== name) {
          throw new Error(`Type ${name} exactly to confirm.`);
        }
        await deleteAccount();
      },
    }));
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
    const codes = el("div", { class: "codes" });
    host.replaceChildren(
      note("An authenticator app is enrolled. You will be asked for a code " +
           "every time you sign in."),
      recoverySection(codes),
      codes,
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

/**
 * Recovery codes: how many are left, and how to get a new set.
 *
 * Shown once and never again, because they are stored hashed and the database
 * genuinely cannot produce them a second time. The warning is not decoration --
 * somebody who loses these and their authenticator has no way back in but to
 * ask whoever holds the secret key.
 */
function recoverySection(codes: HTMLElement): HTMLElement {
  const left = note("Checking…");
  const mint = el("button", { class: "ghost" }, "Get recovery codes");

  const count = async () => {
    const n = await recoveryCodesLeft();
    left.textContent = n > 0
      ? `${n} recovery code${n === 1 ? "" : "s"} left.`
      : "No recovery codes. Without one, a lost authenticator means asking " +
        "whoever runs this to let you back in.";
    mint.textContent = n > 0 ? "Replace them" : "Get recovery codes";
  };
  void count();

  on(mint, "click", async () => {
    mint.disabled = true;
    try {
      const fresh = await generateRecoveryCodes();
      codes.replaceChildren(
        note("Write these down now. They are stored hashed, so this is the " +
             "only time they can be shown. Any codes you had before have " +
             "stopped working."),
        note("Using one turns two-factor OFF, and you turn it on again after."),
        el("ol", { class: "codelist" },
          ...fresh.map((c) => el("li", {}, el("code", {}, c)))));
      await count();
    } finally {
      mint.disabled = false;
    }
  });

  return el("div", {}, left, mint);
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
    note("You will be given ten recovery codes on the next step. They are the " +
         "only way back in if you lose the authenticator."),
    form({
      submit: "Confirm",
      children: [code],
      onSubmit: async () => {
        await verifyTotp(factorId, inputOf(code).value.trim());
        // The session is `aal2` now, and only now, which is what
        // `generate_recovery_codes` requires since 0014 -- and the only moment
        // in the whole flow where the codes can be both issued and shown.
        await drawFirstCodes(host);
      },
    }));
}

/**
 * The step that used to be missing.
 *
 * Enrolment finished by returning to the factor list, and recovery codes were a
 * separate button somebody had to notice and press. The recovery screen then
 * told people to enter "one of the ten you were given when you turned
 * two-factor on", which for anybody who took the ordinary path was simply not
 * true: no codes had ever been issued, and a lost authenticator meant asking
 * whoever holds the secret key.
 *
 * So it is not a step any more, it is the SAME step. The codes are minted the
 * moment the factor is verified, shown once, and the flow does not continue
 * until somebody says they have written them down.
 */
async function drawFirstCodes(host: HTMLElement): Promise<void> {
  let fresh: string[];
  try {
    fresh = await generateRecoveryCodes();
  } catch (e) {
    // The factor is on and this failed, which is the one state worth being
    // loud about: two-factor is protecting the account and there is no way
    // past it.
    host.replaceChildren(
      note("Two-factor is on, but the recovery codes could not be created: " +
           (e as Error).message),
      note("Get them from Settings before you sign out. Without one, a lost " +
           "authenticator means asking whoever runs this to let you back in."),
      el("button", {
        class: "ghost",
        onclick: () => void drawFactors(host),
      }, "Back"));
    return;
  }

  const acknowledged = el("input", { type: "checkbox" });
  const done = el("button", { class: "primary", disabled: true },
                  "I have written them down");
  acknowledged.addEventListener("change", () => {
    done.disabled = !acknowledged.checked;
  });
  done.addEventListener("click", () => void drawFactors(host));

  host.replaceChildren(
    note("Two-factor is on. These are your ten recovery codes."),
    note("Write them down or save them somewhere else now. They are stored " +
         "hashed, so this is the only time they can be shown."),
    note("Each one works once, and using one turns two-factor OFF -- you turn " +
         "it on again afterwards."),
    el("ol", { class: "codelist" },
      ...fresh.map((c) => el("li", {}, el("code", {}, c)))),
    el("label", { class: "check" }, acknowledged,
      el("span", {}, "I have saved these somewhere I can get to them")),
    done);
}
