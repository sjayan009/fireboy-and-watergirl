# The app

A static single-page app: accounts, the invite gate, and the game.

```bash
npm run dev      # from the repo root; builds the engine, then serves on :5174
npm run build    # engine, app, and the extracted assets into the REPO ROOT dist/
npm run invite   # mint an invite code (see below)
```

## Why static

Every page is a file on a CDN. There is no server-rendered route, no
middleware and no serverless function in the request path, so a page load costs
one round trip to the nearest edge and nothing else. That matters here more than
it usually does: the point of the whole project is latency, and a framework that
answers `/login` from a function in one region would put a server hop in front
of a game whose netcode goes peer to peer.

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
| `nameless` | verified, but no profile -- needs a username and an invite code |
| `in` | has a profile, and can play |

Every one of these is also true in the database, and since migration `0013` that
is enforced rather than argued. An account with no profile is refused by every
policy and every function -- it cannot even read the user directory, which is
where an attacker used to get the id they needed. A session that has not
answered an enrolled second factor is refused the same way, so the `locked`
screen is a convenience and not the boundary.

The one gate that is NOT in the database is the download. The bundle and the
extracted art are public static files; see the note in the root README.

## The invite gate

Sign-up itself is not gated, because it cannot be: it is Supabase Auth, it
happens in the browser, and a check the browser is asked to make first is not a
check. The gate is on `claim_username` instead, which redeems the code and
creates the profile **in one statement** -- so a code two people spend at once,
and a name two people take at once, both resolve to exactly one winner.

```bash
npm run invite -- --uses 5 --days 30 --note "for the group chat"
npm run invite -- --list
```

Codes are minted with the secret key, straight against the database.
`invite_codes` has no row level security policies at all, for any role, so a
signed-in user can neither enumerate codes nor reset their use counts.

## Two-factor

Optional TOTP through Supabase MFA, enrolled from Settings. Once enrolled it is
enforced at every sign-in: Supabase issues the session at `aal1` regardless, and
the `locked` stage is what makes the factor mean something -- the app shows
nothing else until the code is answered.

## Assets

The extracted art and audio live at the repo root, not in `public/`. They are
42 MB, they belong to the game rather than to the app, and copying them into a
watched directory would make every dev server start miserable. The dev server
reads them where they are (a middleware in `vite.config.ts`); the build copies
them into `dist/extracted/assets` once.

`extracted/assets/_raw/` is excluded and must stay excluded: 116 MB of JPEXS
intermediates that the shipped assets were derived from.

## Configuration the dashboard has to supply

Two things live in the Supabase dashboard and cannot be set from here:

1. **Redirect URLs.** Add the deployed origin and `http://localhost:5174` to
   Auth → URL Configuration. Emailed links come back to the bare origin with
   `?code=` and `?intent=`, never to a `#` path -- PKCE hands the code back in
   the query string, and a redirect into the fragment would leave it somewhere
   nothing looks.
2. **Custom SMTP.** The built-in sender is rate-limited to a few messages an
   hour and is documented as being for testing. Email verification is required
   here, so it needs a real sender before anyone but you signs up.
