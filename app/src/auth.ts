/**
 * Who is signed in, and how far through the door they are.
 *
 * Getting in has five gates, and the app has to know which one somebody is
 * standing at before it can show them anything:
 *
 *   out         no session at all
 *   unverified  signed up, but the email link has not been followed
 *   locked      signed in, but a second factor is enrolled and unanswered
 *   nameless    verified, but has not picked a username yet
 *   in          has a profile, and can play
 *   unavailable the answer could not be obtained at all
 *
 * The gates are UI, not security. Every one of them is also enforced in the
 * database, and since migration 0013 that is true of the second factor as well:
 * a session at `aal1` on an account with a verified factor is refused by every
 * policy and every function, so bypassing this file reaches nothing. What is
 * here decides what to draw.
 *
 * ## Why "unavailable" is a stage
 *
 * Because every failure used to be reported as a benign answer. A failed
 * assurance-level lookup returned `false`, meaning "no second factor is owed",
 * so a Supabase incident let an enrolled account past the code prompt. A failed
 * profile query returned `null`, meaning "no profile", so the same incident
 * sent an established player back to the username form to pick a name they had
 * already chosen. Both are the wrong direction to fail in, and both were
 * indistinguishable from the truth.
 *
 * So the two questions the boot sequence asks now have three answers each, and
 * the third one is a screen that says so and offers to try again.
 */
import type { Session, User } from "@supabase/supabase-js";

/**
 * The Supabase client, downloaded the first time something needs it.
 *
 * It is 217 kB, a quarter of everything a visitor fetches, and most visitors
 * never use it: the landing page and guest play are signed out and talk to
 * nobody. So it is not imported until there is a session to read (see
 * `startAuth`) or somebody acts on an account -- signs in, signs up, types a
 * code. A failed download is forgotten, so the next attempt tries again.
 */
type Supabase = typeof import("./supabase.js");
let loaded: Promise<Supabase> | null = null;
function loadClient(): Promise<Supabase> {
  return loaded ??= import("./supabase.js").catch((e: unknown) => { loaded = null; throw e; });
}

/** Start downloading the client early, on a screen whose next step needs it. */
export function preloadAuth(): void {
  loadClient().catch(() => { /* the action that needs it reports the failure */ });
}

/**
 * Where supabase-js keeps this project's session: its own default name, pinned
 * in supabase.ts so the two cannot drift apart. Read here without the client,
 * which is how a visitor with no session is known to have none.
 */
export const SESSION_KEY = (() => {
  try { return `sb-${new URL(__SUPABASE_URL__).hostname.split(".")[0]}-auth-token`; } catch { return ""; }
})();

/**
 * Could the client find anybody signed in? Only if a session is stored, or the
 * address carries one back from an emailed link or Google (`?code=`,
 * `?token_hash=`, or `?error=` for a refusal). If storage cannot be read, the
 * answer is yes: loading the client for nothing costs a download, while a wrong
 * "no" would show a signed-in person the landing page.
 */
function mayBeSignedIn(): boolean {
  if (location.search) return true;
  try { return !SESSION_KEY || localStorage.getItem(SESSION_KEY) !== null; } catch { return true; }
}

/**
 * Read the session the client holds and hear every change to it from then on.
 *
 * Once per page, whenever the client is first wanted: at boot when somebody may
 * be signed in, otherwise on the first account action. Every action that can
 * change the session goes through `client()`, so the listener that turns a
 * sign-in into a new stage is always up before the sign-in happens.
 */
let listening: Promise<void> | null = null;
function listen(): Promise<void> {
  removeEventListener("storage", signedInElsewhere);
  return listening ??= (async () => {
    const { supabase } = await loadClient();
    await redeemTokenHash(supabase);
    const { data } = await supabase.auth.getSession();
    await refresh(data.session);
    supabase.auth.onAuthStateChange((_event, session) => { void refresh(session); });
  })().catch((e: unknown) => { listening = null; throw e; });
}

/** The client, listened to. For everything except `refresh`'s own lookups. */
async function client() {
  await listen();
  return (await loadClient()).supabase;
}

/**
 * Another tab signed in while this one had no client to hear it. The client's
 * own cross-tab channel only exists once it is loaded, so the session landing
 * in storage is the signal instead; the storage event fires only in OTHER tabs.
 */
function signedInElsewhere(e: StorageEvent): void {
  if (e.key === SESSION_KEY && e.newValue) void listen();
}

export interface Profile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export type Stage =
  "out" | "unverified" | "locked" | "nameless" | "in" | "unavailable";

export interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  stage: Stage;
  /** Why the stage is `unavailable`, for the screen that says so. */
  problem?: string;
}

let state: AuthState = { session: null, user: null, profile: null, stage: "out" };
const watchers = new Set<(s: AuthState) => void>();

export function auth(): AuthState { return state; }

export function onAuth(fn: (s: AuthState) => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function publish(next: AuthState): void {
  state = next;
  for (const fn of watchers) fn(state);
}

/**
 * Which refresh is the current one.
 *
 * `onAuthStateChange` fires for SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED and
 * SIGNED_OUT, and each one starts an async refresh that makes two round trips
 * before it publishes. Nothing sequenced them, so a slow SIGNED_IN could land
 * after a fast SIGNED_OUT and redraw the previous account's screens -- on a
 * shared machine, in front of the next person. Every refresh now carries the
 * number it was started with and publishes only if it is still the newest.
 */
let generation = 0;

type Answer<T> = { ok: true; value: T } | { ok: false; why: string };

/**
 * Whether a second factor is enrolled and still owed.
 *
 * Supabase models this as assurance levels: `aal1` is a password, `aal2` is a
 * password plus a factor. If the next level is above the current one, there is
 * a factor enrolled that this session has not answered.
 *
 * An error is an error rather than a `false`. See the note at the top.
 */
async function needsSecondFactor(): Promise<Answer<boolean>> {
  try {
    const { supabase } = await loadClient();
    const { data, error } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) return { ok: false, why: error.message };
    if (!data) return { ok: false, why: "no answer about your second factor" };
    return {
      ok: true,
      value: data.nextLevel === "aal2" && data.currentLevel !== "aal2",
    };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

async function fetchProfile(id: string): Promise<Answer<Profile | null>> {
  const { supabase } = await loadClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, display_name, avatar_url")
    .eq("id", id)
    .maybeSingle();
  // `maybeSingle` returns no error for no rows, so an error here is a real
  // one -- a failed request, or a policy that refused. "Refused" is not "you
  // have no profile", and sending an established player back to the username
  // form on the strength of it is the wrong way to be wrong.
  if (error) return { ok: false, why: error.message };
  return { ok: true, value: (data as Profile) ?? null };
}

/** Work out which gate the current session is standing at. */
export async function refresh(session: Session | null): Promise<AuthState> {
  const mine = ++generation;
  /** Publish, unless a newer refresh has started while this one was waiting. */
  const settle = (next: AuthState): AuthState => {
    if (mine !== generation) return state;
    publish(next);
    return state;
  };

  if (!session?.user) {
    return settle({ session: null, user: null, profile: null, stage: "out" });
  }
  const user = session.user;
  if (!user.email_confirmed_at) {
    return settle({ session, user, profile: null, stage: "unverified" });
  }

  const second = await needsSecondFactor();
  if (!second.ok) {
    return settle({
      session, user, profile: null, stage: "unavailable",
      problem: `Could not check this account's two-factor settings: ${second.why}`,
    });
  }
  if (second.value) {
    return settle({ session, user, profile: null, stage: "locked" });
  }

  const profile = await fetchProfile(user.id);
  if (!profile.ok) {
    return settle({
      session, user, profile: null, stage: "unavailable",
      problem: `Could not load your profile: ${profile.why}`,
    });
  }
  return settle({
    session, user, profile: profile.value,
    stage: profile.value ? "in" : "nameless",
  });
}

/** Ask again, with whatever session the client currently holds. */
export async function retryAuth(): Promise<AuthState> {
  const supabase = await client();
  const { data } = await supabase.auth.getSession();
  return refresh(data.session);
}

/**
 * Complete an emailed link that arrived as a token hash.
 *
 * Supabase's links come in two shapes. One is the legacy `?code=`, which the
 * client exchanges itself -- but only when THIS browser started the flow,
 * because PKCE needs the verifier it stored at the time. The other is
 * `?token_hash=&type=`, which carries everything needed and works from any
 * browser; it is what a link generated server-side produces, and what Supabase
 * now recommends email templates use.
 *
 * Supporting both costs ten lines and means a confirmation link works whether
 * it was opened on the phone that signed up or the laptop beside it -- which
 * is, in practice, what people do.
 */
async function redeemTokenHash(supabase: Supabase["supabase"]): Promise<void> {
  const params = new URLSearchParams(location.search);
  const token_hash = params.get("token_hash");
  const type = params.get("type");
  if (!token_hash || !LINK_TYPES.has(type ?? "")) return;
  // A link carries a whole session, so anybody can send one for THEIR account
  // and sign this browser into it. Keep the session that was here, and ask
  // before swapping when this browser did not ask for a link.
  const { data: before } = await supabase.auth.getSession();
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash, type: type as "signup" | "recovery" | "email_change",
  });
  if (error) { console.warn("that link could not be used:", error.message); return; }
  const user = data.session?.user;
  const prior = before.session;
  if (!user || (prior ? prior.user.id === user.id : askedForLink())) return;
  if (confirm(`This link signed you in as ${user.email ?? "another account"}. Keep using that account?`)) return;
  if (prior) await supabase.auth.setSession(prior);
  else await supabase.auth.signOut({ scope: "local" });
}

const LINK_TYPES = new Set(["signup", "recovery", "email_change"]);
const ASKED_KEY = "fbwg.emailLinkAsked";

/** Did this browser send an emailed link in the last day? */
function askedForLink(): boolean {
  try { return Date.now() - Number(localStorage.getItem(ASKED_KEY) ?? 0) < 86_400_000; } catch { return false; }
}

/**
 * Start listening. Resolves once the first state is known -- for a visitor with
 * no session, at once and without the client: the state is already `out`.
 */
export async function startAuth(): Promise<AuthState> {
  if (mayBeSignedIn()) await listen();
  else addEventListener("storage", signedInElsewhere);
  return state;
}

// ---- the actions the screens call ---------------------------------------

/** Supabase reports most failures as an error object rather than by throwing. */
function fail(error: { message: string; code?: string } | null): void {
  if (!error) return;
  // Supabase's own words here are "captcha protection: request disallowed".
  if (error.code === "captcha_failed") {
    throw new Error("Could not check that you are a person. Try again in a moment.");
  }
  throw new Error(error.message);
}

/**
 * Where an emailed link comes back to.
 *
 * The bare origin, with the reason as a QUERY parameter and never in the hash.
 * PKCE hands the session back as `?code=...`, which the client reads from
 * `location.search`: a redirect of `origin/#/verify` would arrive as
 * `origin/#/verify?code=...`, putting the code inside the fragment where
 * nothing looks for it, and the link would silently do nothing.
 *
 * The address also has to appear in the project's redirect allow-list, or
 * Supabase refuses to send it at all.
 */
function landing(intent?: string): string {
  try { localStorage.setItem(ASKED_KEY, String(Date.now())); } catch { /* the link asks first */ }
  return intent ? `${location.origin}/?intent=${intent}` : `${location.origin}/`;
}

/**
 * Mail a code that signs this address in -- and, when `create` is set, makes
 * the account first if there is none.
 *
 * This is how new accounts are made: an address and a code, no password.
 * The password was the one credential the server had to hash on every
 * attempt and the one people reuse, so new accounts never get one; they sign
 * in with a passkey, Google, or another code. (Settings can still ADD a
 * password, for somebody who wants one.)
 *
 * `create` is the sign-up form, behind the age screen. An address that
 * already has an account is simply sent a sign-in code, so the form says the
 * same thing either way and cannot be asked who plays here.
 *
 * Without `create` -- "Email me a code" on the sign-in form -- Supabase
 * refuses an unknown address with `otp_disabled`, which WOULD say who plays
 * here. That one refusal is swallowed, and the screen says "if it has an
 * account, a code is on its way", the reset form's wording.
 *
 * No session comes back. The code does that, through `verifyEmailCode`.
 */
export async function sendEmailCode(email: string, create: boolean,
                                    captchaToken?: string): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: create, emailRedirectTo: landing(), captchaToken },
  });
  if (!create && error?.code === "otp_disabled") return;
  fail(error);
}

/**
 * What an emailed code is for. Each kind is its own token on the server.
 * `email` is a code from `sendEmailCode`, which makes and signs in an account.
 */
export type CodeKind = "email" | "signup" | "recovery" | "email_change";

/**
 * Prove an inbox with the code from the email, in the tab that asked for it.
 *
 * The link this replaces only signed in the browser that started the sign-up,
 * because PKCE keeps its verifier there. Opened anywhere else -- a phone, the
 * mail app's own browser -- it confirmed the address and signed nobody in, and
 * the person was left on a Sign In form wondering why. A code is typed where
 * the person already is, so the session lands in this tab, on any device.
 *
 * It is no easier to guess than the link was: the link's token is a hash of
 * this same code and the address, which anyone who knows the address can
 * compute. Guessing is held back by the server's per-IP limit on verification
 * and by the code's length and expiry, all set in the dashboard.
 *
 * Every refusal reads the same, whether the code was wrong, expired, or the
 * address has no unfinished sign-up at all, so this cannot be used to ask who
 * has an account. The rate limit is the one failure worth naming, because it
 * changes what the person should do next.
 */
export async function verifyEmailCode(kind: CodeKind, email: string,
                                      code: string): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.verifyOtp({ email, token: code, type: kind });
  if (!error) {
    if (kind === "email" || kind === "signup" || kind === "recovery") offerPasskeyNext();
    return;
  }
  if (error.status === 429 || error.code === "over_request_rate_limit") {
    throw new Error("Too many tries. Wait a few minutes, then try again.");
  }
  // A network or server failure is not a wrong code, and saying it was would
  // send somebody back to their inbox for nothing.
  if (!error.status || error.status >= 500) fail(error);
  throw new Error("That code is wrong or has expired. Check the newest email, or send a new code.");
}

export async function signIn(email: string, password: string,
                             captchaToken?: string): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.signInWithPassword({
    email, password, options: { captchaToken },
  });
  fail(error);
  offerPasskeyNext();
}

/**
 * One button instead of a password and a trip to an inbox.
 *
 * The invite gate is NOT here. It is on `claim_username`, for the reason
 * `0004_invites.sql` gives at length: sign-up happens in the browser, so
 * anything the browser is asked to check first is not a check. So this lands in
 * exactly the `nameless` stage an email sign-up lands in, owing exactly the same
 * code, and adds no way past the gate -- which is why it needed no migration.
 *
 * Google reports the address as verified, so Supabase sets `email_confirmed_at`
 * and the `unverified` stage does not arise. Skipped, not bypassed: the same
 * field is being read, and it is genuinely set.
 *
 * There is nothing to await afterwards. This navigates away, and the session
 * comes back as `?code=` on the bare origin -- the same shape the emailed link
 * returns, exchanged by the same `detectSessionInUrl` at boot. See `landing`.
 */
export async function signInWithGoogle(): Promise<void> {
  const supabase = await client();
  offerPasskeyNext();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: landing() },
  });
  fail(error);
}

/**
 * Whether this account can be signed into with a password at all.
 *
 * An account that arrived through Google has no password, so the settings
 * screen's offer to CHANGE one is an offer it cannot keep: the change is proved
 * by signing in with the old password, and there is no old password to sign in
 * with. That row has to know which question it is asking.
 *
 * The obvious answer is `user.identities`, which is in the session already and
 * lists `email` for anyone who signed up with an address. It is wrong by one
 * case, and the case is the one this whole function exists for: setting a
 * password on a Google account does not add an email identity, so somebody who
 * sets one goes on looking passwordless forever. Only the database knows, which
 * is what `has_password` is for -- see the migration for the measurement behind
 * it.
 *
 * A failure is answered with `true`, and the direction is chosen. "Yes, there
 * is a password" shows the change form, which asks for the old one and refuses
 * without it; "no" shows a form that sets a password having proved nothing. If
 * this call cannot be trusted, the first is the harmless way to be wrong.
 */
export async function hasPassword(): Promise<boolean> {
  try {
    const supabase = await client();
    const { data, error } = await supabase.rpc("has_password");
    if (error || data === null || data === undefined) {
      // Includes the window where this release is live and the migration is
      // not: the function does not exist, the call errors, and the row falls
      // back to the identity list rather than to nothing.
      return (state.user?.identities ?? []).some((i) => i.provider === "email");
    }
    return data as boolean;
  } catch {
    return true;
  }
}

/**
 * Things to shut down before the session ends.
 *
 * The lobby holds a websocket and announces this account as online, so it has
 * to go before the sign-out -- leaving it running would leave a ghost in every
 * friend's list until the server timed the connection out. It registers itself
 * here rather than being imported, because the lobby needs `auth` and importing
 * it back would be a cycle: one the bundler warns about and resolves by giving
 * up on splitting the chunk.
 */
const closers = new Set<() => Promise<void>>();

export function onBeforeSignOut(fn: () => Promise<void>): void {
  closers.add(fn);
}

export async function signOut(): Promise<void> {
  const supabase = await client();
  for (const close of closers) {
    try {
      await close();
    } catch (e) {
      // A shutdown that fails must not trap somebody in a signed-in app.
      console.warn("could not shut down cleanly before signing out:", e);
    }
  }
  await supabase.auth.signOut();
  await refresh(null);
}

/**
 * Mail the confirmation code again, for a sign-up made with a password before
 * sign-ups stopped taking one: it has a session and an unconfirmed address.
 */
export async function resendVerification(email: string,
                                         captchaToken?: string): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.resend({
    type: "signup", email,
    options: { emailRedirectTo: landing(), captchaToken },
  });
  if (!error) return;
  // "Already confirmed" is swallowed for the same reason the sign-up screen
  // will not say "that address is taken": this button is reachable by somebody
  // who typed an address that already belongs to a finished account, and an
  // error saying so turns a resend button into a way to ask who plays here.
  // Every other failure -- the rate limit above all -- is worth reading.
  const said = `${error.code ?? ""} ${error.message}`.toLowerCase();
  if (said.includes("already confirmed") || said.includes("already been confirmed")) return;
  fail(error);
}

export async function sendPasswordReset(email: string,
                                        captchaToken?: string): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: landing("password"), captchaToken,
  });
  fail(error);
}

/** Mail both codes for a pending address change again. */
export async function resendEmailChange(newEmail: string,
                                        captchaToken?: string): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.resend({
    type: "email_change", email: newEmail, options: { captchaToken },
  });
  fail(error);
}

/**
 * Supabase wants the emailed code before it will change this password.
 *
 * With "Secure password change" on, a session more than a day old has to send
 * the nonce `sendReauthenticationCode` mails, even with the old password
 * proved. The screen catches this and asks for the code rather than showing
 * GoTrue's message.
 */
export class ReauthenticationNeeded extends Error {
  constructor() {
    super("For a session this old, Supabase needs the code we email you too.");
  }
}

/**
 * Set a new password, and end every other session on the account.
 *
 * `nonce` is the code `sendReauthenticationCode` mailed. Supabase checks it
 * only with "Secure password change" on and only for a session over a day
 * old; for anything younger it is the screen's proof, not the server's.
 *
 * The other sessions go because a password change is what somebody does when
 * they think somebody else has it. Answers whether that worked, so the screen
 * never claims it did when it did not.
 */
export async function setPassword(password: string, nonce?: string,
                                  current?: string): Promise<boolean> {
  const supabase = await client();
  const { error } = await supabase.auth.updateUser({
    password,
    ...(nonce ? { nonce } : {}),
    ...(current !== undefined ? { current_password: current } : {}),
  });
  // Every code below measured against GoTrue v2.197 with its setting on.
  const code = (error as { code?: string } | null)?.code;
  if (code === "reauthentication_needed") throw new ReauthenticationNeeded();
  if (code === "reauthentication_not_valid") {
    throw new Error("That code is wrong or has expired. Ask for a new one.");
  }
  if (code === "current_password_invalid" || code === "current_password_required") {
    throw new Error("that is not your current password");
  }
  fail(error);
  return signOutOtherDevices();
}

/** Mail a six-digit code that proves the person at the keyboard has the inbox. */
export async function sendReauthenticationCode(): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.reauthenticate();
  fail(error);
}

/**
 * Prove a password by USING it, on a client that is thrown away afterwards.
 *
 * Supabase does not ask for the old password: `updateUser` will happily take a
 * session's word for it. That is fine for the emailed reset link, where the
 * mail was the proof -- and not fine for a signed-in change, where the proof
 * would be a tab somebody left open.
 *
 * It used to sign in on the app's own client, which REPLACED this tab's
 * session with the one the proof made -- for an account with a second factor,
 * an `aal1` session in place of the `aal2` one, so the change that followed
 * went out under a session Supabase refuses for exactly this. The scratch
 * client keeps the proof out of the way, and its session is revoked at once
 * rather than left alive on the server.
 */
async function proveCurrentPassword(current: string,
                                   captchaToken?: string): Promise<void> {
  const email = state.user?.email;
  if (!email) throw new Error("not signed in");
  await listen();
  const scratch = (await loadClient()).scratchClient();
  const { error } = await scratch.auth.signInWithPassword({
    email, password: current, options: { captchaToken },
  });
  if (error) throw new Error("that is not your current password");
  // `local` still revokes the scratch session on the server; it only spares
  // this tab's. `signOut` reports failure in its result, not by throwing, so
  // the result is what gets read -- and retried once, since a live session
  // nobody holds is exactly what this was written to avoid leaving behind.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error: out } = await scratch.auth.signOut({ scope: "local" })
      .catch((e: Error) => ({ error: e }));
    if (!out) return;
    console.warn("could not end the password-check session:", out.message);
  }
}

/**
 * Change the password of an account that is already signed in.
 *
 * The old password goes to Supabase as `current_password` as well as being
 * proved here. With "Require current password when updating" on, GoTrue
 * checks it itself -- the only version of this check a stolen session token
 * cannot skip, since a token can call `updateUser` without this page. GoTrue
 * exempts recovery sessions (`otp`, `magiclink`, `recovery`), which is what
 * keeps the emailed reset link working, and accounts with no password, which
 * is what keeps Google-only accounts able to add one.
 */
export async function changePassword(current: string, next: string,
                                     nonce?: string,
                                     captchaToken?: string): Promise<boolean> {
  await proveCurrentPassword(current, captchaToken);
  return setPassword(next, nonce, current);
}

/**
 * Ask to move the account to a different address.
 *
 * The address is where password resets go, so moving it moves the account.
 * When the account has a password, it is proved first, the same way
 * `changePassword` proves it. An account that only signs in with Google has
 * none to prove; for it, and for any request made outside this screen, the
 * guard is Supabase's "Secure email change", which makes the OLD address
 * confirm as well.
 *
 * Nothing changes until the emailed codes are entered -- one from each
 * address, with "Secure email change" on -- so this returns having sent
 * something, not having done something.
 */
export async function changeEmail(email: string, current: string | null,
                                  captchaToken?: string): Promise<void> {
  const supabase = await client();
  if (current !== null) await proveCurrentPassword(current, captchaToken);
  const { error } = await supabase.auth.updateUser(
    { email }, { emailRedirectTo: landing("email") });
  fail(error);
}

/**
 * End every session on this account except this one, and say whether it did.
 *
 * Never throws: the change it follows has already happened, and failing to
 * tidy up after it must not report the change itself as failed. But it
 * answers, so the screen can say "other devices are still signed in" instead
 * of a reassurance that is not true.
 */
export async function signOutOtherDevices(): Promise<boolean> {
  try {
    const supabase = await client();
    const { error } = await supabase.auth.signOut({ scope: "others" });
    if (error) console.warn("could not sign out other sessions:", error.message);
    return !error;
  } catch (e) {
    console.warn("could not sign out other sessions:", (e as Error).message);
    return false;
  }
}

/**
 * Did this session come from an emailed link, a few minutes ago?
 *
 * `#/password` sets a new password without asking for the old one, which is
 * right for somebody who just followed a reset link -- the mail was the proof
 * -- and wrong for any other signed-in tab, which could simply navigate there.
 * The session says how it was made: a password sign-in carries `amr` method
 * `password`, Google carries `oauth`, and a link carries `otp` (measured
 * against the live project) or, on some flows, `recovery`. The timestamp
 * bounds it, so a reset session left open later does not stay a reset session.
 */
export function arrivedByResetLink(withinMs = 15 * 60 * 1000): boolean {
  const token = state.session?.access_token;
  if (!token) return false;
  // A confirmation or address-change link also signs in with `otp`. Only a
  // reset sets `recovery_sent_at`, so the reset has to be recent as well.
  const asked = Date.parse(state.user?.recovery_sent_at ?? "");
  if (!(Date.now() - asked < 60 * 60 * 1000)) return false;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]
      .replace(/-/g, "+").replace(/_/g, "/")));
    const amr = (payload.amr ?? []) as { method?: string; timestamp?: number }[];
    return amr.some((m) => (m.method === "otp" || m.method === "recovery")
      && typeof m.timestamp === "number"
      && Date.now() - m.timestamp * 1000 < withinMs);
  } catch {
    return false;
  }
}

/**
 * Delete this account and everything that hangs off it.
 *
 * `delete_me` is a security-definer function rather than an admin call,
 * because the admin API needs the secret key and this deployment is static
 * with nowhere to keep one. Everything else is a cascade: the profile, the
 * friendships, the progress each pair earned together.
 *
 * The sign-out afterwards is not tidying. The session's token stays valid for
 * its lifetime and would otherwise keep a signed-in-looking app in front of an
 * account that no longer exists.
 */
export async function deleteAccount(): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.rpc("delete_me");
  fail(error);
  await signOut();
}

/**
 * Claim a username.
 *
 * One argument, and it is worth knowing why that took two releases. PostgREST
 * picks an overload by ARGUMENT NAME, so a client sending `invite_code` needs a
 * function that declares one; dropping the two-argument version while anything
 * still sent it would have meant a 404 and nobody able to claim a name at all.
 *
 * So this stopped sending the second argument first, and
 * `20260911000000_drop_the_invite_machinery` removed the signature only once
 * this half was live -- confirmed by polling the deployed bundle until the
 * string was gone from it, rather than by looking at `main`. Both halves have
 * shipped; the sequence is recorded because the next contracting change to an
 * RPC has to follow it.
 */
export async function claimUsername(username: string): Promise<Profile> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("claim_username", {
    new_username: username,
  });
  fail(error);
  // A taken name is a row of nulls since `20261005040000_username_probe_budget`
  // -- a raise would roll back the attempt it had just been charged for -- and
  // a raised 23505 before it. Both are read, so neither order of deploy and
  // migration shows anybody an empty profile.
  if (!data || !(data as Profile).id) throw new Error("that username is taken");
  const profile = data as Profile;
  publish({ ...state, profile, stage: "in" });
  return profile;
}

// ---- second factor -------------------------------------------------------

export interface Enrolment {
  factorId: string;
  /** An SVG QR code for an authenticator app. */
  qr: string;
  /** The same secret in text, for typing in by hand. */
  secret: string;
}

export async function listFactors() {
  const supabase = await client();
  const { data, error } = await supabase.auth.mfa.listFactors();
  fail(error);
  return data?.totp ?? [];
}

export async function enrolTotp(): Promise<Enrolment> {
  const supabase = await client();
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `authenticator-${Date.now()}`,
  });
  fail(error);
  return {
    factorId: data!.id,
    qr: data!.totp.qr_code,
    secret: data!.totp.secret,
  };
}

/**
 * Answer a factor: used both to finish enrolling one and to unlock a session
 * that already has one. Supabase treats the two the same -- challenge, then
 * verify -- which is why one function serves both.
 */
export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const supabase = await client();
  const { data: challenge, error: cErr } =
    await supabase.auth.mfa.challenge({ factorId });
  fail(cErr);
  const { error } = await supabase.auth.mfa.verify({
    factorId, challengeId: challenge!.id, code,
  });
  fail(error);
  const { data } = await supabase.auth.getSession();
  await refresh(data.session);
}

/**
 * Ten single-use codes, handed back exactly once.
 *
 * Any unused codes from a previous set are dropped by the database, so this is
 * "these are your codes now" rather than "here are some more" -- two live sets
 * would mean one somebody wrote down a year ago still works.
 */
export async function generateRecoveryCodes(): Promise<string[]> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("generate_recovery_codes");
  fail(error);
  return (data as string[]) ?? [];
}

export async function recoveryCodesLeft(): Promise<number> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("recovery_codes_left");
  fail(error);
  return (data as number) ?? 0;
}

/**
 * Spend a code, which turns two-factor off.
 *
 * Not "let me past this once", because Supabase cannot express that: the second
 * factor is an assurance level and a session reaches `aal2` only by answering a
 * challenge. So recovery means unenrolling, and every screen that offers this
 * says so before the button.
 *
 * `refresh` afterwards is what moves the stage: with no factor enrolled,
 * `needsSecondFactor` is false and `locked` becomes `in`.
 */
export async function redeemRecoveryCode(code: string): Promise<void> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("redeem_recovery_code", { code });
  fail(error);
  if (data !== true) throw new Error("that is not one of your recovery codes");
  // The factor is gone from the database and still in this browser's copy of
  // the session, which is what `getAuthenticatorAssuranceLevel` reads to decide
  // whether a second factor is owed. Without a new token the stage stays
  // `locked` and the person who just used their last resort is left looking at
  // the screen that asked for it.
  const { data: fresh } = await supabase.auth.refreshSession();
  await refresh(fresh?.session ?? state.session);
  // The database already ended them (`20261005010000`); this says so again
  // from the client in case it is talking to a schema that has not.
  await signOutOtherDevices();
}

export async function unenrolTotp(factorId: string): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  fail(error);
}

// ---- passkeys ------------------------------------------------------------

/**
 * Can this browser and this project use passkeys at all?
 *
 * Both halves are asked. The browser needs WebAuthn; the project needs
 * Passkeys switched on in the dashboard, which `/auth/v1/settings` reports as
 * `passkeys_enabled`. Asked with a plain fetch, so a signed-out visitor on the
 * sign-in form does not download the client to find out. Once per page, and a
 * failure is a "no": a button that cannot work is worse than no button.
 */
let available: Promise<boolean> | null = null;
export function passkeysAvailable(): Promise<boolean> {
  return available ??= (async () => {
    if (typeof PublicKeyCredential !== "function") return false;
    try {
      const response = await fetch(`${__SUPABASE_URL__}/auth/v1/settings`,
                                   { headers: { apikey: __SUPABASE_KEY__ } });
      return response.ok && (await response.json()).passkeys_enabled === true;
    } catch {
      return false;
    }
  })();
}

/**
 * Whether the browser's sheet was closed rather than something failing.
 *
 * Every browser reports "the person said no" and "it timed out" as the same
 * `NotAllowedError`, on purpose, so a page cannot tell which. Neither is worth
 * an error message: the button is still there.
 */
function dismissed(error: { code?: string; cause?: unknown } | null): boolean {
  const cause = error?.cause as { name?: string } | undefined;
  return error?.code === "ERROR_CEREMONY_ABORTED" || cause?.name === "NotAllowedError"
    || cause?.name === "AbortError";
}

/** Supabase's passkey refusals, in the words the screens use. */
function passkeyFail(error: { message: string; code?: string } | null): void {
  if (!error) return;
  if (error.code === "webauthn_verification_failed" || error.code === "passkey_not_found") {
    throw new Error("That passkey is not one this game knows. It may have been removed from your account.");
  }
  if (error.code === "webauthn_challenge_expired") {
    throw new Error("That took too long. Try again.");
  }
  if (error.code === "too_many_passkeys") {
    throw new Error("This account has as many passkeys as it can hold. Remove one in Settings first.");
  }
  fail(error);
}

/**
 * Sign in with a passkey from this device, or a phone held up to it.
 *
 * No address first: the passkey says which account it belongs to. The
 * challenge is guarded by Turnstile like a password sign-in, but what comes
 * back is a signature, checked in microseconds, with nothing to guess.
 *
 * Resolves `false` when the person closed the browser's sheet.
 */
export async function signInWithPasskey(captchaToken?: string): Promise<boolean> {
  stopAutofill();
  const supabase = await client();
  const { error } = await supabase.auth.signInWithPasskey({ options: { captchaToken } });
  if (dismissed(error as { code?: string; cause?: unknown } | null)) return false;
  passkeyFail(error);
  rememberPasskeyHere();
  return true;
}

/**
 * Whether this device has made or used a passkey for this site.
 *
 * The closest a page can come to "does this person have a passkey": browsers
 * will not say, on purpose, so a site cannot test visitors for accounts. It
 * decides only whether to explain, after the browser's sheet comes back
 * empty, how a passkey gets made -- so it can be wrong without harm.
 */
const PASSKEY_HERE = "fbwg.passkeyHere";

export function passkeyUsedHere(): boolean {
  try { return localStorage.getItem(PASSKEY_HERE) === "1"; } catch { return false; }
}

function rememberPasskeyHere(): void {
  try { localStorage.setItem(PASSKEY_HERE, "1"); } catch { /* the hint shows again, that is all */ }
}

/** The native JSON helpers that conditional mediation is built on. */
type ParseRequest = { parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions };
type ToJSON = { toJSON?: () => unknown };

/** Can the browser offer passkeys in a field's autofill list? */
async function autofillSupported(): Promise<boolean> {
  if (typeof PublicKeyCredential !== "function") return false;
  if (typeof (PublicKeyCredential as unknown as ParseRequest).parseRequestOptionsFromJSON !== "function") return false;
  try { return await PublicKeyCredential.isConditionalMediationAvailable?.() === true; }
  catch { return false; }
}

let autofill: AbortController | null = null;

/** Withdraw the passkeys from the autofill list, before anything else asks. */
export function stopAutofill(): void {
  autofill?.abort();
  autofill = null;
}

/**
 * Offer this site's passkeys in the email field's autofill list.
 *
 * "Conditional mediation": the request waits silently, and the browser lists
 * passkeys beside saved addresses when somebody focuses a field marked
 * `autocomplete="... webauthn"`. Picking one signs in, with no button.
 *
 * Built on the two-step calls, because the one-step one always opens the
 * full sheet. Only one WebAuthn request can be pending, so this one is
 * aborted whenever the button asks (`stopAutofill`) and started again after.
 *
 * Supabase's challenge lives five minutes. A passkey picked after that is
 * refused as expired, and the request starts over with a new one, so the
 * next pick works; the caller hears about it to say so.
 */
export async function startAutofill(token: () => Promise<string | undefined>,
                                    expired: () => void,
                                    screen: AbortSignal): Promise<void> {
  if (!(await autofillSupported()) || !(await passkeysAvailable())) return;
  // The screen may have gone while the checks above were out; a request
  // started now would outlive it, still waiting on a field that is gone.
  if (screen.aborted) return;
  stopAutofill();
  const mine = new AbortController();
  autofill = mine;
  screen.addEventListener("abort", () => mine.abort(), { once: true });
  const supabase = await client();
  while (!mine.signal.aborted) {
    const { data, error } = await supabase.auth.passkey.startAuthentication(
      { options: { captchaToken: await token() } });
    if (mine.signal.aborted) return;
    // A refused challenge is not worth a message on a form the person has not
    // touched yet; the button still works.
    if (error || !data) { console.warn("passkey autofill unavailable:", error?.message); return; }
    const publicKey = (PublicKeyCredential as unknown as Required<ParseRequest>)
      .parseRequestOptionsFromJSON(data.options);
    let credential: Credential | null;
    try {
      credential = await navigator.credentials.get(
        { publicKey, mediation: "conditional", signal: mine.signal } as CredentialRequestOptions);
    } catch {
      return; // aborted, or the browser gave up on the request
    }
    if (!credential || mine.signal.aborted) return;
    const { error: verify } = await supabase.auth.passkey.verifyAuthentication({
      challengeId: data.challenge_id,
      credential: (credential as unknown as Required<ToJSON>).toJSON() as never,
    });
    if (!verify) { rememberPasskeyHere(); return; }
    if (verify.code !== "webauthn_challenge_expired") passkeyFail(verify);
    expired();
  }
}

export interface Passkey { id: string; name: string; created: string; lastUsed?: string }

export async function listPasskeys(): Promise<Passkey[]> {
  const supabase = await client();
  const { data, error } = await supabase.auth.passkey.list();
  fail(error);
  return (data ?? []).map((p) => ({ id: p.id, name: p.friendly_name || "Passkey",
                                    created: p.created_at, lastUsed: p.last_used_at }));
}

/**
 * Make a passkey for the signed-in account, on this device or a phone.
 * Resolves `false` when the person closed the browser's sheet.
 */
export async function registerPasskey(): Promise<boolean> {
  stopAutofill();
  const supabase = await client();
  const { error } = await supabase.auth.registerPasskey();
  if (error?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
    throw new Error("This device already has a passkey for this account.");
  }
  if (dismissed(error as { code?: string; cause?: unknown } | null)) return false;
  passkeyFail(error);
  rememberPasskeyHere();
  return true;
}

export async function deletePasskey(id: string): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.passkey.delete({ passkeyId: id });
  fail(error);
}

/**
 * Offering a passkey, once, right after a sign-in that used something else.
 *
 * That moment is when people make them: the sign-in they just finished is
 * fresh, and the offer is one press. Set by the password, Google and emailed
 * code sign-ins (in this tab's sessionStorage, so it survives Google's
 * redirect), read by the router, spent by the screen that makes the offer.
 * "Not now" is remembered per account for a month, so it is not asked again
 * at every sign-in.
 */
const OFFER_KEY = "fbwg.offerPasskey";
const DECLINED_KEY = "fbwg.passkeyDeclined:";

function offerPasskeyNext(): void {
  try { sessionStorage.setItem(OFFER_KEY, "1"); } catch { /* no offer, nothing lost */ }
}

export function passkeyOfferPending(): boolean {
  try { return sessionStorage.getItem(OFFER_KEY) === "1"; } catch { return false; }
}

/**
 * "Create a Passkey" was pressed: the offer comes after the emailed code even
 * for an account that said "Not now" before, or already has one elsewhere.
 */
const ASKED_KEY_PASSKEY = "fbwg.passkeyAsked";

export function askForPasskey(): void {
  try { sessionStorage.setItem(ASKED_KEY_PASSKEY, "1"); } catch { /* offered as usual */ }
}

/** Whether the offer was asked for by name, and not just due. */
export function passkeyAskedFor(): boolean {
  try { return sessionStorage.getItem(ASKED_KEY_PASSKEY) === "1"; } catch { return false; }
}

/** Spend the offer, and say whether this account still wants to hear it. */
export function takePasskeyOffer(): boolean {
  try {
    sessionStorage.removeItem(OFFER_KEY);
    if (passkeyAskedFor()) { sessionStorage.removeItem(ASKED_KEY_PASSKEY); return true; }
    const declined = Number(localStorage.getItem(DECLINED_KEY + state.user?.id) ?? 0);
    return Date.now() - declined > 30 * 86_400_000;
  } catch {
    return false;
  }
}

export function declinePasskeyOffer(): void {
  try { localStorage.setItem(DECLINED_KEY + state.user?.id, String(Date.now())); } catch { /* asked again next time */ }
}

/**
 * Where to go once signed in, when it is not the game: a Sign In pressed on
 * the Support page should come back to Support. One slot, this tab only.
 */
const RETURN_KEY = "fbwg.afterSignIn";

export function returnAfterSignIn(path: string): void {
  try { sessionStorage.setItem(RETURN_KEY, path); } catch { /* lands in the game instead */ }
}

export function pendingReturn(): string | null {
  try { return sessionStorage.getItem(RETURN_KEY); } catch { return null; }
}

export function clearReturn(): void {
  try { sessionStorage.removeItem(RETURN_KEY); } catch { /* nothing to clear */ }
}
