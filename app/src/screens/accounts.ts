/**
 * Getting in: sign up, verify, sign in, unlock, name yourself.
 *
 * Five screens rather than one, because they are five genuinely different
 * moments and folding them together is how people end up stuck without knowing
 * which part failed.
 */
import {
  auth, claimUsername, redeemRecoveryCode, resendVerification,
  sendPasswordReset, setPassword, signIn, signOut, signUp, listFactors,
  verifyTotp,
} from "../auth.js";
import { card, el, field, form, inputOf, link, note } from "../ui/dom.js";
import { go, rerender } from "../router.js";

export function signUpScreen(host: HTMLElement): void {
  const email = field("Email", { type: "email", required: true,
                                 autocomplete: "email" });
  const pw = field("Password", { type: "password", required: true,
                                 minlength: 8, autocomplete: "new-password" });
  const again = field("Repeat password", { type: "password", required: true,
                                           autocomplete: "new-password" });

  host.append(card("Make an account",
    note("You will need an invite code to finish. Ask whoever sent you here."),
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

export function loginScreen(host: HTMLElement): void {
  const email = field("Email", { type: "email", required: true,
                                 autocomplete: "email" });
  const pw = field("Password", { type: "password", required: true,
                                 autocomplete: "current-password" });

  host.append(card("Sign in",
    form({
      submit: "Sign in",
      children: [email, pw],
      onSubmit: async () => {
        await signIn(inputOf(email).value.trim(), inputOf(pw).value);
      },
      footer: el("p", { class: "note" },
        link("Make an account", "#/signup"), " · ",
        link("Forgot your password", "#/reset")),
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
    note("One of the ten you were given when you turned two-factor on. " +
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
 * The last gate: a username and an invite code, taken together.
 *
 * The database does both in one statement -- see `claim_username` -- so a name
 * two people want at once and a code two people spend at once both resolve to
 * exactly one winner.
 */
export function usernameScreen(host: HTMLElement): void {
  const name = field("Username", {
    required: true, minlength: 3, maxlength: 20, autocomplete: "username",
    pattern: "[A-Za-z0-9](_?[A-Za-z0-9]){2,19}",
  });
  const code = field("Invite code", { required: true, autocomplete: "off" });

  host.append(card("Pick a name",
    note("This is what a friend types to find you. 3 to 20 letters, digits " +
         "or underscores."),
    form({
      submit: "Claim it",
      children: [name, code],
      onSubmit: async () => {
        await claimUsername(inputOf(name).value.trim(),
                            inputOf(code).value.trim().toUpperCase());
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
