"""Recover the level tile grids from level.<constructor> (ABC method 782).

The constructor is one long if/else chain:

    if (CurrentMode == 'puzzle') {
        if (CurrentLevel == 8) {
            LevelArray = new Array(new Array(1,1,1,...), new Array(...), ...);
        }
        ...
    }

Values are pushed with pushbyte (sign-extended) and repeated with `dup`;
rows are built by `constructprop Array (n args)`. We walk the instruction
stream linearly, track the most recent mode/level guard, and run a tiny stack
machine over each assignment to rebuild the nested arrays.
"""
import json
import os
import sys

import swfabc as A
import disasm as D

SWF = os.path.join(os.path.dirname(__file__), "..",
                   "Fireboy & Watergirl - The Forest Temple.swf")
OUT = os.path.join(os.path.dirname(__file__), "..", "extracted", "levels")

MARK = object()


def sbyte(v):
    return v - 256 if v > 127 else v



def scan_locals(ins, abc):
    """Recover `local_N = <string literal>` assignments from the prologue."""
    out = {}
    for i, (off, name, args) in enumerate(ins):
        if name != "pushstring":
            continue
        for off2, n2, a2 in ins[i + 1:i + 4]:
            if n2 == "setlocal":
                out[a2[0]] = abc.strings[args[0]]
                break
            if n2 not in ("coerce_a", "coerce", "convert_s"):
                break
    return out


def build_array(ins, i, abc, locals_):
    """Run the stack machine from `findproperty LevelArray` at index i.

    Returns (nested_list, index_after).
    """
    stack = []
    i += 1
    while i < len(ins):
        off, name, args = ins[i]
        if name == "findpropstrict" and abc.name(args[0]) == "Array":
            stack.append(MARK)
        elif name == "pushbyte":
            stack.append(sbyte(args[0]))
        elif name == "pushshort":
            stack.append(args[0])
        elif name == "pushint":
            stack.append(abc.ints[args[0]])
        elif name == "pushdouble":
            stack.append(abc.doubles[args[0]])
        elif name == "pushnull":
            stack.append(None)
        elif name == "pushtrue":
            stack.append(True)
        elif name == "pushfalse":
            stack.append(False)
        elif name == "dup":
            stack.append(stack[-1])
        elif name == "getlocal":
            # The constructor assigns 'bd'/'rd'/'gr' (blue/red/green diamond)
            # to locals 6/7/8 and leaves the rest undefined; the level literals
            # then refer to them by name. Anything unassigned is "no tile".
            stack.append(locals_.get(args[0]))
        elif name.startswith("getlocal"):
            stack.append(None)
        elif name == "constructprop" and abc.name(args[0]) == "Array":
            n = args[1]
            vals = stack[len(stack) - n:] if n else []
            del stack[len(stack) - n:]
            if stack and stack[-1] is MARK:
                stack.pop()
            stack.append(vals)
        elif name in ("initproperty", "setproperty") and \
                abc.name(args[0]) == "LevelArray":
            result = stack.pop() if stack else None
            return result, i + 1
        elif name in ("coerce_a", "coerce", "convert_d", "convert_i", "label",
                      "nop"):
            pass
        else:
            raise RuntimeError(
                "unexpected op %s at instr %d (offset %d) while building "
                "LevelArray" % (name, i, off))
        i += 1
    raise RuntimeError("ran off the end building LevelArray")


def main():
    swf = A.inflate(SWF)
    abc = A.ABC(A.find_abc(swf))
    ins = list(D.decode(abc.bodies[782]["code"]))
    locals_ = scan_locals(ins, abc)
    print("constructor string locals: %s" % locals_)

    levels = {}
    cur_mode = None
    cur_level = None
    i = 0
    while i < len(ins):
        off, name, args = ins[i]
        if name == "pushstring" and i and ins[i - 1][1] == "getlocal1":
            cur_mode = abc.strings[args[0]]
        elif name == "pushbyte" and i and ins[i - 1][1] == "getlocal2":
            cur_level = sbyte(args[0])
        elif name == "findproperty" and abc.name(args[0]) == "LevelArray":
            grid, i = build_array(ins, i, abc, locals_)
            key = "%s-%02d" % (cur_mode, cur_level)
            if key in levels:
                print("  warning: duplicate %s, keeping first" % key)
            else:
                levels[key] = grid
            continue
        i += 1

    os.makedirs(OUT, exist_ok=True)
    widths = set()
    print("recovered %d level grids\n" % len(levels))
    print("  %-14s %6s %6s  %s" % ("key", "rows", "cols", "distinct values"))
    for key in sorted(levels):
        g = levels[key]
        rows = len(g)
        cols = sorted({len(r) for r in g})
        widths.update(cols)
        vals = sorted({v for r in g for v in r}, key=lambda x: (x is None, isinstance(x, str), x if x is not None else 0))
        print("  %-14s %6d %6s  %d  %s" %
              (key, rows, ",".join(map(str, cols)), len(vals),
               vals if len(vals) <= 14 else "%s..%s" % (vals[:12], vals[-2:])))
        with open(os.path.join(OUT, key + ".json"), "w") as f:
            json.dump({"mode": key.rsplit("-", 1)[0],
                       "level": int(key.rsplit("-", 1)[1]),
                       "rows": rows, "cols": cols[0] if len(cols) == 1 else cols,
                       "grid": g}, f)

    allvals = sorted({v for g in levels.values() for r in g for v in r}, key=lambda x: (x is None, isinstance(x, str), x if x is not None else 0))
    print("\nrow widths seen across all levels: %s" % sorted(widths))
    print("global distinct tile values (%d): %s" % (len(allvals), allvals))
    print("\nwrote %d files to %s" % (len(levels), os.path.abspath(OUT)))


if __name__ == "__main__":
    main()
