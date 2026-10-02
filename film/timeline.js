/* The film's timing, shared by the picture (`film.js`, in the browser) and the
   sound (`sfx.mjs`, in Node), so a hit can never drift from the frame it is for.

   Everything lands on a 120 BPM grid: a beat is half a second, a bar two.
   Growth steps, turntable detents, palette cuts and gusts all fire on it, so a
   track at that tempo drops straight under the picture. */
export const BEAT = 0.5;
export const DURATION = 34;
export const TITLE = "Making stylized grass";
export const TYPE_AT = 28;
export const URL_AT = 30;
/** One letter per thirty-second note. */
export const STROKE = BEAT / 8;
/** The meadow grows in a step on each of these beats. */
export const GROWTH_STEPS = 12;
/** Turntable detents, one a second, from 6 s. */
export const DAY_TICKS = 12;
export const MONTAGE = [18, 19, 20, 20.5, 21, 21.5, 22];

/* [time, look, fade]. Long holds first, then the cuts come faster — a bar, a
   half bar, a beat — and the last one before the wind is a beat of night. */
export const CUTS = [
  [0, "day", 0],
  [10, "dusk", 0.35],
  [14, "night", 0.35],
  [18, "may", 0.2],
  [19, "october", 0.2],
  [20, "february", 0.15],
  [20.5, "may", 0.12],
  [21, "october", 0.12],
  [21.5, "night", 0.12],
  [22, "day", 0.22],
];

/* ---- easing ---------------------------------------------------------------- */
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const outExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(x)));
export const outCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
export const outBack = (x) => {
  x = clamp01(x) - 1;
  return 1 + 2.2 * x * x * x + 1.2 * x * x;
};
export const inOut = (x) => {
  x = clamp01(x);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** Steps taken by `t`, one per `every` from `start`, each an eased jump. */
export function ticks(t, start, n, every = BEAT, attack = 0.3, ease = outExpo) {
  const x = (t - start) / every;
  if (x <= 0) return 0;
  if (x >= n) return n;
  const i = Math.floor(x);
  return i + ease(((x - i) * every) / attack);
}
/** A hit: near-instant attack, exponential release. */
export function hit(t, at, release = 0.3) {
  const x = t - at;
  if (x < 0) return 0;
  return x < 0.05 ? x / 0.05 : Math.exp(-(x - 0.05) / release);
}
/** The most recent hit on every beat between `start` and `end`. */
export function beats(t, start, end, release) {
  if (t < start) return 0;
  const k = Math.min(Math.floor((t - start) / BEAT), (end - start) / BEAT - 1);
  return hit(t, start + k * BEAT, release);
}
/** Held values that change at a time, each easing over its own fade. */
export function cue(t, keys, ease = outCubic) {
  let v = keys[0][1];
  for (const [at, value, fade = 0, e = ease] of keys) {
    if (t < at) break;
    v = lerp(v, value, fade ? e((t - at) / fade) : 1);
  }
  return v;
}

/* ---- the wind ----------------------------------------------------------------
   How hard it blows, and how fast the shader's clock runs. The shader moves
   its gusts with `uTime`, so running that clock faster is what makes a gust
   travel; it surges on each beat of the finale. */
export const windSwell = (t) => clamp01((t - 22) / 1.2) * (1 - inOut((t - 26) / 2.5));
export const windAt = (t) =>
  cue(t, [
    [0, 0.3],
    [6, 0.55, 1],
    [10, 0.4, 0.4],
    [14, 0.28, 0.4],
    [18, 0.55, 0.2],
    [22, 1.2, 1.2],
    [24.5, 1.5, 1],
    [26.5, 0.5, 2.2, inOut],
  ]) +
  0.08 * beats(t, 6, 22, 0.25) +
  0.8 * windSwell(t) * beats(t, 22, 28, 0.32);
export const clockSpeed = (t) =>
  1 + windSwell(t) * (1.5 + 2 * beats(t, 22, 28, 0.32)) + 0.25 * beats(t, 6, 22, 0.25);
