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
  auth, changeEmail, changePassword, claimUsername, deleteAccount, deletePasskey,
  enrolTotp, generateRecoveryCodes, hasPassword, listFactors, listPasskeys,
  passkeysAvailable, recoveryCodesLeft, registerPasskey,
  ReauthenticationNeeded, sendReauthenticationCode, setPassword,
  signOutOtherDevices, unenrolTotp, verifyTotp,
  resendEmailChange, verifyEmailCode,
} from "../auth.js";
import { captcha, type Captcha } from "../captcha.js";
import { codeClock, codeField, tryCode } from "../ui/code.js";
import { supabase } from "../supabase.js";
import { card, el, field, form, inputOf, note, on } from "../ui/dom.js";
import { presentationPreferences, savePresentationPreferences } from "../presentation.js";
import { glowSwitch } from "../ui/glowswitch.js";

/**
 * One row per setting, and only one of them open.
 *
 * Six forms stacked down a card is four screens of scrolling in the drawer,
 * and somebody looking for the leaderboard switch had to travel past a
 * password field, an email field and a QR code to find it. Collapsed, the
 * whole account fits above the fold: the summary says what each setting is
 * SET TO right now -- the username, the address, on or off -- so most visits
 * are answered without opening anything at all.
 *
 * `name` on <details> is what makes it an accordion: the browser closes the
 * open row when another is opened, so there is never more than one form's
 * worth of height on screen. Where that attribute is not supported the rows
 * simply all stay open, which is the layout this screen had before.
 */
function group(title: string, value: Node | string, ...children: (Node | string)[]): HTMLElement {
  const summary = el("summary", {},
    el("span", { class: "settings-name" }, title),
    typeof value === "string" ? el("span", { class: "settings-value" }, value) : value);
  const row = el("details", { class: "settings-group", name: "settings" }, summary,
    el("div", { class: "settings-body" }, ...children));
  // An opened row whose form runs off the bottom of the drawer looks like a
  // row that did nothing. Bring it back into view, without moving the page
  // when it is already there.
  on(row, "toggle", () => { if (row.hasAttribute("open")) row.scrollIntoView({ block: "nearest" }); });
  return row;
}

export function settingsScreen(host: HTMLElement): () => void {
  const profile = auth().profile;
  // Turnstile widgets made by the rows below, taken down with the screen.
  const widgets: Captcha[] = [];
  const human = () => { const c = captcha(); widgets.push(c); return c; };

  const name = field("Username", {
    required: true, minlength: 3, maxlength: 20,
    pattern: "[A-Za-z0-9](_?[A-Za-z0-9]){2,19}",
    value: profile?.username ?? "",
  });
  const saved = note("Saved.");
  saved.hidden = true;

  const factors = el("div", { class: "factors" }, note("Checking…"));
  const nameValue = el("span", { class: "settings-value" }, profile?.username ?? "Not set");
  const twoFactorValue = el("span", { class: "settings-value" }, "Checking…");
  const boardValue = el("span", { class: "settings-value" }, "Checking…");
  const passwordValue = el("span", { class: "settings-value" }, "Checking…");
  const passkeyValue = el("span", { class: "settings-value" }, "Checking…");
  // Spaced as the two-factor row is: a list, then its buttons, 8px apart.
  const passkeys = el("div", { class: "passkey-row" }, note("Checking…"));
  const passkeyRow = group("Passkeys", passkeyValue, passkeys);
  passkeyRow.hidden = true;
  const password = el("div", {}, note("Checking…"));
  const email = el("div", {}, note("Checking…"));

  host.append(card("Settings",
    el("div", { class: "settings-list" },
      group("Username", nameValue,
        note("A friend types this to find you. Changing it takes effect at " +
             "once, everywhere."),
        form({
          submit: "Save",
          children: [name, saved],
          onSubmit: async () => {
            const claimed = inputOf(name).value.trim();
            await claimUsername(claimed);
            nameValue.textContent = claimed;
            saved.hidden = false;
            // Deliberately no re-render. `claimUsername` publishes the new
            // profile, so everything reading it updates on its own -- and
            // rebuilding this screen would throw away the confirmation the
            // moment it appeared, leaving a save that looks like nothing
            // happened.
          },
        })),
      passkeyRow,
      group("Password", passwordValue, password),
      group("Email", auth().user?.email ?? "Not set", email),
      group("Two-factor", twoFactorValue, factors),
      group("Leaderboard", boardValue, boardSection(boardValue)),
      group("Game display", "On this device", presentationSection()),
      group("Delete This Account", "", dangerSection())),
    el("p", { class: "note" },
      el("a", { href: "#/play" }, "Back to the game"))));

  void drawFactors(factors, twoFactorValue);
  void passkeysAvailable().then((yes) => {
    if (!yes) return;
    passkeyRow.hidden = false;
    void drawPasskeys(passkeys, passkeyValue);
  });
  void drawPassword(password, passwordValue, email, human);
  return () => { for (const w of widgets) w.remove(); };
}

function presentationSection(): HTMLElement {
  const preferences = presentationPreferences();
  const fps = el("select", { class: "pick" },
    ...[0, 30, 60, 120, 144, 240].map(value => el("option", { value: String(value) }, value ? `${value} FPS` : "Auto · follow display")));
  const scale = el("select", { class: "pick" },
    ...[[1, "Standard"], [1.5, "Sharper"], [2, "High"]].map(([value, label]) => el("option", { value: String(value) }, String(label))));
  fps.value = String(preferences.fps); scale.value = String(preferences.scale);
  const change = () => savePresentationPreferences({ fps: Number(fps.value), scale: Number(scale.value) });
  on(fps, "change", change); on(scale, "change", change);
  // The glow's own switch, the same one the Menu carries.
  const glow = glowSwitch();
  // The same labelled fields as every other row's form, so the two pickers do
  // not arrive as the browser's bare selects with their labels run into them.
  return el("div", { class: "settings-fields" },
    el("label", { class: "field" }, el("span", {}, "Frame rate"), fps),
    el("label", { class: "field" }, el("span", {}, "Output quality"), scale),
    glow.root,
    note("Higher frame rates can make movement smoother when your display and computer support them. Lower settings use less power. These choices apply only to your screen; your friend can choose independently."));
}

/**
 * Fill in the password row once the database has said which one it is.
 *
 * Asked rather than assumed, and asked asynchronously, so the row arrives as
 * "Checking…" exactly as two-factor and the leaderboard do. The question cannot
 * be answered from the session -- see `hasPassword` -- and answering it wrongly
 * produces either a form nobody can satisfy or one that sets a password without
 * asking for anything.
 */
async function drawPassword(host: HTMLElement, value: HTMLElement,
                            email: HTMLElement, human: () => Captcha): Promise<void> {
  const has = await hasPassword();
  value.textContent = has ? "Change it" : "Set a password";
  host.replaceChildren(passwordSection(has, value, human));
  // The address row asks the same question -- prove the password, if there
  // is one -- so it waits for the same answer.
  email.replaceChildren(emailSection(has, human));
}

/**
 * Whether this account's pairs appear on the board.
 *
 * Per account, and it takes the whole entry off wherever it appears: a row on
 * the board belongs to two people, and there is no half of one to publish. That
 * also means nobody can put somebody else on it.
 */
function boardSection(value: HTMLElement): HTMLElement {
  const box = el("input", { type: "checkbox" });
  const say = () => { value.textContent = box.checked ? "Hidden" : "Listed"; };
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
        value.textContent = "Unknown";
        return;
      }
      box.checked = !!data?.hide_from_leaderboard;
      box.disabled = false;
      say();
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
    say();
    said.textContent = "Saved.";
    said.hidden = false;
  });

  return el("div", {},
    note("Best times per level, across everybody. Both names are shown."),
    label, said);
}

/**
 * Change the password, proving the old one on the way through -- or, when
 * there is no old one, proving the inbox instead.
 *
 * An account that arrived through Google has no password, so the proof
 * `changePassword` uses -- signing in with the current one -- is not
 * available. That row used to drop the proof altogether, on the argument that
 * there was no password to take over. But setting one ADDS a way in that
 * outlives the session, so a tab somebody left open could give them a
 * permanent key to the account. So it asks for the code Supabase mails to the
 * account's address (`reauthenticate`) and sends it with the new password as
 * the nonce, which Supabase checks once "Secure password change" is on.
 */
function passwordSection(has: boolean, value: HTMLElement,
                         human: () => Captcha): HTMLElement {
  const current = field("Current password", {
    type: "password", required: true, autocomplete: "current-password",
  });
  const code = field("Code from the email", {
    inputmode: "numeric", pattern: "[0-9]{6,10}", required: true,
    autocomplete: "one-time-code",
  });
  const next = field(has ? "New password" : "Password", {
    type: "password", required: true, minlength: 8,
    autocomplete: "new-password",
  });
  const done = note("");
  done.hidden = true;
  const mailed = note(`Sent to ${auth().user?.email ?? "your address"}.`);
  mailed.hidden = true;
  const ask = el("button", { type: "button", class: "ghost small",
    onclick: async (e: Event) => {
      const button = e.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        await sendReauthenticationCode();
        mailed.textContent = `Sent to ${auth().user?.email ?? "your address"}.`;
      } catch (err) {
        mailed.textContent = (err as Error).message;
      } finally {
        mailed.hidden = false;
        button.disabled = false;
      }
    } }, "Email me a code");
  // The same button and code field, for a password holder Supabase has asked
  // to reauthenticate. Built once, shown only when needed.
  const codeRow = el("div", { hidden: true },
    note("Supabase wants a code from your email as well, because this session " +
         "is more than a day old."),
    el("p", { class: "note" }, ask), mailed, code);
  // A required field the browser cannot show blocks the whole form.
  if (has) inputOf(code).required = false;
  // Proving the current password is a password sign-in, which Supabase
  // guards with Turnstile.
  const check = has ? human() : null;

  return el("div", {},
    has ? null : note("This account has no password: you sign in with a " +
                      "passkey, Google or an emailed code. Setting one ADDS " +
                      "another way in, and the others keep working. We email " +
                      "a code to your address first."),
    // Not "to prove it is you": Supabase checks that code only for a session
    // over a day old, so for a younger one it is this screen's check, not the
    // server's. Saying it proved anything would overstate it.
    form({
      submit: has ? "Change password" : "Set password",
      // A password holder is asked for the code only if Supabase asks for it
      // (`ReauthenticationNeeded`): a session over a day old, once "Secure
      // password change" is on. Until then the code row stays out of the way.
      captcha: check?.node,
      children: has ? [current, codeRow, next, done]
                    : [el("p", { class: "note" }, ask), mailed, code, next, done],
      onSubmit: async () => {
        done.hidden = true;
        const nonce = inputOf(code).value.trim() || undefined;
        let others: boolean;
        try {
          others = has
            ? await changePassword(inputOf(current).value, inputOf(next).value,
                                   nonce, await check!.token())
            : await setPassword(inputOf(next).value, nonce);
        } catch (e) {
          if (e instanceof ReauthenticationNeeded) {
            codeRow.hidden = false;
            inputOf(code).required = true;
          }
          throw e;
        }
        done.textContent = (has ? "Changed." : "Set. You can now sign in either way.") +
          (others ? " Every other device was signed out."
                  : " Other devices could not be signed out -- sign out on them, " +
                    "or change it again to retry.");
        inputOf(current).value = "";
        inputOf(code).value = "";
        inputOf(next).value = "";
        mailed.hidden = true;
        done.hidden = false;
        // The row said "Set a password" and no longer should. Only the summary
        // is corrected, not the whole section: rebuilding it would replace the
        // form and take the confirmation above with it, which is the mistake
        // the username row documents.
        value.textContent = "Change it";
      },
    }));
}

/**
 * Move the account to another address.
 *
 * The address is where password resets go, so this is the account changing
 * hands as far as recovery is concerned: an account with a password proves it
 * first. One without -- Google only -- relies on Supabase's "Secure email
 * change", which mails a code to the OLD address as well as the new one, and
 * wants both.
 *
 * Nothing changes until both codes are in, so the first step ends in "enter
 * the codes", not "done": reporting success there would have somebody sign out
 * believing an address they cannot yet sign in with.
 */
function emailSection(has: boolean, human: () => Captcha): HTMLElement {
  const current = auth().user?.email ?? "";
  const password = field("Current password", {
    type: "password", required: true, autocomplete: "current-password",
  });
  const next = field("New email", {
    type: "email", required: true, autocomplete: "email",
  });
  // Only a password proof is a protected sign-in; a Google-only account
  // sends nothing that Supabase checks for a person.
  const check = has ? human() : null;
  const box = el("div", {});

  const start = form({
    submit: "Send codes",
    children: has ? [password, next] : [next],
    captcha: check?.node,
    onSubmit: async () => {
      const address = inputOf(next).value.trim();
      await changeEmail(address, has ? inputOf(password).value : null,
                        await check?.token());
      inputOf(password).value = "";
      // Back rebuilds the first step rather than putting this form back: a
      // Turnstile iframe that leaves the page and returns is reloaded under
      // the widget and stops answering.
      box.replaceChildren(emailCodes(current, address, human,
                                     () => box.replaceWith(emailSection(has, human))));
    },
  });
  box.append(note("Signed in as ", el("code", {}, current), "."), start);
  return box;
}

/**
 * The second step: a code from each address.
 *
 * Each is checked on its own, and one that has gone through is locked rather
 * than sent again -- the server spends it on the first try, so retrying the
 * pair after the second was mistyped would refuse the first.
 */
function emailCodes(current: string, address: string, human: () => Captcha,
                    back: () => void): HTMLElement {
  const old = codeField(`Code sent to ${current}`);
  const fresh = codeField(`Code sent to ${address}`);
  inputOf(old).autofocus = true;
  const again = human();
  const done = new Set<HTMLLabelElement>();
  const box = el("div", {});

  const prove = async (wrap: HTMLLabelElement, to: string) => {
    if (done.has(wrap)) return;
    await tryCode(wrap, (c) => verifyEmailCode("email_change", to, c));
    done.add(wrap);
    inputOf(wrap).disabled = true;
  };

  box.append(
    note("Enter the code from each inbox. Nothing changes until both are in."),
    form({
      submit: "Change address",
      children: [old, fresh,
        codeClock(Date.now(), async () => {
          done.clear();
          inputOf(old).disabled = false;
          inputOf(fresh).disabled = false;
          await resendEmailChange(address, await again.token());
        })],
      captcha: again.node,
      onSubmit: async () => {
        await prove(old, current);
        await prove(fresh, address);
        box.replaceChildren(note("Done. You sign in with ", el("code", {}, address),
                                 " from now on."));
      },
      footer: el("p", { class: "note" },
        el("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); back(); } },
          "Use a different address")),
    }));
  return box;
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
    // The one thing deleting CANNOT reach.
    //
    // `delete_me` removes the row in `auth.users` and everything cascades from
    // it, including the Google identity -- on this side. The permission itself
    // lives in the person's Google account, where nothing here can touch it,
    // so an account deleted from this screen leaves "Fireboy & Watergirl" in
    // their list of connected apps until they take it out themselves. It is
    // not access to anything afterwards: signing in with Google again makes a
    // NEW account that is asked for an invite code like any other. It is a
    // stale entry, and somebody deleting an account is exactly the person who
    // would want to know it is there.
    note("Signed in with Google? Deleting here does not remove this game " +
         "from your Google account. You can do that at ",
      el("a", { href: "https://myaccount.google.com/permissions",
                target: "_blank", rel: "noopener noreferrer" },
        "your Google permissions"), "."),
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

async function drawFactors(host: HTMLElement, value: HTMLElement): Promise<void> {
  let enrolled;
  try {
    enrolled = (await listFactors()).filter((f) => f.status === "verified");
  } catch (e) {
    host.replaceChildren(note((e as Error).message));
    value.textContent = "Unknown";
    return;
  }
  value.textContent = enrolled.length > 0 ? "On" : "Off";

  if (enrolled.length > 0) {
    const codes = el("div", { class: "codes" });
    host.replaceChildren(
      note("An authenticator app is enrolled. You will be asked for a code " +
           "every time you sign in. Turning it off signs out your other " +
           "devices."),
      recoverySection(codes),
      codes,
      el("button", {
        class: "ghost",
        onclick: async () => {
          for (const f of enrolled) await unenrolTotp(f.id);
          // A password-only session parked at the code prompt somewhere else
          // would otherwise be let in the moment the factor goes. The database
          // ends those itself (`20261006000000`); this also ends `aal2` ones.
          const others = await signOutOtherDevices();
          await drawFactors(host, value);
          if (!others) {
            host.prepend(note("Two-factor is off, but other devices could not " +
                              "be signed out. Sign out on them yourself."));
          }
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
          await drawEnrolment(host, value);
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

async function drawEnrolment(host: HTMLElement, value: HTMLElement): Promise<void> {
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
        await drawFirstCodes(host, value);
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
async function drawFirstCodes(host: HTMLElement, value: HTMLElement): Promise<void> {
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
        onclick: () => void drawFactors(host, value),
      }, "Back"));
    return;
  }

  const acknowledged = el("input", { type: "checkbox" });
  const done = el("button", { class: "primary", disabled: true },
                  "I have written them down");
  acknowledged.addEventListener("change", () => {
    done.disabled = !acknowledged.checked;
  });
  done.addEventListener("click", () => void drawFactors(host, value));

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

/**
 * The passkeys on this account: each one by name, a way to remove it, and a
 * way to add one for this device.
 *
 * Removing the last one is allowed and says what is left, rather than being
 * refused: an emailed code and Google still sign the account in, so it is
 * never the way to lock yourself out.
 */
async function drawPasskeys(host: HTMLElement, value: HTMLElement): Promise<void> {
  let keys;
  try {
    keys = await listPasskeys();
  } catch (e) {
    host.replaceChildren(note((e as Error).message));
    value.textContent = "Unknown";
    return;
  }
  value.textContent = keys.length ? `${keys.length} saved` : "None";
  const said = note("");
  said.hidden = true;
  const say = (text: string) => { said.textContent = text; said.hidden = false; };
  const date = (iso: string) => new Date(iso).toLocaleDateString(undefined,
    { year: "numeric", month: "short", day: "numeric" });

  const add = el("button", { class: "ghost", onclick: async () => {
    add.disabled = true;
    try {
      if (await registerPasskey()) await drawPasskeys(host, value);
    } catch (e) {
      say((e as Error).message);
    } finally {
      add.disabled = false;
    }
  } }, keys.length ? "Add another passkey" : "Add a passkey");

  host.replaceChildren(...[
    note("Sign in with your face, fingerprint or device PIN instead of a " +
         "password. Passkeys saved to a password manager or iCloud Keychain " +
         "follow you to your other devices."),
    keys.length ? el("ul", { class: "passkeys" }, ...keys.map((k) => {
      const remove = el("button", { class: "ghost small", onclick: async () => {
        remove.disabled = true;
        try {
          await deletePasskey(k.id);
          await drawPasskeys(host, value);
        } catch (e) {
          remove.disabled = false;
          say((e as Error).message);
        }
      } }, "Remove");
      return el("li", {},
        el("span", {}, el("strong", {}, k.name), el("br"),
          el("span", { class: "note" }, `Added ${date(k.created)}` +
            (k.lastUsed ? ` · last used ${date(k.lastUsed)}` : ""))),
        remove);
    })) : null,
    add, said].filter((n): n is HTMLElement => n !== null));
}
