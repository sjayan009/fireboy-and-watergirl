/**
 * Who is signed in, and how far through the door they are.
 *
 * Getting in has four gates, and the app has to know which one somebody is
 * standing at before it can show them anything:
 *
 *   out        no session at all
 *   unverified signed up, but the email link has not been followed
 *   locked     signed in, but a second factor is enrolled and unanswered
 *   nameless   verified, but no profile -- needs a username and an invite code
 *   in         has a profile, and can play
 *
 * The gates are UI, not security. Every one of them is also enforced in the
 * database: a user with no profile cannot be found by anybody, cannot be
 * befriended, and so cannot reach a single row of anyone else's data. What is
 * here decides what to draw, not what is allowed.
 */
import { supabase } from "./supabase.js";
import type { Session, User } from "@supabase/supabase-js";

export interface Profile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export type Stage = "out" | "unverified" | "locked" | "nameless" | "in";

export interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  stage: Stage;
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
 * Whether a second factor is enrolled and still owed.
 *
 * Supabase models this as assurance levels: `aal1` is a password, `aal2` is a
 * password plus a factor. If the next level is above the current one, there is
 * a factor enrolled that this session has not answered.
 */
async function needsSecondFactor(): Promise<boolean> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  return data.nextLevel === "aal2" && data.currentLevel !== "aal2";
}

async function fetchProfile(id: string): Promise<Profile | null> {
  const { data } = await supabase
    .from("profiles")
    .select("id, username, display_name, avatar_url")
    .eq("id", id)
    .maybeSingle();
  return (data as Profile) ?? null;
}

/** Work out which gate the current session is standing at. */
export async function refresh(session: Session | null): Promise<AuthState> {
  if (!session?.user) {
    publish({ session: null, user: null, profile: null, stage: "out" });
    return state;
  }
  const user = session.user;
  if (!user.email_confirmed_at) {
    publish({ session, user, profile: null, stage: "unverified" });
    return state;
  }
  if (await needsSecondFactor()) {
    publish({ session, user, profile: null, stage: "locked" });
    return state;
  }
  const profile = await fetchProfile(user.id);
  publish({
    session, user, profile, stage: profile ? "in" : "nameless",
  });
  return state;
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

export async function signUp(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signUp({
    email, password,
    options: { emailRedirectTo: landing() },
  });
  fail(error);
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  fail(error);
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
 * Claim a username, redeeming an invite code in the same statement.
 *
 * Both halves are one database function on purpose: a code checked and then
 * used in a second statement is a code two people can pass at once, and a name
 * checked and then inserted is a name two people can take at once.
 */
export async function claimUsername(username: string,
                                    inviteCode: string | null): Promise<Profile> {
  const { data, error } = await supabase.rpc("claim_username", {
    new_username: username,
    invite_code: inviteCode,
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

export async function unenrolTotp(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  fail(error);
}
