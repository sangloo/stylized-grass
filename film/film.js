// A deterministic film of the article's production meadow, cut to 120 BPM.
const nativeRAF = window.requestAnimationFrame.bind(window);
const nativeCancelRAF = window.cancelAnimationFrame.bind(window);
let sequence = 0,
  fieldFrame;
const callbacks = new Map();
window.requestAnimationFrame = (fn) => {
  if (!fieldFrame && fn.name === "frame") fieldFrame = fn;
  if (fn !== fieldFrame) return nativeRAF(fn);
  callbacks.set(--sequence, fn);
  return sequence;
};
window.cancelAnimationFrame = (id) =>
  id < 0 ? callbacks.delete(id) : nativeCancelRAF(id);

const { mountField } = await import("../src/mount.js");
const { SKY } = await import("../src/meadow/dusk-sky.js");

const {
  BEAT,
  DURATION: duration,
  TITLE,
  TYPE_AT,
  URL_AT,
  STROKE,
  GROWTH_STEPS,
  DAY_TICKS,
  MONTAGE,
  CUTS,
  clamp01,
  lerp,
  outExpo,
  outCubic,
  outBack,
  inOut,
  ticks,
  hit,
  cue,
  windSwell,
  windAt,
  clockSpeed,
} = await import("./timeline.js");

const query = new URLSearchParams(location.search);
document.documentElement.dataset.clean = String(query.has("clean"));
const field = mountField(document.querySelector("#field"), {
  seed: 7,
  blades: 160000,
  exactBladeCount: true,
  inspectClumps: true,
  flowers: false,
  paper: "#faf8f2",
});
const { THREE, uniforms: u } = field;
field.ground.visible = false;
const blades = field.blades;
const roots = blades.geo.getAttribute("iPos");
const p = blades.geo.getAttribute("iParams");
const delays = blades.geo.getAttribute("iDelay");
const baseWidths = Float32Array.from({ length: blades.count }, (_, i) => p.getY(i));

/* ---- where it starts ------------------------------------------------------
   One intact production clump near the middle is the seed; the meadow grows
   out of it. Delays are logarithmic in distance, so a camera pulling back in
   proportion keeps the growing edge at the same place in the frame. */
const clump = blades.clumps
  .filter((c) => c.kind === "puff" && c.count >= 20)
  .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
const origin = clump ? { x: clump.x, z: clump.z } : { x: 0, z: 0 };
const rooted = (i) => roots.getY(i) <= 0.05;
let reach = 1;
for (let i = 0; i < blades.count; i++)
  if (rooted(i))
    reach = Math.max(
      reach,
      Math.hypot(roots.getX(i) - origin.x, roots.getZ(i) - origin.z),
    );
const GROW_SPAN = 2.4;
const R0 = 1.2;
const spread = (d) => Math.log(1 + d / R0) / Math.log(1 + reach / R0);
for (let i = 0; i < blades.count; i++) {
  const d = Math.hypot(roots.getX(i) - origin.x, roots.getZ(i) - origin.z);
  const jitter = (Math.sin(i * 12.9898) * 43758.5453) % 1;
  // Loose decorative leaves are not part of this grass-only recording.
  delays.setX(i, rooted(i) ? GROW_SPAN * spread(d) + Math.abs(jitter) * 0.06 : 99);
}
delays.needsUpdate = true;

/* ---- the looks --------------------------------------------------------------
   Nothing here is invented for the film. Day, dusk and night are the blog's
   own sunset (`src/meadow/dusk-sky.js`, with the three papers from the site's
   stylesheet); February, May and October are the season ring from the blog's
   lab. */
const PAPER = { day: "#faf8f2", dusk: "#f6e3c4", night: "#14181c" };
const SEASONS = {
  february: {
    grass: "#7e8470",
    pale: "#a7a892",
    deep: "#20303a",
    warm: "#8e6a4e",
    cold: "#c6cbc4",
  },
  may: {
    grass: "#7fae4c",
    pale: "#a8c579",
    deep: "#093a3a",
    warm: "#e0552a",
    cold: "#c3c58c",
  },
  october: {
    grass: "#a08a3c",
    pale: "#c8ac60",
    deep: "#33231f",
    warm: "#b84a12",
    cold: "#cbb98a",
  },
};
const COLOURS = ["grass", "pale", "deep", "warm", "cold", "paper"];
const NUMBERS = ["sunHeight", "sunAmount", "sunEdge", "shadow", "shadowSoft"];
const looks = Object.fromEntries(
  Object.entries({
    day: { ...SKY.day, paper: PAPER.day },
    dusk: { ...SKY.dusk, paper: PAPER.dusk },
    night: { ...SKY.night, paper: PAPER.night },
    ...Object.fromEntries(
      Object.entries(SEASONS).map(([k, v]) => [
        k,
        { ...SKY.day, ...v, paper: PAPER.day },
      ]),
    ),
  }).map(([k, v]) => [
    k,
    {
      ...Object.fromEntries(NUMBERS.map((n) => [n, v[n]])),
      ...Object.fromEntries(COLOURS.map((c) => [c, new THREE.Color(v[c])])),
    },
  ]),
);

const deg = Math.PI / 180;

/* ---- the wind's clock ------------------------------------------------------
   Integrated ahead of time, so any frame can be sought directly. */
const CLOCK_STEP = 1 / 600;
const clock = new Float32Array(Math.ceil(duration / CLOCK_STEP) + 2);
for (let i = 1; i < clock.length; i++)
  clock[i] = clock[i - 1] + clockSpeed((i - 0.5) * CLOCK_STEP) * CLOCK_STEP;
const clockAt = (t) => {
  const x = t / CLOCK_STEP,
    i = Math.floor(x);
  return lerp(clock[i], clock[i + 1], x - i);
};

/* ---- the camera -------------------------------------------------------------
   The wind blows along a fixed world direction — changing it would reshuffle
   the gust pattern — so the turntable is planned backwards to face across it
   in the finale, where a lean reads as a silhouette. */
const WIND = new THREE.Vector2(0.93, 0.37).normalize();
const WIND_AZ = Math.atan2(WIND.y, WIND.x) / deg + 90;
const DETENT = 15;
const START_AZ = WIND_AZ - 4 - 30 - DETENT * (DAY_TICKS + MONTAGE.length);
const WIND_FRUSTUM = 10;
const END_FRUSTUM = 22;
const END_Y = 5.7;

function growth(t) {
  const s =
    0.72 * (ticks(t, 0, GROWTH_STEPS, BEAT, 0.34) / GROWTH_STEPS) +
    0.28 * clamp01(t / 6);
  const grow = lerp(0.22, GROW_SPAN + 0.45, s);
  const front = R0 * (Math.pow(1 + reach / R0, clamp01((grow - 0.16) / GROW_SPAN)) - 1);
  const raw = 2 * front + 1;
  const frustum = raw < 18 ? raw : 18 + 6 * (1 - Math.exp(-(raw - 18) / 6));
  return { s, grow, frustum, k: clamp01((frustum - 1) / (24 - 1)) };
}

function camera(t, g) {
  let azimuth = START_AZ + 30 * (ticks(t, 0, GROWTH_STEPS, BEAT, 0.34) / GROWTH_STEPS);
  azimuth += DETENT * ticks(t, 6, DAY_TICKS, 1, 0.45, outBack);
  for (const at of MONTAGE) azimuth += DETENT * outExpo((t - at) / 0.18);
  azimuth += 8 * clamp01((t - 22) / 6) + 6 * inOut((t - 28) / 6);

  let frustum, elevation, y, x, z;
  if (t < 6) {
    frustum = g.frustum;
    elevation = lerp(7, 22, inOut(g.k));
    y = lerp(0.2, 1, g.k);
    x = lerp(origin.x, 0, g.k);
    z = lerp(origin.z, 0, g.k);
  } else {
    x = z = 0;
    frustum = cue(t, [
      [6, 24],
      [18, 20, 0.2, outExpo],
      [19, 26, 0.2, outExpo],
      [20, 18, 0.15, outExpo],
      [20.5, 25, 0.15, outExpo],
      [21, 19, 0.15, outExpo],
      [21.5, 27, 0.15, outExpo],
      [22, WIND_FRUSTUM, 0.9],
      [26.6, END_FRUSTUM, 2.4, inOut],
    ]);
    // A slow push through each held look, thrown back out on the cut.
    if (t < 18) {
      const held = (t - 6) % 4;
      frustum -= 2.2 * (held / 4) + (t >= 10 ? 2.2 * (1 - outExpo(held / 0.35)) : 0);
    }
    frustum -= 1 * clamp01((t - 22.9) / 3.7) * (1 - inOut((t - 26.6) / 2.4));
    elevation = cue(t, [
      [6, 22],
      [10, 17, 0.4],
      [14, 27, 0.4],
      [18, 16, 0.2, outExpo],
      [19, 30, 0.2, outExpo],
      [20, 14, 0.15, outExpo],
      [20.5, 26, 0.15, outExpo],
      [21, 18, 0.15, outExpo],
      [21.5, 32, 0.15, outExpo],
      [22, 11, 0.9],
      [26.6, 15.5, 2.4, inOut],
    ]);
    y = cue(t, [
      [6, 1],
      [22, 0.35, 0.9],
      [26.6, END_Y, 2.4, inOut],
    ]);
  }
  // Every cut lands with a small punch in.
  let kick = 0;
  for (const [at] of CUTS) if (at > 0) kick = Math.max(kick, hit(t, at, 0.28));
  frustum *= 1 - 0.045 * kick;
  return { azimuth, frustum, elevation, x, y, z };
}

/* ---- the title ---------------------------------------------------------------
   Typed in the way the home page types its own: one letter at a time behind a
   red caret, the line's width reserved so nothing shifts. */
const byId = (id) => document.getElementById(id);
const title = byId("title");
const caret = title.querySelector(".caret");
const letters = [...TITLE].map((c) => {
  const span = document.createElement("span");
  span.textContent = c;
  title.append(span);
  return span;
});

const look = {};
for (const k of COLOURS) look[k] = new THREE.Color();
let now = 0;
const origin0 = performance.now();
field.onFrame(() => {
  u.uTime.value = clockAt(now);
});

function seek(time) {
  now = Math.max(0, Math.min(duration, time));
  const t = now;
  field.ground.visible = false;

  /* growth, and width that arrives with height */
  const g = growth(t);
  u.uGrow.value = g.grow;
  for (let i = 0; i < blades.count; i++) {
    const k = clamp01((g.grow - delays.getX(i)) / 0.32);
    p.setY(i, baseWidths[i] * Math.sqrt(k * k * (3 - 2 * k)));
  }
  p.needsUpdate = true;

  /* the look */
  for (const k of COLOURS) look[k].copy(looks[CUTS[0][1]][k]);
  const numbers = Object.fromEntries(NUMBERS.map((n) => [n, looks.day[n]]));
  for (const [at, name, fade] of CUTS) {
    if (t < at) break;
    const k = fade ? outCubic((t - at) / fade) : 1;
    for (const c of COLOURS) look[c].lerp(looks[name][c], k);
    for (const n of NUMBERS) numbers[n] = lerp(numbers[n], looks[name][n], k);
  }
  u.uGrass.value.copy(look.grass);
  u.uGrassPale.value.copy(look.pale);
  u.uGrassDeep.value.copy(look.deep);
  u.uWarm.value.copy(look.warm);
  u.uCold.value.copy(look.cold);
  document.body.style.background = "#" + look.paper.getHexString();
  field.sky.sunHeight = numbers.sunHeight;
  u.uSunAmount.value = numbers.sunAmount;
  u.uSunEdge.value = numbers.sunEdge;
  u.uShadowAmount.value = numbers.shadow;
  u.uShadowSoft.value = numbers.shadowSoft;

  /* the home page's field settings */
  u.uWidth.value = 0.47;
  u.uCrop.value = 1;
  u.uVary.value = 0.69;
  u.uPatch.value = 1;
  u.uGrassDepth.value = lerp(0.36, 0.63, g.k);
  u.uHills.value = 0.6 * g.s;
  u.uInkAmount.value = 0;
  u.uDensity.value = 1.14;
  u.uCullPad.value.set(2, 2);

  /* the wind */
  u.uWindDir.value.copy(WIND);
  u.uGust.value = lerp(0.85, 1.1, windSwell(t));
  u.uWind.value = windAt(t);

  /* the camera */
  const cam = camera(t, g);
  field.rig.frustum = cam.frustum;
  field.rig.home.set(cam.x, cam.y, cam.z);
  field.rig.orbit(cam.azimuth * deg, cam.elevation * deg);
  field.rig.place();

  /* the title */
  const typed = Math.max(
    0,
    Math.min(letters.length, Math.floor((t - TYPE_AT) / STROKE) + 1),
  );
  letters.forEach((l, i) => l.classList.toggle("on", i < typed));
  const last = letters[typed - 1];
  caret.style.left = `${last ? last.offsetLeft + last.offsetWidth : letters[0].offsetLeft}px`;
  const typing = t < TYPE_AT + letters.length * STROKE;
  const blink = Math.floor((t - TYPE_AT - letters.length * STROKE) / 0.44) % 2 === 0;
  caret.style.opacity = t >= TYPE_AT - BEAT && (typing || blink) ? 1 : 0;
  byId("url").style.opacity = outCubic((t - URL_AT) / 0.35);

  const batch = [...callbacks.values()];
  callbacks.clear();
  for (const callback of batch) callback(origin0 + t * 1000);
  return {
    time: t,
    ground: field.ground.visible,
    grow: g.grow,
    wind: u.uWind.value,
    frustum: cam.frustum,
    azimuth: cam.azimuth,
  };
}

await document.fonts.load("400 48px Fraunces");
await document.fonts.load("400 16px Geist");
await document.fonts.ready;
seek(Number(query.get("time") ?? 0));
window.film = { duration, seek, field, ready: true };
if (!query.has("capture")) {
  let start = performance.now();
  let playing = true;
  const tick = (n) => {
    if (playing) seek(((n - start) / 1000) % duration);
    nativeRAF(tick);
  };
  nativeRAF(tick);
  addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      playing = !playing;
      start = performance.now() - now * 1000;
    }
    if (e.code === "KeyR") {
      start = performance.now();
      seek(0);
    }
  });
}
