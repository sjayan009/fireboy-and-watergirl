"""Minimal SWF / ABC (ActionScript 3 bytecode) reader.

Enough of the format to pull the constant pool, class list and method bodies
out of the Forest Temple SWF without needing a full decompiler.
"""
import zlib
import struct


def u30(b, p):
    r = s = 0
    while True:
        c = b[p]
        p += 1
        r |= (c & 0x7F) << s
        s += 7
        if not c & 0x80:
            return r, p


def s24(b, p):
    v = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)
    return v - 0x1000000 if v & 0x800000 else v


def inflate(path):
    d = open(path, "rb").read()
    if d[:3] == b"CWS":
        return zlib.decompress(d[8:])
    if d[:3] == b"FWS":
        return d[8:]
    raise ValueError("not a supported SWF: %r" % d[:3])


def tags(buf, start, end=None):
    i = start
    end = len(buf) if end is None else end
    while i < end - 1:
        th = struct.unpack("<H", buf[i:i + 2])[0]
        i += 2
        code = th >> 6
        ln = th & 0x3F
        if ln == 0x3F:
            ln = struct.unpack("<I", buf[i:i + 4])[0]
            i += 4
        yield code, i, ln
        if code == 0:
            return
        i += ln


def body_start(buf):
    return (5 + (buf[0] >> 3) * 4 + 7) // 8 + 4


def find_abc(buf):
    for code, s, ln in tags(buf, body_start(buf)):
        if code == 82:
            p = buf[s:s + ln]
            q = 4
            while p[q]:
                q += 1
            return p[q + 1:]
    raise ValueError("no DoABC tag")


def symbol_names(buf):
    """character id -> exported class name, from SymbolClass tags."""
    out = {}
    for code, s, ln in tags(buf, body_start(buf)):
        if code == 76:
            p = buf[s:s + ln]
            n = struct.unpack("<H", p[:2])[0]
            q = 2
            for _ in range(n):
                tid = struct.unpack("<H", p[q:q + 2])[0]
                q += 2
                e = p.index(b"\0", q)
                out[tid] = p[q:e].decode("utf8", "replace")
                q = e + 1
    return out


class ABC:
    def __init__(self, abc):
        self.raw = abc
        p = 4

        n, p = u30(abc, p)
        self.ints = [0]
        for _ in range(max(0, n - 1)):
            v, p = u30(abc, p)
            self.ints.append(v - (1 << 32) if v >= (1 << 31) else v)

        n, p = u30(abc, p)
        self.uints = [0]
        for _ in range(max(0, n - 1)):
            v, p = u30(abc, p)
            self.uints.append(v)

        n, p = u30(abc, p)
        self.doubles = [0.0]
        for _ in range(max(0, n - 1)):
            self.doubles.append(struct.unpack("<d", abc[p:p + 8])[0])
            p += 8

        n, p = u30(abc, p)
        self.strings = [""]
        for _ in range(max(0, n - 1)):
            l, p = u30(abc, p)
            self.strings.append(abc[p:p + l].decode("utf8", "replace"))
            p += l

        n, p = u30(abc, p)
        self.ns = [(0, 0)]
        for _ in range(max(0, n - 1)):
            k = abc[p]
            p += 1
            a, p = u30(abc, p)
            self.ns.append((k, a))

        n, p = u30(abc, p)
        self.nsset = [()]
        for _ in range(max(0, n - 1)):
            c, p = u30(abc, p)
            items = []
            for _ in range(c):
                v, p = u30(abc, p)
                items.append(v)
            self.nsset.append(tuple(items))

        n, p = u30(abc, p)
        self.mn = [None]
        for _ in range(max(0, n - 1)):
            k = abc[p]
            p += 1
            if k in (0x07, 0x0D, 0x09, 0x0E):
                a, p = u30(abc, p)
                b, p = u30(abc, p)
                self.mn.append((k, a, b))
            elif k in (0x0F, 0x10, 0x1B, 0x1C):
                a, p = u30(abc, p)
                self.mn.append((k, a, 0))
            elif k in (0x11, 0x12):
                self.mn.append((k, 0, 0))
            elif k == 0x1D:
                a, p = u30(abc, p)
                c, p = u30(abc, p)
                for _ in range(c):
                    _, p = u30(abc, p)
                self.mn.append((k, a, 0))
            else:
                self.mn.append((k, 0, 0))

        n, p = u30(abc, p)
        self.methods = []
        for _ in range(n):
            pc, p = u30(abc, p)
            rt, p = u30(abc, p)
            ptypes = []
            for _ in range(pc):
                t, p = u30(abc, p)
                ptypes.append(t)
            nn, p = u30(abc, p)
            fl = abc[p]
            p += 1
            if fl & 0x08:
                oc, p = u30(abc, p)
                for _ in range(oc):
                    _, p = u30(abc, p)
                    p += 1
            if fl & 0x80:
                for _ in range(pc):
                    _, p = u30(abc, p)
            self.methods.append({
                "name": self.strings[nn] if nn < len(self.strings) else "",
                "ret": rt,
                "params": ptypes,
            })

        n, p = u30(abc, p)
        for _ in range(n):
            _, p = u30(abc, p)
            ic, p = u30(abc, p)
            for _ in range(ic):
                _, p = u30(abc, p)
                _, p = u30(abc, p)

        nclass, p = u30(abc, p)
        self.instances = []
        for _ in range(nclass):
            nmi, p = u30(abc, p)
            sup, p = u30(abc, p)
            fl = abc[p]
            p += 1
            if fl & 0x08:
                _, p = u30(abc, p)
            ic, p = u30(abc, p)
            for _ in range(ic):
                _, p = u30(abc, p)
            iinit, p = u30(abc, p)
            p, tr = self._traits(p)
            self.instances.append({
                "name": self.name(nmi),
                "super": self.name(sup),
                "iinit": iinit,
                "traits": tr,
            })

        self.classes = []
        for _ in range(nclass):
            cinit, p = u30(abc, p)
            p, tr = self._traits(p)
            self.classes.append({"cinit": cinit, "traits": tr})

        n, p = u30(abc, p)
        self.scripts = []
        for _ in range(n):
            init, p = u30(abc, p)
            p, tr = self._traits(p)
            self.scripts.append({"init": init, "traits": tr})

        n, p = u30(abc, p)
        self.bodies = {}
        for _ in range(n):
            mi, p = u30(abc, p)
            ms, p = u30(abc, p)
            lc, p = u30(abc, p)
            _, p = u30(abc, p)
            _, p = u30(abc, p)
            cl, p = u30(abc, p)
            code = abc[p:p + cl]
            p += cl
            nex, p = u30(abc, p)
            for _ in range(nex):
                for _ in range(5):
                    _, p = u30(abc, p)
            p, tr = self._traits(p)
            self.bodies[mi] = {
                "code": code,
                "max_stack": ms,
                "local_count": lc,
                "traits": tr,
            }

    def _traits(self, p):
        abc = self.raw
        tc, p = u30(abc, p)
        out = []
        for _ in range(tc):
            ni, p = u30(abc, p)
            kind = abc[p]
            p += 1
            k = kind & 0x0F
            info = {"name": self.name(ni), "kind": k}
            if k in (0, 6):
                _, p = u30(abc, p)
                ti, p = u30(abc, p)
                vi, p = u30(abc, p)
                info["type"] = self.name(ti)
                if vi:
                    p += 1
            elif k in (1, 2, 3):
                _, p = u30(abc, p)
                mi, p = u30(abc, p)
                info["method"] = mi
            elif k in (4, 5):
                _, p = u30(abc, p)
                mi, p = u30(abc, p)
                info["method"] = mi
            if kind & 0x40:
                mc, p = u30(abc, p)
                for _ in range(mc):
                    _, p = u30(abc, p)
            out.append(info)
        return p, out

    def name(self, i):
        m = self.mn[i] if 0 < i < len(self.mn) else None
        if not m:
            return ""
        k, a, b = m
        if k in (0x07, 0x0D):
            nsi = self.ns[a][1] if a < len(self.ns) else 0
            pre = self.strings[nsi] if nsi < len(self.strings) else ""
            base = self.strings[b] if b < len(self.strings) else ""
            return "%s:%s" % (pre, base) if pre else base
        if k in (0x09, 0x0E, 0x1B, 0x1C, 0x0F, 0x10, 0x1D):
            return self.strings[a] if a < len(self.strings) else ""
        return ""
