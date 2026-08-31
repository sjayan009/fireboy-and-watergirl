"""Transliterate level.as and ContactListener.as -- the game itself -- to TS.

Reuses the AS3->TS machinery from as3_to_ts.py, with three differences that
matter for game code rather than for Box2D:

  * base classes live outside this file (`Sprite` from the Flash shim,
    `b2ContactListener` from the ported Box2D), so `extends` and `super()` are
    kept rather than stripped.
  * inherited display-list *methods* (`addChild`, `getChildByName`, ...) are
    called unqualified in AS3 and need `this.`. Inherited *properties* are
    never assigned bare in this source, so they are deliberately left alone --
    auto-qualifying names as common as `x` and `y` would be reckless.
  * imports have to be generated, since the output is a separate module from
    box2d.ts and the Flash shim.
"""
import json
import os
import re

import as3_to_ts as T

HERE = os.path.dirname(os.path.abspath(__file__))
AS3 = os.path.join(HERE, "..", "extracted", "as3", "scripts")
BOX2D_SRC = os.path.join(AS3, "Box2D")
SYMS = os.path.join(HERE, "..", "extracted", "symbols.json")
SYMS_TS = os.path.join(HERE, "..", "engine", "src", "flash", "symbols.ts")
OUT = os.path.join(HERE, "..", "engine", "src", "game", "game.ts")

SOURCES = ["ContactListener.as", "level.as", "FPSCounter.as", "PauseMenu.as",
           "Recuento.as", "GameOvero.as",
           # the two load-bearing frame scripts: deadFire's frame 32 calls
           # Game.GameOver() and WaterGirlStairs' frame 35 calls
           # Game.Recuent(). They are the ONLY triggers for the death and
           # results screens in the whole game.
           "deadFire.as", "WaterGirlStairs.as",
           "Game.as"]

# Classes that are ALSO SWF library symbols: they must keep the symbol's frame
# count and named children (PauseMenu addresses `retryBtn` and `BlueCount`,
# Recuento addresses `Rboard`), so they extend LibraryClip instead of the base
# the decompiled source names.
SHELL_SYMBOLS = {"PauseMenu", "Recuento", "GameOvero", "deadFire",
                 "WaterGirlStairs"}

# 2009 third-party plumbing: the CPMStar ad preloader, the Armor Games teaser,
# and the Armor Games hiscore endpoints, all dead for over a decade.
#
# Their BODIES are emptied rather than the methods deleted. CreateIntroMenu
# still wires Submiter to LoadHiscore and Morer to MoreGames, so removing the
# methods outright would mean editing the menu wiring too; emptying them keeps
# every reference resolving and leaves the surrounding control flow literal.
STUB_BODIES = {
    "Game": {
        "CreatePreloader", "CreateTeaser", "TeaserClick", "TeaserOut",
        "loadComplete", "closeHandler", "closeHandler2",
        "LoadHiscore", "SendHiscore", "ViewHiscores", "BackHiscore",
        "InputChanged", "MoreGames",
    },
}

# Source-level substitutions, applied before qualification.
LINE_REWRITES = {
    "Game": [
        # the preloader chain (PreLoader -> CreateTeaser -> TeaserOut ->
        # GameReady) is gone with the ad and the teaser, so boot straight into
        # the game's own setup
        ("CreatePreloader();", "GameReady();"),
        # progress goes behind a storage interface from the start: localStorage
        # today, Supabase pair-progress later, same shape either way
        ('SharedObject.getLocal("FBCookie")', 'openSave("FBCookie")'),
        # the original's own bug: an Array is compared by reference, so this is
        # always true and the firefly's chirp plays on every roll-over. Kept,
        # with a cast so TypeScript stops flagging what the game intends.
        ("nextpos != [param1.target.x,param1.target.y]",
         "nextpos != ([param1.target.x,param1.target.y] as any)"),
        # A deliberate divergence, and the only one here that changes behaviour
        # rather than plumbing. StartGame creates a Muter every time; EndGame
        # removes one and RetryGame does not, so every retry left another mute
        # button stacked exactly on top of the last, each with its own frame
        # listener. Invisible -- they are identical and at the same coordinates
        # -- and a leak all the same.
        #
        # Both call sites, not just the one that leaks. removeChild is a no-op
        # for something that is not a child, so "clear the old one before
        # StartGame makes another" is simply true everywhere, and a rule with no
        # exception is worth more than one that has to be pointed at the right
        # line.
        ("StartGame(cur_type,cur_lev);",
         "removeChild(m_muter); StartGame(cur_type,cur_lev);"),
    ],
}

# Base types that live in another module.
EXTERNAL_BASES = {
    "Sprite": "flash",
    "MovieClip": "flash",
    "b2ContactListener": "box2d",
}

# Inherited display-list PROPERTIES, called unqualified in AS3.
#
# Only applied to the shell classes. level.as is left exactly as it was:
# auto-qualifying names as common as `x` and `y` across 3,286 lines of game
# code would be reckless, and the determinism digest is the proof that nothing
# there changed.
SHELL_PROPS = {
    "x", "y", "width", "height", "alpha", "visible", "rotation",
    "scaleX", "scaleY", "name", "stage", "contextMenu", "loaderInfo",
    "buttonMode", "useHandCursor", "tabChildren", "mouseEnabled",
    "addFrameScript",
}
SHELL_PROP_CLASSES = {"Game", "FPSCounter", "PauseMenu", "Recuento",
                      "GameOvero", "deadFire", "WaterGirlStairs"}

# Inherited display-list methods, called unqualified in AS3.
INHERITED_METHODS = {
    "addChild", "addChildAt", "removeChild", "removeChildAt", "getChildAt",
    "getChildByName", "contains", "hitTestPoint", "gotoAndStop",
    "swapChildren", "addEventListener", "removeEventListener",
    "hasEventListener", "dispatchEvent",
    "gotoAndPlay", "play", "stop", "nextFrame", "prevFrame",
}

FLASH_EXPORTS = [
    "Sprite", "MovieClip", "DisplayObject", "DisplayObjectContainer",
    "Bitmap", "BitmapData", "Matrix", "GlowFilter", "DropShadowFilter",
    "Sound", "SoundChannel", "Event", "KeyboardEvent", "Keyboard",
    "SoundBus", "advanceTree",
    # the shell
    "MouseEvent", "SoundTransform", "SoundMixer", "TextField",
    "TextFieldAutoSize", "ContextMenu", "Stage",
]

PRELUDE = '''
/** AS3 `int(x)`: truncate and wrap to 32-bit signed. */
function i32(x: number): number { return x | 0; }
/** AS3 `uint(x)`: truncate and wrap to 32-bit unsigned. */
function u32(x: number): number { return x >>> 0; }
/** AS3 `trace()` -- kept as a no-op so the ported code stays literal. */
function trace(..._args: any[]): void {}

let __frames = 0;

/**
 * flash.utils.getTimer(), driven by the frame counter instead of the wall
 * clock. This is the one deliberate divergence from the original.
 *
 * The timer is not decoration: Recuent() compares it against TimeTable to
 * decide the medal, and two peers in lockstep have to award the same one. A
 * wall clock makes that a race with whichever machine stutters. At the fixed
 * 1/26 s step this equals real time except during a stall -- exactly the case
 * where the original would have disagreed anyway.
 */
export function getTimer(): number {
  return Math.round(__frames * 1000 / 26);
}

/** One simulation step. The host calls this once per fixed timestep. */
export function tickClock(): void { __frames++; }

/** Reset the clock, for a fresh session or a deterministic replay. */
export function resetClock(): void { __frames = 0; }

/**
 * The clock is simulation state, not host state.
 *
 * `Recuent()` awards the medal by comparing getTimer() against TimeTable, and
 * the level's own timer sets `startTime = getTimer()`. Rolling the world back
 * without rolling this back too would re-award a different medal on the
 * replayed frames -- a desync that no amount of physics determinism prevents.
 */
export function getClock(): number { return __frames; }
export function setClock(f: number): void { __frames = f; }
'''


RE_LISTENER = re.compile(
    r"((?:add|remove)EventListener\(\s*[^,()]+,\s*)"
    r"(this(?:\.[A-Za-z_]\w*)+)")


def bind_listeners(line):
    """AS3 method references are bound to the object they came from.

    `this.Rboard.addEventListener(ENTER_FRAME, this.Ease)` in Recuento has to
    call Ease with the *Recuento* as `this`, not the Rboard the listener is
    attached to -- Ease reads this.v, this.acc and this.Tapper. Plain JS would
    pass the listener's own object and the results board would never move.

    The owner is the receiver of the method expression: `this.Update` is owned
    by `this`, `this.m_level.Update` by `this.m_level`. DisplayObject.__bind
    memoises, so removeEventListener still matches by identity.
    """
    def sub(m):
        expr = m.group(2)
        owner = expr.rsplit(".", 1)[0]
        return "%s%s.__bind(%s)" % (m.group(1), owner, expr)
    return RE_LISTENER.sub(sub, line)


def stub_out(body, names):
    """Empty the bodies of the named methods, keeping their signatures.

    `body` is a flat list where a "sig" entry opens a method and everything up
    to the next "sig" belongs to it. Brace depth, not the first closing brace,
    is what finds the end: these methods contain while loops and anonymous
    functions, so an inner `}` arrives long before the method's own.
    """
    out = []
    depth = 0
    dropping = False
    for kind, line in body:
        if kind == "sig":
            dropping = any(re.search(r"(?<![\w$])%s\s*\(" % re.escape(nm), line)
                           for nm in names)
            out.append((kind, line))
            if dropping:
                depth = 1
                indent = line[:len(line) - len(line.lstrip())]
                out.append(("code", indent + "   // stubbed: dead 2009 "
                                             "ad / teaser / hiscore plumbing"))
            continue
        if not dropping:
            out.append((kind, line))
            continue
        depth += line.count("{") - line.count("}")
        if depth <= 0:
            # the method's own closing brace, indent and all
            out.append((kind, line[:line.index("}") + 1]))
            dropping = False
    return out


def main():
    # Box2D class names, so we know what to import from box2d.ts
    box2d_names = set()
    for d, _, fs in os.walk(BOX2D_SRC):
        for f in fs:
            if f.endswith(".as"):
                ci = T.parse_file(os.path.join(d, f))
                if ci:
                    box2d_names.add(ci.name)

    symbol_names = set(re.findall(r"^export class (\w+)",
                                  open(SYMS_TS, encoding="utf-8").read(),
                                  re.M))

    classes = {}
    order = []
    for src in SOURCES:
        ci = T.parse_file(os.path.join(AS3, src))
        if ci:
            classes[ci.name] = ci
            order.append(ci.name)
    print("parsed %d game classes: %s" % (len(classes), ", ".join(order)))

    for n, ci in classes.items():
        for old_txt, new_txt in LINE_REWRITES.get(n, []):
            ci.body = [(k, ln.replace(old_txt, new_txt)) for k, ln in ci.body]

        stubs = STUB_BODIES.get(n, set())
        if stubs:
            ci.body = stub_out(ci.body, stubs)

        if n in SHELL_SYMBOLS:
            # keep the SWF symbol's frames and named children
            ci.base = "LibraryClip"
            # keep the indent: split on the call, do not regex it,
            # so no backreference is involved
            ci.body = [(k, ln.replace("super();",
                                      'super("' + n + '");'))
                       for k, ln in ci.body]

    body_out = []
    for n in order:
        ci = classes[n]
        so = {s: n for s in ci.statics}
        so.update({s: n for s in ci.smethods})
        # A member of this class shadows a same-named class: ContactListener
        # has a boolean field `deadFire`, and deadFire is also the clip that
        # plays the death animation. AS3 resolves the field; without this the
        # bare name would resolve to the class instead.
        own = set(f[0] for f in ci.fields) | set(ci.methods)
        im = ((own | INHERITED_METHODS) - set(so) - box2d_names
              - (set(classes) - own))
        if n in SHELL_PROP_CLASSES:
            im |= SHELL_PROPS

        # TS requires super() first; AS3 allows field writes before it.
        if ci.base:
            for i, (kind, line) in enumerate(ci.body):
                if kind != "sig" or "constructor(" not in line:
                    continue
                for j in range(i + 1, len(ci.body)):
                    if ci.body[j][0] == "sig":
                        break
                    if re.match(r"^\s*super\(", ci.body[j][1]):
                        ci.body.insert(i + 1, ci.body.pop(j))
                        break
                break

        ci.body = T.coerce_int_assignments(ci.body, dict(ci.intfields))

        # A level's cosmetic randomness (firefly placement, which GroundBox
        # variant draws each tile, decor rotation) has to be identical on
        # both peers or they look at visibly different levels. Seed it from
        # the level id right after super(), so it exists before
        # CreateGround -- which the constructor calls -- first draws.
        if n == "level":
            for i, (kind, line) in enumerate(ci.body):
                if kind == "code" and line.strip().startswith("super("):
                    ci.body.insert(i + 1, ("code",
                        "         this.rng = new Rng(seedFrom(param1,param2));"))
                    break
            else:
                raise SystemExit("level ctor has no super() to seed after")
            ci.fields.append(("rng", "Rng", None))

        parts = []
        for kind, line in ci.body:
            if kind == "code":
                line = T.qualify(line, so.keys(), lambda s: so[s] + ".")
                line = T.qualify(line, im, lambda s: "this.")
            parts.append(T.on_code(line, bind_listeners)
                         if kind == "code" else line)
        body = T.rewrite_calls("\n".join(parts),
                               random_to="this.rng.next()")

        ext = ""
        if ci.base:
            ext = " extends %s" % ci.base
        head = ["export class %s%s {" % (n, ext)]
        for s, (ty, _) in ci.statics.items():
            head.append("  static %s: %s;" % (s, ty))
        for fn, ty, init in ci.fields:
            if init:
                init = T.rewrite_calls(
                    T.qualify(init, so.keys(), lambda x: so[x] + "."))
            head.append("  %s: %s%s;" % (fn, ty, " = " + init if init else ""))
        body_out.append("\n".join(head) + "\n" + body + "\n}\n")

        for s, (ty, init) in ci.statics.items():
            if init is not None:
                body_out.append("%s.%s = %s;" % (n, s, T.rewrite_calls(init)))

    text = "\n".join(body_out)

    def referenced(names):
        return sorted(n for n in names
                      if re.search(r"(?<![\w.$])%s(?![\w$])" % re.escape(n),
                                   text))

    imports = []
    b2 = referenced(box2d_names)
    if b2:
        imports.append('import {\n  %s,\n} from "../box2d/box2d.js";'
                       % ",\n  ".join(b2))
    imports.append('import { detSin, detCos, detAtan2, detAcos, detPow } '
                   'from "../box2d/dettrig.js";')
    imports.append('import { Rng, seedFrom } from "../net/rng.js";')
    if "SharedObject" in text or "openSave" in text:
        imports.append('import { openSave } from "./save.js";')
    fl = referenced(FLASH_EXPORTS)
    if fl:
        imports.append('import { %s } from "../flash/flash.js";'
                       % ", ".join(fl))
    # the SWF library also contains an empty symbol named `level`,
    # which would collide with the game class of the same name
    sy = [n for n in referenced(symbol_names) if n not in classes]
    if "LibraryClip" in text and "LibraryClip" not in sy:
        sy.append("LibraryClip")
        sy.sort()
    if sy:
        imports.append('import {\n  %s,\n} from "../flash/symbols.js";'
                       % ",\n  ".join(sy))

    header = ("// GENERATED by tools/gen_game.py from the decompiled "
              "level.as / ContactListener.as.\n"
              "// Do not edit by hand -- re-run the generator instead.\n\n")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write(
        header + "\n".join(imports) + "\n" + PRELUDE + "\n" + text)
    n_lines = len((header + text).split("\n"))
    print("imported %d Box2D types, %d flash types, %d symbols"
          % (len(b2), len(fl), len(sy)))
    print("wrote %s (%d lines)" % (os.path.abspath(OUT), n_lines))


if __name__ == "__main__":
    main()
