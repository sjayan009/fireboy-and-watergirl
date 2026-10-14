# The app

A static single-page app: accounts, and the game.

```bash
npm run dev      # from the repo root; builds the engine, then serves on :5174
npm run build    # engine, app, and the extracted assets into the REPO ROOT dist/
```

## Why static

Every page is a file on a CDN. There is no server-rendered route, no
middleware and no serverless function in the request path, so a page load costs
one round trip to the nearest edge and nothing else. That matters here more than
it usually does: the point of the whole project is latency, and a framework that
answers `/login` from a function in one region would put a server hop in front
of a game whose netcode goes peer to peer. Link creation may call the
authenticated Supabase TURN credential function; it does not sit on page
delivery or the per-frame gameplay path.

Auth is therefore client-side, against Supabase. That is not a compromise on
security -- **row level security is the boundary**, it is enforced in Postgres
against the signed-in user's JWT, and it is proved by `npm run db:test` through
the real API. The screens decide what to *draw*; the database decides what is
*allowed*.

No UI framework either. Six forms and a canvas do not need one, and the bundle
is 12 kB of app on top of the engine.

## The five gates

`auth.ts` resolves every session to one of five stages, and the router will not
show a screen the current stage is not standing in front of:

| | |
|---|---|
| `out` | no session |
| `unverified` | signed up, email link not followed |
| `locked` | signed in, but an enrolled second factor is unanswered |
| `nameless` | verified, but has not picked a username yet |
| `in` | has a profile, and can play |

Every one of these is also true in the database, and since migration `0013` that
is enforced rather than argued. An account with no profile is refused by every
gameplay-data policy and function -- it cannot even read the user directory, which is
where an attacker used to get the id they needed. A session that has not
answered an enrolled second factor is refused the same way, so the `locked`
screen is a convenience and not the boundary.

The one gate that is NOT in the database is the download. The bundle and the
extracted art are public static files; see the note in the root README.

## Who can get in

Anybody who confirms an email address. There used to be an invite code on
`claim_username`; `20260910000000_open_the_gate` took it off, because the
deployment is meant to be publicly playable.

What enforces the remaining requirement is not this app. Supabase refuses a
session to an unconfirmed address outright -- `email_not_confirmed`, no token
at all -- so verification is checked before any request of ours is reachable.
Google sign-in satisfies it the same way, because Google reports the address as
verified and Supabase records it as confirmed.

The obsolete invite machinery and its CLI were removed by
`20260911000000_drop_the_invite_machinery`. Google sign-in avoids a required
outbound mail service; password signup/reset requires separately verified free
SMTP. See [the deployment guide](../docs/HIGH_LEVEL/DEPLOYMENT.md) for the deployment and quota policy.

## Two-factor

Optional TOTP through Supabase MFA, enrolled from Settings. Once enrolled it is
enforced at every sign-in: Supabase issues the session at `aal1` regardless, and
the `locked` stage is what makes the factor mean something -- the app shows
nothing else until the code is answered.

## The surrounding interface

The surrounding interface uses the elemental control room shell. On desktop,
Friends opens beside the game by default; its collapsed state is remembered per
account. Friend requests, invitation setup, blocking and removal all live in
that panel. Removal still deletes shared progress and requires an explicit
inline confirmation. Leaderboard opens directly to verified results; Progress
shows the current browser or pair's best times.

Settings is a list of collapsed rows -- username, password, email, two-factor,
leaderboard, deleting the account -- opening one at a time, and each row shows
what it is set to without being opened. It used to be six forms stacked down one
card, which in a 320px panel was four screens of scrolling.

Inside the game itself, the intro menu's two dead entries -- More Games, which
opened a 2009 portal, and Submit Hiscore, which posted to a score service that
no longer exists -- no longer light up or take a click; their handlers have been
stubs for as long as this port has existed. A panel over that menu (Instructions,
Credits) now takes the whole pointer while it is up, so OK is the only thing on
those screens a click can reach.

The game canvas and engine are otherwise unchanged. Docked panels permit play when the
canvas is focused, while forms and narrow-screen modal panels release game
input. Mute and fullscreen remain direct toolbar actions.

Everything outside the canvas is set in the reader's own system font -- San
Francisco on Apple platforms, Segoe UI Variable on Windows 11, Roboto on
Android -- through `--ui` and `--heading` in `styles.css`. Nothing is
downloaded, which is 550 KB of Bricolage Grotesque and Source Sans 3 that used
to load in front of the first frame. Apple's own San Francisco files cannot be
served from a website: the licence covers app UI on Apple platforms, and this
stack is how a page gets the real thing on the devices entitled to it. The
canvas is untouched -- the game still draws the 2009 SWF's own baked glyphs.

`npm run test:play` exercises the shell, a local pair, and social interactions
in Chromium, Firefox and WebKit. All fixture users and leaderboard rows are
local; the fixtures are excluded from production builds.

## Assets

The extracted art and audio live at the repo root, not in `public/`. They are
42 MB, they belong to the game rather than to the app, and copying them into a
watched directory would make every dev server start miserable. The dev server
reads them where they are (a middleware in `vite.config.ts`); the build copies
them into `dist/extracted/assets` once.

`extracted/assets/_raw/` is excluded and must stay excluded: 116 MB of JPEXS
intermediates that the shipped assets were derived from.

## Runtime ICE configuration

The optional build-time `ICE_SERVERS` setting accepts public STUN URLs only.
`net/turn.ts` obtains short-lived ICE credentials from the authenticated
`turn-credentials` function at link creation, caches them in memory and falls
back to public STUN on failure. Cloudflare TURN is selected by WebRTC ICE;
Supabase gameplay relay remains the emergency application path. Master
Cloudflare tokens never belong in client source, Vite configuration or public
assets. See [TURN setup and live acceptance](../docs/DEEP_DIVE/TURN.md)
and [migration flags](../docs/DEEP_DIVE/NETCODE.md).

## Configuration the dashboard has to supply

The following production settings require operator configuration:

1. **Redirect URLs.** Add the deployed origin and `http://localhost:5174` to
   Auth → URL Configuration. Emailed links come back to the bare origin with
   `?code=` and `?intent=`, never to a `#` path -- PKCE hands the code back in
   the query string, and a redirect into the fragment would leave it somewhere
   nothing looks.
2. **Custom SMTP.** The built-in sender is rate-limited to a few messages an
   hour and is documented as being for testing. Email verification is required
   here, so it needs a real sender before anyone but you signs up.
3. **TURN broker.** Deploy the Edge Function, store its Cloudflare key/token
   only as server secrets, configure `TURN_ALLOWED_ORIGINS`, and verify a full
   forced-TURN pair session. Monitor the free allowance; alerts are not a
   spending cap. The runbook contains CLI commands and rollback instructions.
