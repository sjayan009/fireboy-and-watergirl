"""Cross-check the bytecode-extracted grids against JPEXS-decompiled level.as,
and pull the per-level entity placements the grid does not carry.

Two independent paths to the same data: extract_levels.py walks raw AVM2
bytecode, this walks decompiled source. If they agree, the level data is right.

The decompiler wraps long lines and renames the constructor parameters to
param1 (mode) / param2 (level), so we collapse the file to a single string and
walk it with a brace-tracking scanner rather than parsing line by line.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "extracted", "as3", "scripts", "level.as")
GRIDS = os.path.join(HERE, "..", "extracted", "levels")
OUT = os.path.join(HERE, "..", "extracted", "entities")

PLACEHOLDER = {"_loc6_": "bd", "_loc7_": "rd", "_loc8_": "gr"}

ENTITY_CALLS = (
    "CreateFinish", "CreateLever", "CreatePusher", "CreateSlidePlatform",
    "CreateWind", "CreateBall", "CreateMovingBox", "CreateRotPlatform",
    "CreateHangingPlatform", "CreatePulley", "CreatRoman", "CreateJumper",
)
SPAWNS = ("StartPosFire", "StartPosWater")

RE_MODE = re.compile(r'param1\s*==\s*"([^"]+)"\s*\)\s*$')
RE_LEVEL = re.compile(r"param2\s*==\s*(-?\d+)\s*\)\s*$")


def split_args(s):
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


def parse_value(tok):
    tok = tok.strip()
    if tok in PLACEHOLDER:
        return PLACEHOLDER[tok]
    if tok.startswith("new Array(") and tok.endswith(")"):
        return [parse_value(a) for a in split_args(tok[10:-1])]
    if tok.startswith("new b2Vec2(") and tok.endswith(")"):
        xs = split_args(tok[11:-1])
        return {"x": parse_value(xs[0]), "y": parse_value(xs[1])}
    if len(tok) >= 2 and tok[0] == '"' and tok[-1] == '"':
        return tok[1:-1]
    if tok in ("true", "false"):
        return tok == "true"
    if tok == "null":
        return None
    try:
        return int(tok)
    except ValueError:
        pass
    try:
        return float(tok)
    except ValueError:
        return tok


def scan(text):
    """Yield (mode, level, statement) for every statement in the file."""
    depth = 0
    mode = level = None
    mode_d = level_d = None
    buf = []
    for ch in text:
        if ch == "{":
            s = "".join(buf)
            m = RE_MODE.search(s)
            if m:
                mode, mode_d = m.group(1), depth
            m = RE_LEVEL.search(s)
            if m:
                level, level_d = int(m.group(1)), depth
            depth += 1
            buf = []
        elif ch == "}":
            depth -= 1
            if mode_d is not None and depth <= mode_d:
                mode, mode_d = None, None
            if level_d is not None and depth <= level_d:
                level, level_d = None, None
            buf = []
        elif ch == ";":
            yield mode, level, "".join(buf).strip()
            buf = []
        else:
            buf.append(ch)


def main():
    raw = open(SRC, encoding="utf-8", errors="replace").read()
    text = re.sub(r"\s+", " ", raw)

    grids, entities, spawns = {}, {}, {}
    for mode, level, st in scan(text):
        if mode is None or level is None or not st:
            continue
        key = "%s-%02d" % (mode, level)

        if st.startswith("LevelArray = new Array("):
            grids[key] = parse_value(st[len("LevelArray = "):])
            continue
        for sp in SPAWNS:
            if st.startswith(sp + " = new b2Vec2("):
                spawns.setdefault(key, {})[sp] = parse_value(
                    st[len(sp + " = "):])
        for call in ENTITY_CALLS:
            if st.startswith(call + "("):
                args = [parse_value(a)
                        for a in split_args(st[len(call) + 1:-1])]
                entities.setdefault(key, []).append(
                    {"type": call, "args": args})
                break

    print("cross-checking %d source grids against bytecode extraction\n"
          % len(grids))
    ok = bad = missing = 0
    for key in sorted(grids):
        path = os.path.join(GRIDS, key + ".json")
        if not os.path.exists(path):
            print("  MISSING bytecode grid: %s" % key)
            missing += 1
            continue
        mine = json.load(open(path))["grid"]
        theirs = grids[key]
        if mine == theirs:
            ok += 1
        else:
            bad += 1
            diffs = [(r, c, mine[r][c], theirs[r][c])
                     for r in range(min(len(mine), len(theirs)))
                     for c in range(min(len(mine[r]), len(theirs[r])))
                     if mine[r][c] != theirs[r][c]]
            print("  MISMATCH %s: %dx%d vs %dx%d, %d differing cells" %
                  (key, len(mine), len(mine[0]), len(theirs),
                   len(theirs[0]), len(diffs)))
            for d in diffs[:5]:
                print("      row %d col %d: bytecode=%r source=%r" % d)
    print("  identical: %d   mismatched: %d   missing: %d" % (ok, bad, missing))

    os.makedirs(OUT, exist_ok=True)
    counts, total = {}, 0
    for key in sorted(set(list(entities) + list(spawns))):
        rec = {"spawns": spawns.get(key, {}),
               "entities": entities.get(key, [])}
        with open(os.path.join(OUT, key + ".json"), "w") as f:
            json.dump(rec, f, indent=1)
        for e in rec["entities"]:
            counts[e["type"]] = counts.get(e["type"], 0) + 1
            total += 1

    print("\nspawn pairs found: %d / %d levels" % (len(spawns), len(grids)))
    print("entity placements: %d across %d levels\n" % (total, len(entities)))
    for k in sorted(counts, key=lambda x: -counts[x]):
        print("   %-24s %d" % (k, counts[k]))
    print("\nwrote entities to %s" % os.path.abspath(OUT))


if __name__ == "__main__":
    main()
