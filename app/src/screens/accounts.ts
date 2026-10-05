/**
 * Getting in: sign up, verify, sign in, unlock, name yourself.
 *
 * Five screens rather than one, because they are five genuinely different
 * moments and folding them together is how people end up stuck without knowing
 * which part failed.
 */
import {
  arrivedByResetLink, auth, claimUsername, redeemRecoveryCode,
  resendVerification, retryAuth,
  sendPasswordReset, setPassword, signIn, signInWithGoogle, signOut, signUp,
  listFactors, verifyTotp,
} from "../auth.js";
import {
  card, el, field, form, googleButton, inputOf, link, note, orDivider,
} from "../ui/dom.js";
import { go, rerender } from "../router.js";

export function signUpScreen(host: HTMLElement): void {
  const email = field("Email", { type: "email", required: true,
                                 autocomplete: "email" });
  const pw = field("Password", { type: "password", required: true,
                                 minlength: 8, autocomplete: "new-password" });
  const again = field("Repeat password", { type: "password", required: true,
                                           autocomplete: "new-password" });

  host.append(card("Make an Account",
    googleButton(signInWithGoogle),
    orDivider(),
    form({
      submit: "Sign Up",
      children: [email, pw, again],
      onSubmit: async () => {
        if (inputOf(pw).value !== inputOf(again).value) {
          throw new Error("Those two passwords are not the same.");
        }
        if (inputOf(pw).value.length < 8) {
          throw new Error("Use at least 8 characters.");
        }
        const address = inputOf(email).value.trim();
        const { existing } = await signUp(address, inputOf(pw).value);
        awaiting = address;
        awaitingExisting = existing;
        go("/verify");
      },
      footer: note("Already have one? ", link("Sign In", "#/login")),
    })));
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

export function loginScreen(host: HTMLElement): void {
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
  const forgot = el("p", { class: "field-aside" },
    link("Forgot password?", "#/reset"));

  host.append(card("Sign In",
    refused,
    googleButton(signInWithGoogle),
    orDivider(),
    form({
      submit: "Sign In",
      children: [email, pw, forgot],
      onSubmit: async () => {
        await signIn(inputOf(email).value.trim(), inputOf(pw).value);
      },
      // Below a rule, because this is where the screen stops being about
      // signing in. Somebody with no account cannot use anything above it, and
      // a line of grey text was a poor way to say so.
      footer: el("div", { class: "after-form" },
        el("a", { class: "secondary", href: "#/signup" }, "Make an Account")),
    })));
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
/** Whether that address turned out to already have an account. */
let awaitingExisting = false;

export function verifyScreen(host: HTMLElement): void {
  const address = awaiting || auth().user?.email || "";
  const existing = awaitingExisting;

  host.append(card("Check your email",
    note(address
      ? `A link is on its way to ${address}. Follow it and you are in.`
      : "A link is on its way. Follow it and you are in."),
    note("It can take a minute, and it does sometimes land in spam."),
    // The one sentence that serves both people without telling either about
    // the other.
    //
    // Supabase deliberately will not say "that address is taken" -- see
    // `signUp` -- so neither will this. But somebody who already has an account
    // is standing here waiting for mail that is never coming, and the only
    // thing that helps them is the door they actually need. Saying it to
    // everybody costs the genuinely new person one line of text and costs the
    // returning person nothing at all.
    existing
      ? note("Already had an account with that address? Nothing will arrive — ",
             link("sign in instead", "#/login"),
             ", including with Google if that is how you made it.")
      : null,
    form({
      submit: "Send it again",
      children: [],
      onSubmit: async () => {
        if (!address) throw new Error("No address to send to. Start again.");
        await resendVerification(address);
      },
      footer: el("p", { class: "note" },
        el("a", { href: "#", onclick: async (e: Event) => {
          e.preventDefault();
          awaiting = "";
          awaitingExisting = false;
          // Signing out matters only when there IS a session; after a plain
          // sign-up there is none, and this is simply the way back.
          if (auth().session) await signOut(); else go("/signup");
        } }, "Use a different address")),
    })));
}

export function resetScreen(host: HTMLElement): void {
  const email = field("Email", { type: "email", required: true,
                                 autocomplete: "email" });
  const sent = note("If that address has an account, a reset link is on its way.");
  sent.hidden = true;

  host.append(card("Reset your password",
    form({
      submit: "Send a link",
      children: [email, sent],
      onSubmit: async () => {
        await sendPasswordReset(inputOf(email).value.trim());
        sent.hidden = false;
      },
      footer: note(link("Back to signing in", "#/login")),
    })));
}

/**
 * Choose a new password without the old one -- for somebody who just followed
 * a reset link, and nobody else.
 *
 * The route admits any signed-in session, because the stage cannot tell a
 * reset arrival from a tab that typed `#/password`. The session can: see
 * `arrivedByResetLink`. Anybody else is sent to Settings, which asks for the
 * current password first.
 */
export function passwordScreen(host: HTMLElement): void {
  if (!arrivedByResetLink()) {
    host.append(card("Choose a new password",
      note("This page is for the link in a password-reset email, and this " +
           "session did not arrive from one -- or arrived too long ago."),
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
        go("/play");
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
