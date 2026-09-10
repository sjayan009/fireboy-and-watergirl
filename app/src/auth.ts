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
import { supabase } from "./supabase.js";
import type { Session, User } from "@supabase/supabase-js";

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
async function redeemTokenHash(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const token_hash = params.get("token_hash");
  const type = params.get("type");
  if (!token_hash || !type) return;
  const { error } = await supabase.auth.verifyOtp({
    token_hash, type: type as "signup" | "recovery" | "email_change" | "invite",
  });
  if (error) console.warn("that link could not be used:", error.message);
}

/** Start listening. Resolves once the first state is known. */
export async function startAuth(): Promise<AuthState> {
  await redeemTokenHash();
  const { data } = await supabase.auth.getSession();
  await refresh(data.session);
  supabase.auth.onAuthStateChange((_event, session) => { void refresh(session); });
  return state;
}

// ---- the actions the screens call ---------------------------------------

/** Supabase reports most failures as an error object rather than by throwing. */
function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
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
  return intent ? `${location.origin}/?intent=${intent}` : `${location.origin}/`;
}

/**
 * Sign up, and say whether the address was already spoken for.
 *
 * Supabase does not refuse a duplicate. Asked to register an address that
 * already has a CONFIRMED account it answers `200`, sends no mail, changes
 * nothing, and hands back a user whose `identities` list is EMPTY -- so that a
 * stranger cannot use this form to find out who has an account here. The empty
 * list is the only thing that distinguishes it from a real sign-up, and it is
 * documented as the way to tell.
 *
 * Passed back rather than acted on, because the screen has to be careful with
 * it: saying "that address is taken" would hand back exactly the answer
 * Supabase just refused to give. See `verifyScreen` for the wording that is
 * useful to both people without telling either of them about the other.
 *
 * Note also what this does NOT return: a session. With email confirmation on,
 * there is no session until the link is followed, so the stage stays `out` and
 * nothing about the auth state changes here.
 */
export async function signUp(email: string,
                             password: string): Promise<{ existing: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { emailRedirectTo: landing() },
  });
  fail(error);
  return { existing: (data.user?.identities ?? []).length === 0 };
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  fail(error);
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

export async function resendVerification(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({
    type: "signup", email,
    options: { emailRedirectTo: landing() },
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

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: landing("password"),
  });
  fail(error);
}

export async function setPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  fail(error);
}

/**
 * Change the password of an account that is already signed in.
 *
 * The old password is checked by USING it, because Supabase does not ask for
 * one: `updateUser({ password })` will happily take a session's word for it.
 * That is fine for the emailed reset link, where the mail was the proof -- and
 * not fine here, where the proof would be a tab somebody left open.
 */
export async function changePassword(current: string,
                                     next: string): Promise<void> {
  const email = state.user?.email;
  if (!email) throw new Error("not signed in");
  const { error: wrong } = await supabase.auth.signInWithPassword({
    email, password: current,
  });
  if (wrong) throw new Error("that is not your current password");
  await setPassword(next);
}

/**
 * Ask to move the account to a different address.
 *
 * Nothing changes until the link is followed; Supabase mails the new address
 * and, depending on the project's settings, the old one as well. So this
 * returns having sent something, not having done something, and the screen has
 * to say so rather than reporting success.
 */
export async function changeEmail(email: string): Promise<void> {
  const { error } = await supabase.auth.updateUser(
    { email }, { emailRedirectTo: landing("email") });
  fail(error);
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
  const { error } = await supabase.rpc("delete_me");
  fail(error);
  await signOut();
}

/**
 * Claim a username.
 *
 * One argument now, and the order matters more than it looks. PostgREST picks
 * an overload by ARGUMENT NAME, so a client sending `invite_code` needs a
 * function that declares one; dropping the two-argument version while anything
 * still sends it means a 404 and nobody able to claim a name at all.
 *
 * This is the half that ships first. `claim_username(new_username, invite_code
 * default null)` accepts a call that omits the second argument perfectly well,
 * so this works against the schema as it stands today AND against the one left
 * behind once `deferred/20260911000000_drop_the_invite_machinery` is applied.
 * Only when THIS release is live does dropping the old signature become safe.
 */
export async function claimUsername(username: string): Promise<Profile> {
  const { data, error } = await supabase.rpc("claim_username", {
    new_username: username,
  });
  fail(error);
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
  const { data, error } = await supabase.auth.mfa.listFactors();
  fail(error);
  return data?.totp ?? [];
}

export async function enrolTotp(): Promise<Enrolment> {
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
  const { data, error } = await supabase.rpc("generate_recovery_codes");
  fail(error);
  return (data as string[]) ?? [];
}

export async function recoveryCodesLeft(): Promise<number> {
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
}

export async function unenrolTotp(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  fail(error);
}
