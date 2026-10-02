// A synthesized sound pass, built from the film's own timeline. No samples and
// no music: every sound here is a few lines of arithmetic, placed on the frame
// it belongs to. Writes out/sfx.wav and muxes out/grass-film-sfx.mp4.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BEAT,
  CUTS,
  DAY_TICKS,
  DURATION,
  GROWTH_STEPS,
  MONTAGE,
  STROKE,
  TITLE,
  TYPE_AT,
  URL_AT,
  beats,
  clamp01,
  inOut,
  windAt,
  windSwell,
} from "./timeline.js";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "out");
const SR = 48000;
const N = Math.ceil(DURATION * SR);
const dry = [new Float32Array(N), new Float32Array(N)];
const send = [new Float32Array(N), new Float32Array(N)];

/* ---- plumbing ------------------------------------------------------------- */
let state = 0x2f6e2b1;
const rand = () => {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 4294967296;
};
const noise = () => rand() * 2 - 1;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
/** Equal-power pan, -1 left to 1 right. */
const pan = (p) => [
  Math.cos(((p + 1) * Math.PI) / 4),
  Math.sin(((p + 1) * Math.PI) / 4),
];

function put(i, v, p = 0, wet = 0) {
  if (i < 0 || i >= N) return;
  const [l, r] = pan(p);
  dry[0][i] += v * l;
  dry[1][i] += v * r;
  send[0][i] += v * l * wet;
  send[1][i] += v * r * wet;
}

/** RBJ biquad: "lp", "hp" or "bp" (0 dB peak). */
class Biquad {
  constructor(type, f, q = 0.707) {
    this.type = type;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(f, q);
  }
  set(f, q = this.q) {
    this.q = q;
    const w = (2 * Math.PI * Math.min(f, SR * 0.45)) / SR;
    const c = Math.cos(w);
    const a = Math.sin(w) / (2 * q);
    const a0 = 1 + a;
    let b0, b1, b2;
    if (this.type === "lp") [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
    else if (this.type === "hp") [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    else [b0, b1, b2] = [a, 0, -a];
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - a) / a0;
    return this;
  }
  run(x) {
    const y =
      this.b0 * x +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/* ---- the sounds ------------------------------------------------------------ */

/** A soft wooden mallet: three inharmonic partials, the upper ones short. */
function mallet(t0, f, gain, p = 0) {
  const start = Math.round(t0 * SR);
  const partials = [
    [1, 1, 0.34],
    [3.98, 0.28, 0.07],
    [9.1, 0.06, 0.02],
  ];
  for (let n = 0; n < 1.2 * SR; n++) {
    const t = n / SR;
    let v = 0;
    for (const [ratio, amp, tau] of partials)
      v += amp * Math.sin(2 * Math.PI * f * ratio * t) * Math.exp(-t / tau);
    put(start + n, v * gain * Math.min(1, t / 0.002), p, 0.3);
  }
}

/** Leaves: band-passed noise broken into grains. */
function rustle(t0, dur, gain, p = 0, fc = 4200) {
  const start = Math.round(t0 * SR);
  const bp = new Biquad("bp", fc, 0.9);
  let grain = 0;
  for (let n = 0; n < dur * SR * 2.5; n++) {
    const t = n / SR;
    if (n % 120 === 0) grain = 0.35 + 0.65 * rand();
    const env = (1 - Math.exp(-t / 0.01)) * Math.exp(-t / (dur * 0.4));
    put(start + n, bp.run(noise()) * env * grain * gain, p, 0.15);
  }
}

/** A soft thump: a sine falling in pitch, and a 2 ms click on the front. */
function thump(t0, gain, f0 = 105, f1 = 44, decay = 0.3) {
  const start = Math.round(t0 * SR);
  let phase = 0;
  for (let n = 0; n < decay * 6 * SR; n++) {
    const t = n / SR;
    phase += (2 * Math.PI * (f1 + (f0 - f1) * Math.exp(-t / 0.035))) / SR;
    const click = t < 0.002 ? noise() * 0.25 * (1 - t / 0.002) : 0;
    put(start + n, (Math.sin(phase) * Math.exp(-t / decay) + click) * gain, 0, 0.08);
  }
}

/** Air rushing into a cut: noise whose band rises and grows, stopping on it. */
function whoosh(at, dur, gain, from = -0.4, to = 0.4) {
  const start = Math.round((at - dur) * SR);
  const bp = new Biquad("bp", 300, 0.7);
  const total = Math.round((dur + 0.18) * SR);
  for (let n = 0; n < total; n++) {
    const t = n / SR;
    const k = Math.min(1, t / dur);
    if (n % 32 === 0) bp.set(300 * Math.pow(9, k), 0.7);
    const env = t < dur ? k * k : Math.exp(-(t - dur) / 0.05);
    put(start + n, bp.run(noise()) * env * gain, from + (to - from) * k, 0.25);
  }
}

/** A turntable detent: a dry, small click. */
function detent(t0, gain, p = 0) {
  const start = Math.round(t0 * SR);
  const hp = new Biquad("hp", 2500, 0.7);
  for (let n = 0; n < 0.05 * SR; n++) {
    const t = n / SR;
    const v =
      hp.run(noise()) * Math.exp(-t / 0.0025) +
      0.5 * Math.sin(2 * Math.PI * 2300 * t) * Math.exp(-t / 0.008);
    put(start + n, v * gain, p, 0.05);
  }
}

/** One key: a bright tick over a low thock; the space bar is lower and longer. */
function key(t0, gain, p = 0, space = false) {
  const start = Math.round(t0 * SR);
  const bp = new Biquad("bp", 3000 + rand() * 900, 1.3);
  const thock = space ? 120 : 175 + rand() * 30;
  for (let n = 0; n < 0.08 * SR; n++) {
    const t = n / SR;
    const v =
      bp.run(noise()) * Math.exp(-t / 0.005) * 1.4 +
      Math.sin(2 * Math.PI * thock * t) * Math.exp(-t / (space ? 0.03 : 0.016)) * 0.6;
    put(start + n, v * gain, p, 0.12);
  }
}

/** A soft bell, mostly reverb. */
function bell(t0, f, gain, p = 0) {
  const start = Math.round(t0 * SR);
  const partials = [
    [1, 1, 1.8],
    [2.0, 0.3, 0.9],
    [2.76, 0.18, 0.55],
    [5.4, 0.06, 0.2],
  ];
  for (let n = 0; n < 4 * SR; n++) {
    const t = n / SR;
    let v = 0;
    for (const [ratio, amp, tau] of partials)
      v += amp * Math.sin(2 * Math.PI * f * ratio * t) * Math.exp(-t / tau);
    put(start + n, v * gain * Math.min(1, t / 0.004), p, 0.55);
  }
}

/* ---- the wind ----------------------------------------------------------------
   One bed for the whole film, following the same curve as `uWind`: two
   decorrelated band-passed noises whose band opens as it blows harder, a thin
   whistle over the top in the finale, and leaves crackling in proportion.
   In the finale each beat's surge crosses left to right, as the gusts do on
   screen. */
function wind() {
  const bands = [new Biquad("bp", 300, 0.8), new Biquad("bp", 300, 0.8)];
  const lows = [new Biquad("lp", 900), new Biquad("lp", 900)];
  const whistle = [new Biquad("bp", 800, 9), new Biquad("bp", 800, 9)];
  const leaves = [new Biquad("hp", 3000), new Biquad("hp", 3000)];
  // Rounded off above 6.5 kHz, so the leaves rustle rather than click.
  const soften = [new Biquad("lp", 6500), new Biquad("lp", 6500)];
  const pink = [0, 0];
  const grains = [0, 0];
  let w = 0;
  let surge = 0;
  let across = 0;
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    if (n % 64 === 0) {
      w = windAt(t);
      surge = windSwell(t) * beats(t, 22, 28, 0.32);
      across = t >= 22 && t < 28 ? (((t - 22) % BEAT) / BEAT) * 1.4 - 0.7 : 0;
      for (let c = 0; c < 2; c++) {
        bands[c].set(240 + 520 * w + 900 * surge + c * 40, 0.8);
        whistle[c].set(620 + 380 * w + 500 * surge + c * 23, 9);
      }
    }
    const fade = clamp01(t / 0.6) * (1 - inOut((t - (DURATION - 2)) / 2));
    const level = (0.05 + 0.32 * Math.pow(w / 1.5, 1.5)) * fade;
    const [gl, gr] = pan(across * windSwell(t));
    for (let c = 0; c < 2; c++) {
      pink[c] = 0.97 * pink[c] + 0.03 * noise();
      const body = bands[c].run(lows[c].run(noise() * 0.5 + pink[c] * 6));
      const tone = whistle[c].run(noise()) * 0.35 * windSwell(t);
      // Kept far under the wind: density follows it, but capped, never squared.
      if (rand() < 0.0005 * Math.min(w, 1.5)) grains[c] = 0.6 + rand() * 0.4;
      grains[c] *= 0.9965;
      const crackle =
        soften[c].run(leaves[c].run(noise())) * grains[c] * 0.05 * Math.min(1, w);
      const v = (body + tone) * level + crackle * fade;
      const g = c === 0 ? gl : gr;
      dry[c][n] += v * g * 1.41;
      send[c][n] += v * g * 0.25;
    }
  }
}

/* ---- the score ------------------------------------------------------------------ */
wind();

// Growth: a mallet and a rustle on each step, climbing a D major pentatonic.
const climb = [57, 59, 62, 64, 66, 69, 71, 74, 76, 78, 81, 83];
for (let i = 0; i < GROWTH_STEPS; i++) {
  const t = i * BEAT;
  mallet(t, midi(climb[i]), 0.16 - i * 0.005, (i % 2 ? 1 : -1) * 0.25 * (i / 12));
  rustle(t, 0.22 + i * 0.02, 0.18 + i * 0.02, (rand() - 0.5) * 0.6);
}
// ...rising into the first full frame of meadow.
whoosh(GROWTH_STEPS * BEAT, 1.6, 0.22, -0.2, 0.2);
thump(GROWTH_STEPS * BEAT, 0.55);

// The turntable: a detent every second, a soft pulse on every bar.
for (let i = 0; i < DAY_TICKS; i++) detent(6 + i, 0.14, i % 2 ? 0.3 : -0.3);
for (let t = 8; t < 18; t += 2) thump(t, 0.28, 95, 46, 0.22);

// Cuts: air into each one and a thump on it, heavier for the big changes.
for (const [at, look] of CUTS) {
  if (at === 0) continue;
  const big = at === 10 || at === 14 || at === 22;
  whoosh(at, big ? 0.55 : 0.28, big ? 0.32 : 0.2, -0.5, 0.5);
  thump(at, big ? 0.7 : 0.45, look === "night" ? 80 : 110, look === "night" ? 36 : 44);
}
for (const at of MONTAGE) detent(at, 0.12, 0.4);
// The montage keeps the beat between its cuts.
for (let t = 18.5; t < 22; t += BEAT)
  if (!MONTAGE.includes(t)) thump(t, 0.3, 95, 46, 0.2);

// The wind: a pulse under every gust.
for (let t = 22 + BEAT; t < 28; t += BEAT)
  thump(t, 0.42 * windSwell(t + 0.01), 90, 40, 0.28);

// The title, one key per letter, then a bell as the address lands.
[...TITLE].forEach((c, i) =>
  key(
    TYPE_AT + i * STROKE,
    0.16 + rand() * 0.04,
    -0.25 + (i / TITLE.length) * 0.5,
    c === " ",
  ),
);
bell(URL_AT, midi(74), 0.16, -0.1);
bell(URL_AT + 0.07, midi(81), 0.09, 0.15);

/* ---- a small room ---------------------------------------------------------------
   Four combs and two all-passes per side, Schroeder's recipe, on the send. */
function room(input, offset) {
  const result = new Float32Array(N);
  const combs = [1557, 1617, 1491, 1422].map((d) => ({
    buf: new Float32Array(d + offset),
    i: 0,
    low: 0,
  }));
  const passes = [556, 441].map((d) => ({ buf: new Float32Array(d + offset), i: 0 }));
  for (let n = 0; n < N; n++) {
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.low = y * 0.75 + c.low * 0.25;
      c.buf[c.i] = input[n] + c.low * 0.8;
      c.i = (c.i + 1) % c.buf.length;
      s += y;
    }
    s *= 0.25;
    for (const a of passes) {
      const y = a.buf[a.i];
      a.buf[a.i] = s + y * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      s = y - s * 0.5;
    }
    result[n] = s;
  }
  return result;
}
const wet = [room(send[0], 0), room(send[1], 23)];

/* ---- master: high-pass, soft clip, peak at -1 dBFS -------------------------------- */
const mix = [new Float32Array(N), new Float32Array(N)];
let peak = 0;
for (let c = 0; c < 2; c++) {
  const hp = new Biquad("hp", 28);
  for (let n = 0; n < N; n++) {
    const v = Math.tanh(hp.run(dry[c][n] + wet[c][n] * 0.6) * 1.2) / 1.2;
    mix[c][n] = v;
    peak = Math.max(peak, Math.abs(v));
  }
}
const scale = Math.pow(10, -1 / 20) / peak;

/* 32-bit float WAV */
const bytes = Buffer.alloc(44 + N * 8);
bytes.write("RIFF", 0);
bytes.writeUInt32LE(36 + N * 8, 4);
bytes.write("WAVEfmt ", 8);
bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(3, 20);
bytes.writeUInt16LE(2, 22);
bytes.writeUInt32LE(SR, 24);
bytes.writeUInt32LE(SR * 8, 28);
bytes.writeUInt16LE(8, 32);
bytes.writeUInt16LE(32, 34);
bytes.write("data", 36);
bytes.writeUInt32LE(N * 8, 40);
for (let n = 0; n < N; n++) {
  bytes.writeFloatLE(mix[0][n] * scale, 44 + n * 8);
  bytes.writeFloatLE(mix[1][n] * scale, 48 + n * 8);
}
await mkdir(out, { recursive: true });
const wav = resolve(out, "sfx.wav");
await writeFile(wav, bytes);
console.log(wav);

const film = resolve(out, "grass-film.mp4");
if (!existsSync(film)) throw new Error("Render the film first: npm run film");
const output = resolve(out, "grass-film-sfx.mp4");
const ffmpeg = spawn(
  "ffmpeg",
  [
    ["-y", "-hide_banner", "-loglevel", "error"],
    ["-i", film, "-i", wav],
    ["-map", "0:v", "-map", "1:a", "-c:v", "copy"],
    ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output],
  ].flat(),
  { stdio: "inherit" },
);
const [code] = await once(ffmpeg, "close");
if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
console.log(output);
