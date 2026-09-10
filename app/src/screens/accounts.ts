/**
 * Getting in: sign up, verify, sign in, unlock, name yourself.
 *
 * Five screens rather than one, because they are five genuinely different
 * moments and folding them together is how people end up stuck without knowing
 * which part failed.
 */
import {
  auth, claimUsername, redeemRecoveryCode, resendVerification, retryAuth,
  sendPasswordReset, sendSignInLink, setPassword, signIn, signInWithGoogle,
  signOut, signUp, listFactors, verifyTotp, wasInvited,
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

  // The invite note sits ABOVE the Google button, not under the form. Google is
  // now the shortest way off this screen, and somebody who takes it before
  // reading to the bottom would meet a demand for a code nobody warned them
  // about -- on a screen they can no longer go back to.
  host.append(card("Make an account",
    note("You will need an invite code to finish, whichever way you sign up. " +
         "Ask whoever sent you here."),
    googleButton(signInWithGoogle),
    orDivider(),
    form({
      submit: "Sign up",
      children: [email, pw, again],
      onSubmit: async () => {
        if (inputOf(pw).value !== inputOf(again).value) {
          throw new Error("Those two passwords are not the same.");
        }
        if (inputOf(pw).value.length < 8) {
          throw new Error("Use at least 8 characters.");
        }
        await signUp(inputOf(email).value.trim(), inputOf(pw).value);
        go("/verify");
      },
      footer: note("Already have one? ", link("Sign in", "#/login")),
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

  host.append(card("Sign in",
    refused,
    googleButton(signInWithGoogle),
    orDivider(),
    form({
      submit: "Sign in",
      children: [email, pw],
      onSubmit: async () => {
        await signIn(inputOf(email).value.trim(), inputOf(pw).value);
      },
      footer: el("p", { class: "note" },
        link("Make an account", "#/signup"), " · ",
        link("Forgot your password", "#/reset"), el("br"),
        link("Email me a sign-in link", "#/link")),
    })));
}

/**
 * A way back in for somebody who was invited and lost the link.
 *
 * An invitation is a single email, and emails expire, go to spam, and get
 * opened on the wrong device. Without this the only way back is asking to be
 * invited again by hand, which is the thing invitations were meant to stop.
 *
 * Nobody NEW can get in through here: `sendSignInLink` refuses to create
 * accounts, so an address that has never been invited receives nothing at all.
 *
 * Which is exactly why this screen says the same sentence either way. The
 * message below is not politeness -- it is the difference between a button that
 * helps an invited person and a button that answers "is this address a member
 * of this game?" for anybody who asks. `resetScreen` above says the same thing
 * for the same reason.
 */
export function linkScreen(host: HTMLElement): void {
  const email = field("Email", { type: "email", required: true,
                                 autocomplete: "email" });
  const sent = note("If that address has an account, a sign-in link is on its " +
                    "way. The link works once and lasts an hour.");
  sent.hidden = true;

  host.append(card("Email me a sign-in link",
    note("For an invitation that expired, or a link opened on the wrong " +
         "device. No password needed."),
    form({
      submit: "Send a link",
      children: [email, sent],
      onSubmit: async () => {
        await sendSignInLink(inputOf(email).value.trim());
        sent.hidden = false;
      },
      footer: note(link("Back to signing in", "#/login")),
    })));
}

export function verifyScreen(host: HTMLElement): void {
  const address = auth().user?.email ?? "your address";
  host.append(card("Check your email",
    note(`A link is on its way to ${address}. Follow it and you are in.`),
    note("Nothing arrived? It can take a minute, and it does sometimes land " +
         "in spam."),
    form({
      submit: "Send it again",
      children: [],
      onSubmit: async () => {
        const email = auth().user?.email;
        if (!email) throw new Error("No address to send to. Sign in again.");
        await resendVerification(email);
      },
      footer: el("p", { class: "note" },
        el("a", { href: "#", onclick: async (e: Event) => {
          e.preventDefault();
          await signOut();
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

export function passwordScreen(host: HTMLElement): void {
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
 * The last gate: a username, and an invite code unless one was not needed.
 *
 * The database does both in one statement -- see `claim_username` -- so a name
 * two people want at once and a code two people spend at once both resolve to
 * exactly one winner.
 *
 * The code field is taken AWAY from somebody who was invited, rather than being
 * added for somebody who was not. Those are not the same: `wasInvited` is asked
 * over the network, and starting hidden would mean a lookup that never comes
 * back leaves a person holding a perfectly good code with nowhere to type it.
 * Starting visible, the same failure costs an invited person a field they can
 * ignore. The price is a brief flash of a box that then goes away, which is the
 * cheaper of the two.
 *
 * It is also NOT `required` any more. An invited person whose lookup failed
 * sees the field, has nothing to put in it, and can still submit -- and the
 * database, which reads the same column itself and does not depend on this
 * request having succeeded, lets them through.
 */
export function usernameScreen(host: HTMLElement): void {
  const name = field("Username", {
    required: true, minlength: 3, maxlength: 20, autocomplete: "username",
    pattern: "[A-Za-z0-9](_?[A-Za-z0-9]){2,19}",
  });
  const code = field("Invite code", { autocomplete: "off" });
  void wasInvited().then((invited) => { code.hidden = invited; });

  host.append(card("Pick a name",
    note("This is what a friend types to find you. 3 to 20 letters, digits " +
         "or underscores."),
    form({
      submit: "Claim it",
      children: [name, code],
      onSubmit: async () => {
        const typed = inputOf(code).value.trim().toUpperCase();
        await claimUsername(inputOf(name).value.trim(), typed || null);
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
