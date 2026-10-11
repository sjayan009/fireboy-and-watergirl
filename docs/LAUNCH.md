# Launch: discovery, legal, marketing

What the code already does is at the top. Everything after it is a step only
the owner can take: accounts, consoles, posting.

## Shipped in the repo

- **Privacy Policy** and **Terms** at `/legal/privacy.html` and `/legal/terms.html`.
  They are linked from every footer and from the sign-up form.
- An **"unofficial fan project, not affiliated with Oslo Albet"** notice in
  every footer, in the Terms, in the `<noscript>` text and in `llms.txt`.
- A **13+ neutral age screen** in front of every way to make an account
  (`app/src/age.ts`), including Google sign-in.
- **Guest play with no account** at `#/play` (signed out), open to everyone,
  kids included, sending nothing to the server. `#/local`, its old address,
  shows the same screen. It is linked from the landing page's "Local" chip.
- **SEO**: a keyword title and description, a canonical link, Open Graph and
  Twitter cards (`og.png`, 1200×630, a capture of the real hero), JSON-LD
  `VideoGame`, `sitemap.xml`, and a `Sitemap:` line in `robots.txt`.
- **AI search**: `llms.txt`, and `<noscript>` text so crawlers that don't run
  JavaScript (GPTBot, ClaudeBot, PerplexityBot, link previews) see more than
  an empty `<div>`.
- Absolute URLs come from `SITE_URL`, falling back to the Cloudflare Workers
  address. Set `SITE_URL` when a custom domain lands.

## Before marketing

1. **Read the IP risk once more.** Oslo Albet is actively selling this
   franchise: games 1–4 were re-released on Steam in September 2026. Promoting
   a free copy of their art and levels invites a DMCA notice to Vercel or
   GitHub. The Terms promise prompt removal on request. Keep that promise if
   asked, and keep a version that does not depend on their assets (the
   For Developers pages) in mind as the fallback.
2. **Drop "official" from the address.** Done 2026-10-06:
   `fireboy-and-watergirl-official` read as an impersonation claim, so the
   project moved to `fbwg-online-multiplayer.vercel.app` and the old host was
   removed. A bought domain would still need adding in Cloudflare and `SITE_URL`.
3. **Google OAuth consent screen**: add the Privacy Policy and Terms URLs, and
   the new domain as an authorized domain.
4. **Supabase Auth**: add the new domain to Site URL and Redirect URLs.

## Search consoles (free, about 30 minutes)

- **Google Search Console**: verify the domain (a DNS TXT record), submit
  `/sitemap.xml`, then request indexing for `/` and `/developers/`.
- **Bing Webmaster Tools**: import from Search Console. Bing's index also
  feeds ChatGPT search and DuckDuckGo.
- Check the cards with the opengraph.xyz previewer, or by pasting the link
  into a private Discord or X draft.

Google says `llms.txt` does nothing for AI Overviews: those come from the
normal index, so Search Console is the AI-search step that counts.
Perplexity, Claude and browsing agents do read `llms.txt`.

## Where to post

The engineering is the safest and strongest story, because it is original.

| Channel | What to post | Notes |
|---|---|---|
| Hacker News (Show HN) | "I rebuilt a 2009 Flash game from its SWF and added rollback netcode" → /developers/ | One shot. Post on a weekday morning (US Eastern) and stay to answer comments |
| r/gamedev, r/webdev, r/programming | The Netcode or Recovery write-up | Read each subreddit's self-promotion rules first |
| r/flashgames, r/nostalgia | "Play Forest Temple online with a friend" | Expect the IP question in the comments |
| X / Bluesky / LinkedIn | 20–40 s clips: two browsers playing in sync, the rollback demo | LinkedIn suits the Georgia Tech and research angle |
| YouTube Shorts / Instagram Reels / TikTok | The same clips, vertical | Gaming reach on TikTok has fallen to roughly 4–8% organically. Reels and Shorts currently reach more |
| Georgia Tech | Lab demo, a write-up, a talk | Credibility that outlasts any takedown |

Social accounts: the platforms require you to be 13 or older. Use a handle
without "official" in it (for example "fbwg.online.coop", not
"fireboywatergirl"), say "fan project" in the bio, and link to the site.

## Later

- Under-13 accounts need verifiable parental consent (COPPA, amended rule in
  force since 22 April 2026). It is a separate project; local play covers kids
  until then.
- Privacy-friendly analytics (Vercel Web Analytics is cookieless) would need
  a line in the Privacy Policy before it is turned on.
- Have a lawyer read the two legal pages once there is real traffic. They are
  written to match this code, but they are not legal advice.
