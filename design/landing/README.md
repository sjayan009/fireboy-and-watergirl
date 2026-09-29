# Landing page

The public landing page, designed from the deep-research report on what
makes an interface feel exceptional, intuitive and trustworthy. Nothing here is
wired into `app/` yet. Sign in links to the app's own sign-in screen (`#/login`): the local app on
localhost:5174 while developing, the deployed app otherwise.

```bash
npx vite design/landing --port 5180     # or: preview "design" in .claude/launch.json
```

`http://localhost:5180/` is the landing page; `http://localhost:5180/developers/` is the For Developers subsite.
`http://localhost:5180/board.html` is the exploration board, if you have it locally.

## What is here

| | |
|---|---|
| `index.html` | **the landing page**, for players, served at `/`: hero, Online Multiplayer, Watch & compete |
| `developers/` | **For Developers**, the subsite: Overview, Netcode (the live engine), Recovery, Architecture |
| `shared/` | its styles and modules (below) |
| `assets/` | art rasterised from the SWF's vectors, and the Watch panel's input script |
| `tools/` | the scripts that make those assets and check the page |

The design exploration behind it -- `board.html`, `directions/`, `motion/`,
`renders/` and the assets only they use -- is **local only**. It is in the
root `.gitignore`, is never pushed, and is not deployed. The index page does
not link to any of it.

## Shared pieces

- `shared/tokens.css`: the app's dark theme unchanged, plus a light theme whose hue was measured off the level stone. Every text token clears 4.5:1 in both themes.
- `shared/theme.js`: Dark / Light / Match system, **Dark by default** (the evidence is in the file's header), with a pre-paint snippet so the first frame has the right theme, a circular View Transition from the control, and a fade under reduced motion.
- `shared/site.js`: what every page does on load (theme control, Sign in target). `shared/devsite.css`: the subsite's styles and sub-navigation.
- `shared/doors-scene.js`: the hero. Every change is a Web Animation on one timeline, so the page, the study and the renderer all seek the same code.
- `shared/journey.js`: the three-step sign-in, invite and pair-save demo. A cursor plays it once; every control is also real, and touching one stops the demo.
- `shared/netdemo.js`: the netcode section, running the real engine (`LevelHost`, `Snapshot`, `SpriteRenderer` from `engine/dist`) with real rollback. The input script is tuned by `tools/tune.mjs`.
- `shared/watch.js`: the Watch panel, which runs a finish of Adventure 1 in the engine. The script is built by `tools/watch-script.mjs`.
- `vite.config.mjs`: serves `engine/dist` at `/engine` and `extracted/` at `/extracted`, so the pages can run the engine. Run `npm run build` in `engine/` first if the build is stale.
- `shared/rollback.js`: a deterministic rollback model (26 fps, a single snapshot every 8 settled frames, 0.04 ms per re-simulated frame) and its diagram.

## Regenerating

With the engine harness (`npm run serve`, :5173) and the design server (:5180) running:

```bash
node design/landing/tools/assets.mjs    # rasterise doors, characters, lever, wall from the SWF's vectors
node design/landing/tools/levels.mjs    # render all 32 levels through the rebuilt engine
node design/landing/tools/render.mjs    # pages, squint test, filmstrips, animated WebPs
node design/landing/tools/check.mjs     # errors, overflow, keyboard theme, reduced motion
```

Animations are captured by seeking, never by recording in real time, so every
frame is exact and the output is identical between runs.

## Found on the way

The engine's title screen draws the FIREBOY and WATERGIRL wordmarks as solid
lava and water rectangles, not letter-clipped fills. It looks like missing mask
support in the sprite renderer. For that reason the concepts do not use the
title screen.
