/**
 * Getting in: sign up, verify, sign in, unlock, name yourself.
 *
 * Five screens rather than one, because they are five genuinely different
 * moments and folding them together is how people end up stuck without knowing
 * which part failed.
 */
import {
  arrivedByResetLink, askForPasskey, auth, claimUsername, declinePasskeyOffer,
  listPasskeys, passkeyAskedFor,
  passkeysAvailable, passkeyUsedHere, redeemRecoveryCode, registerPasskey, resendVerification,
  retryAuth, sendEmailCode, sendPasswordReset, setPassword, signIn,
  signInWithGoogle, signInWithPasskey, signOut, startAutofill, stopAutofill,
  takePasskeyOffer, listFactors, verifyEmailCode, verifyTotp,
} from "../auth.js";
import {
  card, el, field, form, googleButton, inputOf, link, note, orDivider,
  passkeyButton,
} from "../ui/dom.js";
import { codeClock, codeField, tryCode } from "../ui/code.js";
import { captcha } from "../captcha.js";
import { go, home, rerender } from "../router.js";
import { ageCleared, ageGate } from "../age.js";

/** Google makes accounts as well as signing them in, so it waits on the age screen too. */
const google = () => googleButton(async () => {
  if (ageCleared()) await signInWithGoogle(); else go("/signup");
});

const agreement = () => note("By making an account you agree to the ",
  link("Terms", "legal/terms.html"), " and the ", link("Privacy Policy", "legal/privacy.html"), ".");

export function signUpScreen(host: HTMLElement): void | (() => void) {
  if (!ageCleared()) {
    host.append(card("Make an Account", ageGate(rerender),
      note("Already have one? ", link("Sign In", "#/login"))));
    return;
  }
  // No password: an address and the code mailed to it make the account, and
  // a passkey is offered as soon as it exists. See `sendEmailCode`.
  const email = field("Email", { type: "email", required: true,
                                 autocomplete: "email" });
  const human = captcha();

  host.append(card("Make an Account",
    google(),
    orDivider(),
    form({
      submit: "Email me a code",
      children: [email],
      captcha: human.node,
      onSubmit: async () => {
        const address = inputOf(email).value.trim();
        await sendEmailCode(address, true, await human.token());
        awaiting = address;
        awaitingCreate = true;
        awaitingSince = Date.now();
        go("/verify");
      },
      footer: el("div", {}, agreement(), note("Already have one? ", link("Sign In", "#/login"))),
    })));
  return human.remove;
}

/**
 * A refusal that came back on the query string, waiting for the screen that can
 * show it.
 *
 * `main.ts` reads it at boot, because the query string is cleared before any
 * screen exists; the sign-in form is where somebody who was refused ends up.
 * Held in a variable rather than passed as an argument because nothing between
 * the two -- `startRouter`, the route table, `render` -- has anywhere to carry
 * it, and threading a parameter through all of them for one message would cost
 * more than it explains.
 *
 * Read once. A refusal describes the trip that just happened, so it must not
 * still be on screen after a later, unrelated visit to this form.
 */
let trouble = "";

export function reportSignInTrouble(why: string): void { trouble = why; }

export function loginScreen(host: HTMLElement): () => void {
  const email = field("Email", { type: "email", required: true,
                                 autocomplete: "email" });
  const pw = field("Password", { type: "password", required: true,
                                 autocomplete: "current-password" });

  // The same button as the sign-up screen, because Google has one flow: it
  // signs an existing account in and makes a new one, and only Google knows
  // which. Offering it on only one of the two screens would leave whichever
  // screen went without it showing a password field to an account that has no
  // password.
  const refused = el("p", { class: "error", role: "alert" }, trouble);
  refused.hidden = !trouble;
  trouble = "";

  // Recovery sits under the password box, not in the footer.
  //
  // It is reached for at one moment only -- the password just failed, or is
  // about to -- and the field it rescues is directly above it. In the footer it
  // shared a line with "Make an account", which put the way OUT of a stuck
  // sign-in next to the way to abandon signing in altogether.
  // Hidden until the project says passkeys are on, like the button above.
  const createKey = el("a", { class: "tertiary", href: "#/create-passkey" }, "Create a Passkey");
  createKey.hidden = true;
  void passkeysAvailable().then((yes) => { createKey.hidden = !yes; });
  const human = captcha();
  // "Email me a code" uses the address already typed above it, and the same
  // Turnstile widget as the form: both are one press at a time.
  const codeInstead = el("a", { href: "#", onclick: async (e: Event) => {
    e.preventDefault();
    const input = inputOf(email);
    if (!input.reportValidity()) return;
    refused.hidden = true;
    try {
      await sendEmailCode(input.value.trim(), false, await human.token());
      awaiting = input.value.trim();
      awaitingCreate = false;
      awaitingSince = Date.now();
      go("/verify");
    } catch (err) {
      refused.textContent = (err as Error).message;
      refused.hidden = false;
    }
  } }, "Email me a code");
  const forgot = el("p", { class: "field-aside" },
    link("Forgot password?", "#/reset"), " · ", codeInstead);

  // A second, separate widget for the passkey challenges: the autofill
  // request takes a token when the field is focused and holds it, and a
  // press of the button must not wait on the form's.
  const keyCheck = captcha();
  const passkeys = el("div", {});
  // The browser lists this site's passkeys in the email field's autofill
  // (`webauthn` below) as well as behind the button.
  inputOf(email).autocomplete = "email webauthn";
  // Ends with the screen, so nothing it started outlives it.
  const screen = new AbortController();
  // Started when somebody goes to the email field, not when the screen opens.
  // A waiting request is invisible in Chrome, Edge and Safari, but some
  // Chromium builds (measured in an Electron one) surface it as the system's
  // "choose a passkey" window at the next click anywhere -- the passkey
  // button included -- as though the site had asked.
  let armed = false;
  inputOf(email).addEventListener("focus", () => { if (!armed) { armed = true; autofill(); } });
  const autofill = () => void startAutofill(keyCheck.token, () => {
    refused.textContent = "That took too long. Pick your passkey again.";
    refused.hidden = false;
  }, screen.signal).catch((err: Error) => {
    refused.textContent = err.message;
    refused.hidden = false;
  });
  void passkeysAvailable().then((yes) => {
    if (!yes || screen.signal.aborted) return;
    const usePasskey = async () => {
      let signedIn = false;
      none.hidden = true;
      try {
        signedIn = await signInWithPasskey(await keyCheck.token());
      } finally {
        // The button took the browser's one WebAuthn request; give the
        // field its autofill back, if it had it, unless this screen is going.
        if (!signedIn && armed) autofill();
      }
    };
    // Asked BEFORE the system's sheet, on a device that has never used a
    // passkey here. The page cannot know whether one exists -- browsers will
    // not say -- and with none on this device, Windows and macOS still open a
    // "choose a passkey" sheet offering a phone or a security key, which reads
    // as if the site thinks you have one. So the question comes from us first.
    const none = el("div", { class: "passkey-hint", role: "group", "aria-label": "Passkey" },
      el("p", {}, "Have you saved a passkey for this game?"),
      el("div", { class: "passkey-choice" },
        el("button", { type: "button", class: "ghost", onclick: () => {
          refused.hidden = true;
          usePasskey().catch((err: Error) => {
            refused.textContent = err.message;
            refused.hidden = false;
          });
        } }, "Yes, use it"),
        el("a", { class: "tertiary", href: "#/create-passkey" }, "No, create one")),
      el("p", { class: "note" }, "It can be on this device, your phone, or a security key."));
    none.hidden = true;
    const button = passkeyButton(async () => {
      if (!passkeyUsedHere()) { none.hidden = !none.hidden; return; }
      await usePasskey();
    });
    // Withdrawn before the click lands, so a waiting autofill request cannot
    // be what answers it.
    button.addEventListener("pointerdown", () => { stopAutofill(); armed = false; }, true);
    passkeys.replaceWith(button, none, keyCheck.node);
  });

  host.append(card("Sign In",
    refused,
    passkeys,
    google(),
    orDivider(),
    form({
      submit: "Sign In",
      children: [email, pw, forgot],
      captcha: human.node,
      onSubmit: async () => {
        await signIn(inputOf(email).value.trim(), inputOf(pw).value,
                     await human.token());
      },
      // Below a rule, because this is where the screen stops being about
      // signing in. Somebody with no account cannot use anything above it, and
      // a line of grey text was a poor way to say so.
      footer: el("div", { class: "after-form" },
        el("a", { class: "secondary", href: "#/signup" }, "Make an Account"), createKey),
    })));
  return () => { screen.abort(); stopAutofill(); human.remove(); keyCheck.remove(); };
}

/**
 * Where a sign-up goes, and the address it is waiting on.
 *
 * Held here because after `signUp` there is nothing else holding it. Email
 * confirmation means Supabase issues NO session until the link is followed, so
 * there is no `auth().user` to read the address off -- the account exists on
 * the server and this browser has no proof of it.
 *
 * That is also the bug this fixes. `signUp` sent people to `/verify`, which
 * admitted only the `unverified` stage; with no session the stage is still
 * `out`, so the router turned them straight around to `/login`. Every single
 * person who signed up with an address -- not just the duplicates, everybody --
 * filled in the form, pressed the button and landed on the Sign In screen with
 * no error, no message, and no idea an email had been sent. `/verify` now
 * admits `out` as well, and this is what tells it who it is waiting for.
 */
let awaiting = "";
/** Whether the code came from the sign-up form, which may make the account. */
let awaitingCreate = false;
/** When its code was sent, for the clock; 0 when this page does not know. */
let awaitingSince = 0;

export function verifyScreen(host: HTMLElement): () => void {
  const known = awaiting || auth().user?.email || "";
  // A session here is a password sign-up from before sign-ups stopped taking
  // passwords, still unconfirmed: its code is a `signup` code. Everybody
  // else is holding a code from `sendEmailCode`.
  const legacy = !!auth().session;
  const kind = legacy ? "signup" as const : "email" as const;
  // A reload forgets the address, and so does arriving from another device.
  // Asking for it again is all either needs: the code is useless without it.
  const email = known ? null : field("Email", { type: "email", required: true,
                                                autocomplete: "email" });
  const address = () => known || inputOf(email!).value.trim();
  const code = codeField();
  inputOf(code).autofocus = !!known;
  const human = captcha();

  const startOver = async (e: Event) => {
    e.preventDefault();
    awaiting = "";
    awaitingSince = 0;
    // Signing out matters only when there IS a session; after a plain
    // sign-up there is none, and this is simply the way back.
    if (auth().session) await signOut(); else go(awaitingCreate ? "/signup" : "/login");
  };

  host.append(card("Check your email",
    // The address and the way to change it, side by side: the link acts on
    // the thing it is next to.
    known
      ? note("We sent a code to ", el("strong", {}, known), ". ",
             el("a", { href: "#", onclick: startOver }, "Change"))
      : note("Enter your address and the code we sent it."),
    // Worded so it does not say whether the address has an account: from the
    // sign-in form, an unknown address is sent nothing (see `sendEmailCode`).
    !awaitingCreate && known && !legacy
      ? note("If that address has an account, the code is on its way.")
      : null,
    form({
      submit: "Continue",
      children: [email, code,
        codeClock(awaitingSince || null, async () => {
          if (!address()) throw new Error("Enter your email first.");
          if (legacy) await resendVerification(address(), await human.token());
          else await sendEmailCode(address(), awaitingCreate, await human.token());
          awaitingSince = Date.now();
        })],
      captcha: human.node,
      onSubmit: async () => {
        await tryCode(code, (c) => verifyEmailCode(kind, address(), c));
        // The session is in. The router moves on when the stage changes.
        awaiting = "";
        awaitingSince = 0;
      },
      footer: note("It can take a minute, and it does sometimes land in spam."),
    })));
  return human.remove;
}

/**
 * Forgotten password: an address, then the code mailed to it.
 *
 * One screen in two steps rather than two routes, because the second step is
 * meaningless without the first and must not be reachable on its own. The
 * code signs this tab in, and `#/password` lets it choose a new password
 * without the old one -- see `arrivedByResetLink`.
 */
export function resetScreen(host: HTMLElement): () => void {
  const email = field("Email", { type: "email", required: true,
                                 autocomplete: "email" });
  // One widget per step: moving a widget's iframe to the next step's form
  // would reload it out from under Turnstile.
  const human = captcha();
  const widgets = [human];
  const back = () => note(link("Back to signing in", "#/login"));

  const askForCode = (address: string, sentAt: number) => {
    const code = codeField();
    const again = captcha();
    widgets.push(again);
    host.replaceChildren(card("Enter the code",
      // Worded so it does not say whether the address has an account.
      note("If ", el("strong", {}, address), " has an account, a code is on its way. ",
           // Starts the screen again rather than putting the first form back,
           // whose Turnstile iframe would reload under the widget.
           el("a", { href: "#", onclick: (e: Event) => {
             e.preventDefault();
             rerender();
           } }, "Change")),
      form({
        submit: "Continue",
        children: [code,
          codeClock(sentAt, async () => {
            await sendPasswordReset(address, await again.token());
          })],
        captcha: again.node,
        onSubmit: async () => {
          await tryCode(code, (c) => verifyEmailCode("recovery", address, c));
          // The session exists now, but the app's idea of the stage catches up
          // on its own time; `/password` would be refused while it still says
          // "out". Settle it first.
          await retryAuth();
          go("/password");
        },
        footer: back(),
      })));
    inputOf(code).focus();
  };

  const first = card("Reset your password",
    form({
      submit: "Send a code",
      children: [email],
      captcha: human.node,
      onSubmit: async () => {
        const address = inputOf(email).value.trim();
        await sendPasswordReset(address, await human.token());
        askForCode(address, Date.now());
      },
      footer: back(),
    }));
  host.append(first);
  return () => { for (const w of widgets) w.remove(); };
}

/**
 * Choose a new password without the old one -- for somebody who just entered
 * a reset code (or followed an older reset link), and nobody else.
 *
 * The route admits any signed-in session, because the stage cannot tell a
 * reset arrival from a tab that typed `#/password`. The session can: see
 * `arrivedByResetLink`. Anybody else is sent to Settings, which asks for the
 * current password first.
 */
export function passwordScreen(host: HTMLElement): void {
  if (!arrivedByResetLink()) {
    host.append(card("Choose a new password",
      note("This page is for finishing a password reset, and this session " +
           "did not come from one -- or came from one too long ago."),
      note(auth().stage === "in"
        ? link("Change your password in Settings", "#/settings")
        : link("Back to the game", "#/play"))));
    return;
  }
  const pw = field("New password", { type: "password", required: true,
                                     minlength: 8, autocomplete: "new-password" });
  const again = field("Repeat it", { type: "password", required: true,
                                     autocomplete: "new-password" });

  host.append(card("Choose a new password",
    form({
      submit: "Save it",
      children: [pw, again],
      onSubmit: async () => {
        if (inputOf(pw).value !== inputOf(again).value) {
          throw new Error("Those two passwords are not the same.");
        }
        // Asked again at submit, not only at render: a reset tab left open
        // past the window is no longer a reset tab.
        if (!arrivedByResetLink()) {
          throw new Error("This reset is too old now. Ask for a new code.");
        }
        // Every other session ends with the reset. If that part failed the
        // password is still changed, and staying on this screen to say so
        // would only hold up somebody who got what they came for.
        await setPassword(inputOf(pw).value);
        go("/play");
      },
    })));
}

/**
 * A session that has a second factor enrolled but has not answered it.
 *
 * Supabase issues the session at `aal1` regardless, so this screen is what
 * makes the factor mean anything: until it is answered the app shows nothing
 * else, and the database will not raise the assurance level on its own.
 */
export function unlockScreen(host: HTMLElement): void {
  const code = field("Six-digit code", {
    inputmode: "numeric", pattern: "[0-9]{6}", required: true,
    autocomplete: "one-time-code",
  });

  host.append(card("Two-factor code",
    note("From your authenticator app."),
    form({
      submit: "Unlock",
      children: [code],
      onSubmit: async () => {
        const factors = await listFactors();
        const verified = factors.find((f) => f.status === "verified");
        if (!verified) throw new Error("No authenticator is enrolled.");
        await verifyTotp(verified.id, inputOf(code).value.trim());
      },
      footer: el("p", { class: "note" },
        el("a", { href: "#", onclick: (e: Event) => {
          e.preventDefault();
          host.replaceChildren();
          recoveryScreen(host);
        } }, "Lost your authenticator?"),
        " · ",
        el("a", { href: "#", onclick: async (e: Event) => {
          e.preventDefault();
          await signOut();
        } }, "Sign out instead")),
    })));
}

/**
 * The way back in when the authenticator is gone.
 *
 * Says what it does before it does it. Redeeming a code turns two-factor off
 * rather than letting one session past it -- Supabase has no way to raise a
 * session to `aal2` without a factor challenge -- so somebody arriving here
 * upset should not discover afterwards that their account is now protected by
 * a password alone.
 */
function recoveryScreen(host: HTMLElement): void {
  const code = field("Recovery code", {
    required: true, autocomplete: "one-time-code",
    placeholder: "XXXXX-XXXXX",
  });

  host.append(card("Use a recovery code",
    note("One of the ten you were shown when you turned two-factor on. " +
         "Each works once."),
    note("Using one turns two-factor OFF for this account. You can turn it " +
         "on again from Settings straight afterwards, and you should."),
    form({
      submit: "Use it",
      children: [code],
      onSubmit: async () => {
        await redeemRecoveryCode(inputOf(code).value.trim().toUpperCase());
      },
      footer: el("p", { class: "note" },
        el("a", { href: "#", onclick: (e: Event) => {
          e.preventDefault();
          host.replaceChildren();
          unlockScreen(host);
        } }, "Back to the code from your app")),
    })));
}

/**
 * The last step: a name.
 *
 * It used to be the last GATE, and asked for an invite code beside the name --
 * both settled by `claim_username` in one statement, so a name two people
 * wanted at once and a code two people spent at once each resolved to one
 * winner. The code half is gone: this deployment is meant to be publicly
 * playable now, and a confirmed address is the whole of what is asked.
 *
 * The name half still races, and `claim_username` still settles it the same
 * way -- that was never the code's doing.
 */
export function usernameScreen(host: HTMLElement): void {
  const name = field("Username", {
    required: true, minlength: 3, maxlength: 20, autocomplete: "username",
    pattern: "[A-Za-z0-9](_?[A-Za-z0-9]){2,19}",
  });

  host.append(card("Pick a name",
    note("This is what a friend types to find you. 3 to 20 letters, digits " +
         "or underscores."),
    form({
      submit: "Claim it",
      children: [name],
      onSubmit: async () => {
        await claimUsername(inputOf(name).value.trim());
        rerender();
        go(home("in"));
      },
      footer: el("p", { class: "note" },
        el("a", { href: "#", onclick: async (e: Event) => {
          e.preventDefault();
          await signOut();
        } }, "Sign out")),
    })));
}

/**
 * The app could not find out where this account stands.
 *
 * Deliberately a dead end with two ways out rather than a guess. Both of the
 * questions the boot sequence asks -- is a second factor owed, is there a
 * profile -- used to answer their own failures with the permissive option: an
 * assurance-level lookup that errored meant "no second factor needed", and a
 * profile query that errored meant "no profile". The first let an outage walk
 * an enrolled account past its own code prompt. The second sent an established
 * player to the username form, where the only way forward is an invite code
 * they used months ago.
 *
 * So a failure is now its own state, and this is what it looks like: what went
 * wrong, a button to ask again, and the way out of an account that will not
 * load.
 */
export function troubleScreen(host: HTMLElement): void {
  const why = auth().problem ?? "Something went wrong while signing you in.";

  host.append(card("Just a moment",
    note(why),
    note("Nothing is wrong with your account as far as we can tell -- this is " +
         "the app being unable to ask. It is worth trying again."),
    form({
      submit: "Try again",
      children: [],
      onSubmit: async () => {
        const next = await retryAuth();
        if (next.stage === "unavailable") {
          throw new Error(next.problem ?? "Still no answer. Try again shortly.");
        }
      },
      footer: el("p", { class: "note" },
        el("a", { href: "#", onclick: async (e: Event) => {
          e.preventDefault();
          await signOut();
        } }, "Sign out")),
    })));
}

/**
 * "Sign in faster next time": one offer of a passkey, straight after a
 * sign-in that used something else.
 *
 * Skipped, without drawing anything, when there is nothing to offer: the
 * browser or project cannot do passkeys, the account already has one, or
 * this account said "Not now" in the last month. Both answers lead to the
 * game; neither is a gate.
 */
export function passkeyOfferScreen(host: HTMLElement): void {
  // Read before `takePasskeyOffer` spends it: pressed by name, the offer is
  // made even to an account that has a passkey on some other device.
  const asked = passkeyAskedFor();
  const wanted = takePasskeyOffer();
  // The offer is spent by now, so this is the game, or Support if that is
  // where the sign-in started.
  const onward = () => go(home("in"));
  void (async () => {
    const offer = wanted && await passkeysAvailable()
      && (asked || (await listPasskeys().catch(() => [null])).length === 0);
    if (!offer) { onward(); return; }
    host.append(card(asked ? "Create your passkey" : "Sign in faster next time",
      note("Save a passkey and sign in with your face, fingerprint or device " +
           "PIN. Nothing to type, nothing to remember, and nothing anybody " +
           "can steal from this game."),
      form({
        submit: "Save a passkey",
        children: [],
        onSubmit: async () => { if (await registerPasskey()) onward(); },
        footer: el("p", { class: "note" },
          el("a", { href: "#", onclick: (e: Event) => {
            e.preventDefault();
            declinePasskeyOffer();
            onward();
          } }, "Not now"),
          " · You can add one any time in Settings."),
      })));
  })();
}

/**
 * "Create a Passkey", from the sign-in screen: the whole way to one, for a
 * new account or an existing one, without knowing beforehand which you are.
 *
 * A passkey belongs to an account, so the address comes first: a code is
 * mailed (`sendEmailCode` with `create`, which signs an existing account in
 * and makes a new one), and once it is in, the passkey offer follows at once
 * -- for a new account, straight after its username. Behind the age screen
 * like Make an Account, because this can make one.
 */
export function createPasskeyScreen(host: HTMLElement): void | (() => void) {
  if (!ageCleared()) {
    host.append(card("Create a Passkey", ageGate(rerender),
      note("Already have one? ", link("Sign In", "#/login"))));
    return;
  }
  const email = field("Email", { type: "email", required: true, autocomplete: "email" });
  const human = captcha();
  host.append(card("Create a Passkey",
    note("A passkey signs you in with your face, fingerprint or device PIN. " +
         "We email you a code first, to make sure the address is yours, then " +
         "your device saves the passkey. New here or not, it's the same steps."),
    form({
      submit: "Email me a code",
      children: [email],
      captcha: human.node,
      onSubmit: async () => {
        const address = inputOf(email).value.trim();
        await sendEmailCode(address, true, await human.token());
        askForPasskey();
        awaiting = address;
        awaitingCreate = true;
        awaitingSince = Date.now();
        go("/verify");
      },
      footer: el("div", {}, agreement(), note("Rather use a password or Google? ", link("Sign In", "#/login"))),
    })));
  return human.remove;
}
