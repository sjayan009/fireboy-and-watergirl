/**
 * Deterministic sin / cos / atan2.
 *
 * ECMAScript specifies `Math.sin`, `Math.cos` and `Math.atan2` only as
 * "implementation-approximated": V8, SpiderMonkey and JavaScriptCore are each
 * free to return a different last-ulp result. For lockstep netcode that is
 * fatal -- two peers on different browsers would diverge within seconds.
 *
 * These implementations use nothing but +, -, * and /, which IEEE-754 defines
 * as correctly rounded, so every engine produces bit-identical output. The
 * algorithms and coefficients are fdlibm's, the same ones V8 itself uses.
 *
 * `Math.sqrt` is left alone deliberately: IEEE-754 requires it to be correctly
 * rounded, and ECMAScript mandates that, so it is already deterministic.
 */

// pi/2 split into three parts so argument reduction stays exact in double
// precision (Cody-Waite).
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const INV_PIO2 = 6.36619772367581382433e-01;

// fdlibm __kernel_sin
const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

// fdlibm __kernel_cos
const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

function kernelSin(x: number, y: number, iy: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

function kernelCos(x: number, y: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z;
  const w = 1.0 - hz;
  return w + (((1.0 - w) - hz) + (z * r - x * y));
}

/**
 * Reduce x to y0 + y1 in [-pi/4, pi/4], returning the quadrant n such that
 * x is approximately n*(pi/2) + y0 + y1. Medium-size reduction only: it stays
 * exact for the angles a physics body actually reaches, and for very large
 * inputs it degrades identically on every engine, which is what matters here.
 */
function reduce(x: number, out: [number, number]): number {
  let n = Math.round(x * INV_PIO2);
  let r = x - n * PIO2_1;
  let w = n * PIO2_1T;
  let y0 = r - w;
  // one refinement step for large n, where the first split loses bits
  if (n > 32000000 || n < -32000000) {
    const t = r;
    w = n * PIO2_2;
    r = t - w;
    w = n * PIO2_2T - ((t - r) - w);
    y0 = r - w;
  }
  out[0] = y0;
  out[1] = (r - y0) - w;
  return n | 0;
}

const scratch: [number, number] = [0, 0];

export function detSin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (x >= -0.7853981633974483 && x <= 0.7853981633974483) {
    return kernelSin(x, 0, 0);
  }
  const n = reduce(x, scratch);
  const y0 = scratch[0];
  const y1 = scratch[1];
  switch (n & 3) {
    case 0: return kernelSin(y0, y1, 1);
    case 1: return kernelCos(y0, y1);
    case 2: return -kernelSin(y0, y1, 1);
    default: return -kernelCos(y0, y1);
  }
}

export function detCos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (x >= -0.7853981633974483 && x <= 0.7853981633974483) {
    return kernelCos(x, 0);
  }
  const n = reduce(x, scratch);
  const y0 = scratch[0];
  const y1 = scratch[1];
  switch (n & 3) {
    case 0: return kernelCos(y0, y1);
    case 1: return -kernelSin(y0, y1, 1);
    case 2: return -kernelCos(y0, y1);
    default: return kernelSin(y0, y1, 1);
  }
}

// fdlibm atan
const aT0 = 3.33333333333329318027e-01;
const aT1 = -1.99999999998764832476e-01;
const aT2 = 1.42857142725034663711e-01;
const aT3 = -1.11111104054623557880e-01;
const aT4 = 9.09088713343650656196e-02;
const aT5 = -7.69187620504482999495e-02;
const aT6 = 6.66107313738753120669e-02;
const aT7 = -5.83357013379057348645e-02;
const aT8 = 4.97687799461593236017e-02;
const aT9 = -3.65315727442169155270e-02;
const aT10 = 1.62858201153657823623e-02;

const ATAN_HI = [
  4.63647609000806093515e-01, 7.85398163397448278999e-01,
  9.82793723247329054082e-01, 1.57079632679489655800e+00,
];
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17,
  1.39033110312309984516e-17, 6.12323399573676603587e-17,
];

export function detAtan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const neg = x < 0;
  let ax = neg ? -x : x;
  if (!Number.isFinite(ax)) return neg ? -1.5707963267948966 : 1.5707963267948966;

  let id: number;
  if (ax < 0.4375) {
    id = -1;
  } else if (ax < 1.1875) {
    if (ax < 0.6875) {
      id = 0;
      ax = (2.0 * ax - 1.0) / (2.0 + ax);
    } else {
      id = 1;
      ax = (ax - 1.0) / (ax + 1.0);
    }
  } else if (ax < 2.4375) {
    id = 2;
    ax = (ax - 1.5) / (1.0 + 1.5 * ax);
  } else {
    id = 3;
    ax = -1.0 / ax;
  }

  const z = ax * ax;
  const w = z * z;
  const s1 = z * (aT0 + w * (aT2 + w * (aT4 + w * (aT6 + w * (aT8 + w * aT10)))));
  const s2 = w * (aT1 + w * (aT3 + w * (aT5 + w * (aT7 + w * aT9))));
  if (id < 0) {
    const r = ax - ax * (s1 + s2);
    return neg ? -r : r;
  }
  const r = ATAN_HI[id] - ((ax * (s1 + s2) - ATAN_LO[id]) - ax);
  return neg ? -r : r;
}

const PI = 3.141592653589793;
const PI_LO = 1.2246467991473531772e-16;

export function detAtan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (y === 0) {
    // preserve the sign conventions of Math.atan2
    return (x > 0 || Object.is(x, 0)) ? y : (Object.is(y, -0) ? -PI : PI);
  }
  if (x === 0) return y > 0 ? PI / 2 : -PI / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    if (!Number.isFinite(x) && !Number.isFinite(y)) {
      const q = x > 0 ? PI / 4 : (3 * PI) / 4;
      return y > 0 ? q : -q;
    }
    if (!Number.isFinite(y)) return y > 0 ? PI / 2 : -PI / 2;
    return x > 0 ? (y > 0 ? 0 : -0) : (y > 0 ? PI : -PI);
  }

  const z = detAtan(y / x);
  if (x > 0) return z;
  return y > 0 ? z + (PI - PI_LO) + PI_LO : z - (PI - PI_LO) - PI_LO;
}

/**
 * Deterministic acos.
 *
 * `level.as` feeds this straight into `SetXForm`, so the result is a *physics
 * body angle* -- it lands in the state digest and a one-ulp disagreement
 * between engines is a genuine desync, not a cosmetic one.
 *
 * Built on the identity acos(x) = atan2(sqrt(1 - x^2), x), which reuses the
 * already-verified detAtan2 rather than adding a second polynomial to trust.
 * The radicand is written as (1-x)*(1+x) instead of 1-x*x because the latter
 * cancels catastrophically as |x| approaches 1, which is exactly where the
 * CreatRoman call sites sit.
 */
export function detAcos(x: number): number {
  if (Number.isNaN(x)) return NaN;
  // Math.acos returns NaN outside [-1, 1]; match it rather than silently
  // clamping, so a bad argument surfaces instead of becoming a wrong angle.
  if (x < -1 || x > 1) return NaN;
  if (x === 1) return 0;
  if (x === -1) return PI;
  return detAtan2(Math.sqrt((1 - x) * (1 + x)), x);
}

/**
 * Deterministic pow, for the integer exponents the game actually uses.
 *
 * Every call site in the port is `pow(x, 2)`. Repeated multiplication is
 * exactly rounded by IEEE-754 and therefore identical on every engine, whereas
 * `Math.pow` is implementation-approximated like the trig functions. Anything
 * that is not a small non-negative integer exponent falls through to
 * `Math.pow` -- if that ever starts happening on a hashed path it needs its
 * own treatment, so it is worth knowing about.
 */
export function detPow(a: number, b: number): number {
  if (Number.isInteger(b) && b >= 0 && b <= 8) {
    let r = 1;
    for (let i = 0; i < b; i++) r *= a;
    return r;
  }
  return Math.pow(a, b);
}
