"""AVM2 (ActionScript 3) bytecode disassembler.

Operand shapes only -- enough to walk an instruction stream accurately and
recover literal data. Not a decompiler.
"""
from swfabc import u30, s24

U = "u30"
B = "u8"
S = "s24"

OPS = {
    0x01: ("bkpt", []), 0x02: ("nop", []), 0x03: ("throw", []),
    0x04: ("getsuper", [U]), 0x05: ("setsuper", [U]), 0x06: ("dxns", [U]),
    0x07: ("dxnslate", []), 0x08: ("kill", [U]), 0x09: ("label", []),
    0x0C: ("ifnlt", [S]), 0x0D: ("ifnle", [S]), 0x0E: ("ifngt", [S]),
    0x0F: ("ifnge", [S]), 0x10: ("jump", [S]), 0x11: ("iftrue", [S]),
    0x12: ("iffalse", [S]), 0x13: ("ifeq", [S]), 0x14: ("ifne", [S]),
    0x15: ("iflt", [S]), 0x16: ("ifle", [S]), 0x17: ("ifgt", [S]),
    0x18: ("ifge", [S]), 0x19: ("ifstricteq", [S]), 0x1A: ("ifstrictne", [S]),
    0x1B: ("lookupswitch", ["switch"]),
    0x1C: ("pushwith", []), 0x1D: ("popscope", []), 0x1E: ("nextname", []),
    0x1F: ("hasnext", []), 0x20: ("pushnull", []), 0x21: ("pushundefined", []),
    0x23: ("nextvalue", []), 0x24: ("pushbyte", [B]), 0x25: ("pushshort", [U]),
    0x26: ("pushtrue", []), 0x27: ("pushfalse", []), 0x28: ("pushnan", []),
    0x29: ("pop", []), 0x2A: ("dup", []), 0x2B: ("swap", []),
    0x2C: ("pushstring", [U]), 0x2D: ("pushint", [U]), 0x2E: ("pushuint", [U]),
    0x2F: ("pushdouble", [U]), 0x30: ("pushscope", []),
    0x31: ("pushnamespace", [U]), 0x32: ("hasnext2", [U, U]),
    0x40: ("newfunction", [U]), 0x41: ("call", [U]), 0x42: ("construct", [U]),
    0x43: ("callmethod", [U, U]), 0x44: ("callstatic", [U, U]),
    0x45: ("callsuper", [U, U]), 0x46: ("callproperty", [U, U]),
    0x47: ("returnvoid", []), 0x48: ("returnvalue", []),
    0x49: ("constructsuper", [U]), 0x4A: ("constructprop", [U, U]),
    0x4C: ("callproplex", [U, U]), 0x4E: ("callsupervoid", [U, U]),
    0x4F: ("callpropvoid", [U, U]), 0x53: ("applytype", [U]),
    0x55: ("newobject", [U]), 0x56: ("newarray", [U]),
    0x57: ("newactivation", []), 0x58: ("newclass", [U]),
    0x59: ("getdescendants", [U]), 0x5A: ("newcatch", [U]),
    0x5D: ("findpropstrict", [U]), 0x5E: ("findproperty", [U]),
    0x5F: ("finddef", [U]), 0x60: ("getlex", [U]), 0x61: ("setproperty", [U]),
    0x62: ("getlocal", [U]), 0x63: ("setlocal", [U]),
    0x64: ("getglobalscope", []), 0x65: ("getscopeobject", [B]),
    0x66: ("getproperty", [U]), 0x68: ("initproperty", [U]),
    0x6A: ("deleteproperty", [U]), 0x6C: ("getslot", [U]),
    0x6D: ("setslot", [U]), 0x6E: ("getglobalslot", [U]),
    0x6F: ("setglobalslot", [U]),
    0x70: ("convert_s", []), 0x71: ("esc_xelem", []), 0x72: ("esc_xattr", []),
    0x73: ("convert_i", []), 0x74: ("convert_u", []), 0x75: ("convert_d", []),
    0x76: ("convert_b", []), 0x77: ("convert_o", []), 0x78: ("checkfilter", []),
    0x80: ("coerce", [U]), 0x82: ("coerce_a", []), 0x85: ("coerce_s", []),
    0x86: ("astype", [U]), 0x87: ("astypelate", []),
    0x90: ("negate", []), 0x91: ("increment", []), 0x92: ("inclocal", [U]),
    0x93: ("decrement", []), 0x94: ("declocal", [U]), 0x95: ("typeof", []),
    0x96: ("not", []), 0x97: ("bitnot", []),
    0xA0: ("add", []), 0xA1: ("subtract", []), 0xA2: ("multiply", []),
    0xA3: ("divide", []), 0xA4: ("modulo", []), 0xA5: ("lshift", []),
    0xA6: ("rshift", []), 0xA7: ("urshift", []), 0xA8: ("bitand", []),
    0xA9: ("bitor", []), 0xAA: ("bitxor", []), 0xAB: ("equals", []),
    0xAC: ("strictequals", []), 0xAD: ("lessthan", []), 0xAE: ("lessequals", []),
    0xAF: ("greaterthan", []), 0xB0: ("greaterequals", []),
    0xB1: ("instanceof", []), 0xB2: ("istype", [U]), 0xB3: ("istypelate", []),
    0xB4: ("in", []),
    0xC0: ("increment_i", []), 0xC1: ("decrement_i", []),
    0xC2: ("inclocal_i", [U]), 0xC3: ("declocal_i", [U]),
    0xC4: ("negate_i", []), 0xC5: ("add_i", []), 0xC6: ("subtract_i", []),
    0xC7: ("multiply_i", []),
    0xD0: ("getlocal0", []), 0xD1: ("getlocal1", []), 0xD2: ("getlocal2", []),
    0xD3: ("getlocal3", []), 0xD4: ("setlocal0", []), 0xD5: ("setlocal1", []),
    0xD6: ("setlocal2", []), 0xD7: ("setlocal3", []),
    0xEF: ("debug", ["debug"]), 0xF0: ("debugline", [U]),
    0xF1: ("debugfile", [U]), 0xF2: ("bkptline", [U]), 0xF3: ("timestamp", []),
}


def decode(code):
    """Yield (offset, opcode_name, [operands]) for a method body."""
    p = 0
    n = len(code)
    while p < n:
        start = p
        op = code[p]
        p += 1
        name, shape = OPS.get(op, ("unknown_%02X" % op, []))
        args = []
        for kind in shape:
            if kind == U:
                v, p = u30(code, p)
                args.append(v)
            elif kind == B:
                args.append(code[p])
                p += 1
            elif kind == S:
                args.append(s24(code, p))
                p += 3
            elif kind == "switch":
                args.append(s24(code, p))
                p += 3
                cnt, p = u30(code, p)
                cases = []
                for _ in range(cnt + 1):
                    cases.append(s24(code, p))
                    p += 3
                args.append(cases)
            elif kind == "debug":
                p += 1
                _, p = u30(code, p)
                p += 1
                _, p = u30(code, p)
        yield start, name, args


def fmt(abc, name, args):
    """Render operands, resolving pool references where useful."""
    if name == "pushbyte":
        v = args[0]
        return "%d" % (v - 256 if v > 127 else v)
    if name == "pushstring":
        return repr(abc.strings[args[0]]) if args[0] < len(abc.strings) else "?"
    if name == "pushint":
        return str(abc.ints[args[0]]) if args[0] < len(abc.ints) else "?"
    if name == "pushdouble":
        return str(abc.doubles[args[0]]) if args[0] < len(abc.doubles) else "?"
    if name in ("getlex", "findpropstrict", "findproperty", "getproperty",
                "setproperty", "initproperty", "coerce", "astype", "istype",
                "getsuper", "setsuper", "deleteproperty", "finddef"):
        return abc.name(args[0])
    if name in ("callproperty", "callpropvoid", "callproplex", "constructprop",
                "callsuper", "callsupervoid"):
        return "%s (%d args)" % (abc.name(args[0]), args[1])
    return " ".join(str(a) for a in args)
