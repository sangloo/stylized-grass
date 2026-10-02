/* ---------------------------------------------------------------------------
 * meadow.js — the grass, and everything that grows in it.
 *
 * The pen-and-wash isometric meadow: the ground, its inked rim, the blades,
 * the specks down among them and the flower heads on top. Nothing in here
 * knows what page it is on. It takes a renderer-shaped world and hands back
 * THREE objects; it never reaches for an element, a control or a camera.
 *
 * This was the first fourteen hundred lines of canvas.js, and the seam was
 * already there — the editor is the only thing that ever touched the DOM, and
 * it starts on the line after this file ends. Splitting it costs one honest
 * change: buildGround, buildBlades and buildSpecks used to close over the
 * page's field bake, and now take it as the argument it always was.
 *
 * The drawing is built in the order the illustrator works:
 *
 *   1. fill the ground   — an irregular flat patch, washed in, no outline yet
 *   2. ink its edge      — a short dark skirt at the rim IS the contour line
 *   3. draw the blades   — thousands of short round ribbons that sprout in
 *                          clumps, only some of them inked
 *
 * The ink is not post-processing. An inked blade is drawn twice: once slightly
 * fatter in ink, pushed back by a polygon offset, then once in its fill on
 * top. That is the whole trick — it costs one extra draw call and it survives
 * any camera angle, which a screen-space edge filter would not do this cleanly
 * on ribbons this thin.
 *
 * Blades are one InstancedBufferGeometry: a flat strip of quads whose vertices
 * are placed entirely in the vertex shader, billboarded around Y so a blade
 * always reads as a stroke no matter where you orbit to. The wind, the bend,
 * the profile and the growth-in are all functions of (t, phase, time)
 * evaluated there; nothing per-blade touches the CPU after upload.
 * ------------------------------------------------------------------------- */

import * as THREE from "three";
import {
  NOISE_GLSL,
  SUN_GLSL,
  SHADOW_GLSL,
  TERRAIN_GLSL,
  HILL_SHADOW_GLSL,
  sunSlots,
  shadowSlots,
  terrainSlots,
  MAX_CASTERS,
} from "./shade.js";
import { FIELD_GLSL, fieldSlots } from "./field.js";

/* Three colours, and that is the whole of it: paper, one green, and that
   same green's darker, cooler self for the line work. The ground and every
   blade on it are the flat green with no shading, no tint variation and no
   gradient, so the fill reads as a single shape and only the line separates
   one blade from the next.

   The line is deliberately NOT black. Ink over a wash is never neutral — it
   picks up the colour under it — so this is the grass hue pulled down in
   lightness and pushed round towards blue-green (65° → 92°), which is what
   the storybook references do and why their foliage reads soft rather than
   printed. Black here made everything look like a colouring book. */
export const PAPER = "#fcfcfc";
export const GRASS = "#c2c87e";
export const INK = "#4a5c37";

/* The two the green drifts between. They are the same green a little warmer
   and paler, and a little cooler and deeper — close enough that no edge ever
   appears between them, far enough that the mass stops reading as a fill. */
export const GRASS_PALE = "#d8dd98";
export const GRASS_DEEP = "#9fad63";

/* The secondary. Where the pale/deep pair is a wash you are not meant to
   notice, these two are meant to be caught: a patch that has gone gold in
   the sun and a patch that has stayed cold in the shade. They only surface
   on the peaks of a much finer noise, so they arrive as small islands of
   their own colour rather than as an overall tint. */
export const GRASS_WARM = "#cfc06a";
export const GRASS_COLD = "#93b087";

/* The small flowers scattered through it. Petals and centres are drawn from
   two lists rather than one colour each, because a meadow's variety is mostly
   in the middles: the same white flower with a gold eye and with a dark red
   one reads as two species, and six petal colours against five centres is
   thirty flowers for eleven strings. */
const PETALS = [
  "#f4dd86",
  "#fdf7e4",
  "#e8938a",
  "#e9adc5",
  "#c9b6dd",
  "#f0c874",
  "#f7f2e2",
  "#d9e3f0",
  "#eab8a0",
  "#cfe0a8",
  "#f2c9dd",
  "#e7d4f2",
];
const PETAL_CORES = ["#e6b953", "#d98f3c", "#7e5a2a", "#f0d67a", "#c2603f"];

/* the ball is the one thing here that is not grass, so it is allowed to be
   the one thing that is not green either */
export const BALL_SKIN = "#e6e0cc";

/* The light, and the dark. Neither is a brightness: the sun is a warm pale
   straw and the shadow is a cool violet-blue, because in every drawing this
   is derived from the shaded side of a thing is not a darker version of the
   lit side — it is a different, colder colour. Grey shadows are what makes a
   flat-filled picture look like a render with the lights turned down. */
/* How much harder relief is pushed than the flat two-tone. Relief is scaled by
   the difference between a slope and flat ground, which for a rolling hill is
   a few tenths at most — so left on the same footing as Strength it would be a
   correct calculation nobody could see. One number, not a fourth slider. */
export const RELIEF = 8;

export const SUNLIGHT = "#fff4d6";
export const SHADOW = "#333c66";

/* ---------------------------------------------------------------------------
 * four flowers, drawn once into one canvas and read back as three masks:
 * red is petal, green is centre, and whatever is neither is the line. That is
 * what lets one texture carry every colour in PETALS without tinting its own
 * outline along with it.
 *
 * Four rather than one, in a two-by-two atlas, because a field where every
 * flower is the same flower is a field with a pattern in it. Each speck picks
 * a cell, and between four shapes, twelve petal colours and five centres there
 * is no second flower quite like the first one.
 * ------------------------------------------------------------------------- */
const PETAL_KINDS = 4;

export function petalAtlas() {
  const S = 128; // one cell
  const c = document.createElement("canvas");
  c.width = c.height = S * 2;
  const g = c.getContext("2d");
  g.strokeStyle = "#000"; // r = g = 0 → line
  g.lineJoin = g.lineCap = "round";

  /* one ring of petals: how many, how fat, how far out */
  const ring = (n, rx, ry, at, turn) => {
    g.fillStyle = "#f00"; // r = 1 → petal
    for (let i = 0; i < n; i++) {
      g.save();
      g.rotate((i / n) * Math.PI * 2 + turn);
      g.beginPath();
      g.ellipse(0, -at, rx, ry, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.restore();
    }
  };
  const eye = (r) => {
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fillStyle = "#0f0"; // g = 1 → centre
    g.fill();
    g.stroke();
  };
  const cell = (col, row, draw) => {
    g.save();
    g.translate(col * S + S / 2, row * S + S / 2);
    draw();
    g.restore();
  };

  g.lineWidth = 5;
  cell(0, 0, () => {
    ring(5, 14, 22, 28, 0.3);
    eye(13);
  }); // the round five
  cell(1, 0, () => {
    ring(11, 5, 27, 30, 0.1);
    eye(12);
  }); // a fine-rayed aster
  cell(0, 1, () => {
    ring(4, 21, 17, 23, 0.8);
    eye(9);
  }); // four broad petals
  cell(1, 1, () => {
    // a sprig of florets
    g.lineWidth = 3.5;
    for (const [dx, dz] of [
      [0, -17],
      [-16, 7],
      [16, 7],
      [0, 20],
    ]) {
      g.save();
      g.translate(dx, dz);
      ring(5, 6, 9, 9, 0.2);
      eye(4.5);
      g.restore();
    }
  });

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace; // these are masks, not colour
  tex.anisotropy = 4;
  return tex;
}

const UP = new THREE.Vector3(0, 1, 0);
export const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------------------------------------------------------------------
 * a seeded rng, so a field can be replanted and then found again
 * ------------------------------------------------------------------------- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------------------
 * the coastline
 *
 * A patch of grass does not end on a curve. It frays: the mass pulls back
 * into a bay here, throws a headland out there, and the last of it comes
 * apart into single tufts standing on paper. That is two frequencies doing
 * two different jobs, so this is two octaves and no more — a slow one that
 * decides where the shape bulges, and a fast one whose only job is to break
 * the thin outer band into pieces.
 *
 * It has to be a FIELD and not the rng: two texels next to each other must
 * agree about where the coast is, or the edge dissolves into static instead
 * of into tufts. Hence value noise, sampled in world units, so the fray is
 * the same size whatever the island it is eating into.
 * ------------------------------------------------------------------------- */
export function makeCoast(seed) {
  const hash = (i, j) => {
    let x = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + seed * 1274126177) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  const v = (x, z) => {
    const i = Math.floor(x);
    const j = Math.floor(z);
    const fx = x - i;
    const fz = z - j;
    const ux = fx * fx * (3 - 2 * fx);
    const uz = fz * fz * (3 - 2 * fz);
    const a0 = hash(i, j);
    const a1 = hash(i + 1, j);
    const b0 = hash(i, j + 1);
    const b1 = hash(i + 1, j + 1);
    const a = a0 + (a1 - a0) * ux;
    const b = b0 + (b1 - b0) * ux;
    return a + (b - a) * uz;
  };
  /* World units of displacement, give or take two and a half of them, over
     three scales: a bay about eight across, a headland about two, and a bite
     about one and a half — which is one tuft wide, and that is the number
     that matters. The fast octave has to be roughly as strong as the outer
     band is wide, or all it does is roughen a line that is still a line;
     at this amplitude it cuts the band into pieces instead. */
  return (x, z) =>
    (v(x * 0.125, z * 0.125) - 0.5) * 2.3 +
    (v(x * 0.34 + 17, z * 0.34 + 17) - 0.5) * 1.4 +
    (v(x * 0.66 + 40, z * 0.66 + 40) - 0.5) * 1.7;
}

/* ---------------------------------------------------------------------------
 * the islands
 *
 * The drawing is not one lawn — it is one big patch with a handful of small
 * tufts thrown around it, which is what stops it reading as a pie chart. Each
 * island carries its own outline (a sum of sines over the angle, so it closes
 * on itself exactly) and its own dome.
 * ------------------------------------------------------------------------- */
function makeIsland(rng, cx, cz, r, harmonics = 4, coast = null) {
  const terms = [];
  for (let k = 0; k < harmonics; k++) {
    terms.push({
      f: 2 + k * 2 + (rng() < 0.5 ? 1 : 0), // integer → periodic over 2π
      /* the higher harmonics fall away fast: a couple of slow lobes reads as
         a round, drawn blob, where sharper ones read as a coastline */
      a: (0.11 / Math.pow(k + 1, 1.7)) * (0.6 + rng() * 0.8),
      p: rng() * Math.PI * 2,
    });
  }
  /* two fast, shallow ones on top: the edge keeps its round shape but stops
     being a clean arc, which is what was making the corners read as cut */
  for (let k = 0; k < 2; k++) {
    terms.push({
      f: 7 + Math.floor(rng() * 7),
      a: 0.03 + rng() * 0.032,
      p: rng() * Math.PI * 2,
    });
  }

  const radiusAt = (a) => {
    let s = 0;
    for (const t of terms) s += t.a * Math.sin(a * t.f + t.p);
    return r * (1 + s);
  };

  /* The fray is measured in world units and then divided by this island's
     own radius, because the falloff below is measured in radii. The floor
     under r is what stops a two-unit satellite from being rubbed out by its
     own edge: past a point, more fraying is just a smaller island. */
  const scale = 1 / Math.max(r, 4);
  const fray = coast ? (x, z) => coast(x, z) * scale : () => 0;

  /* An island is still a SHAPE — where there is ground and where there is
     not — and nothing to do with how high that ground is. The height is one
     field over the whole world (see hillsAt) rather than a dome per island,
     because a patch of grass on a hillside is a patch on a hillside and not
     a hill of its own. */
  return { cx, cz, r, radiusAt, fray };
}

export function makeField(seed) {
  const rng = mulberry32(seed);
  /* one coast for the whole field, so an island and its neighbour fray into
     the same weather rather than each into its own */
  const coast = makeCoast(seed);
  const islands = [makeIsland(rng, 0, 0, 12.0, 3, coast)];
  const n = 6 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.9;
    const d = 14.8 + rng() * 6.4;
    islands.push(
      makeIsland(
        rng,
        Math.cos(a) * d * 1.15,
        Math.sin(a) * d * 0.8,
        1.1 + rng() * 2.1,
        2,
        coast,
      ),
    );
  }

  /* Grass does not grow at one density. The drawing has clumps with bare
     ground between them and a thick fringe at the rim, and an even scatter
     reads as lawn turf instead — so a clump's root is only kept if it wins a
     roll against this. It lives on the field rather than inside the blade
     builder because the small flowers need to read the same field, and want
     the LOW end of it: a flower in a thick clump is a flower nobody sees. */
  const [n1, n2, n3] = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
  const density = (p) => {
    const v =
      Math.sin(p.x * 1.25 + n1) * Math.cos(p.z * 1.05 + n2) +
      0.55 * Math.sin((p.x + p.z) * 2.1 + n3);
    return THREE.MathUtils.clamp(0.46 + 0.4 * v + 0.4 * p.u * p.u, 0.18, 1);
  };

  return { rng, islands, density };
}

/* ---------------------------------------------------------------------------
 * the field you can paint
 *
 * Everything that grows now reads one texture instead of the island shapes.
 * Three channels, and each one is a different question:
 *
 *   R  zone      is there ground here at all — this is the silhouette
 *   G  thickness how much grows here, 0.5 being ordinary
 *   B  depth     how far inside the zone this is, which is just R blurred
 *
 * Depth is the useful one. Distance-to-edge is expensive and a blur is not,
 * and blurred coverage answers the same question well enough: it is 0 at the
 * rim and 1 well inside, for the generated islands AND for anything painted
 * afterwards. Clump size, the growth order and the wash all hang off it, so
 * a shape drawn with a brush behaves like one the field generated.
 * ------------------------------------------------------------------------- */
/* Twice as far in x and z as it was, at the same texel density — 0.094 world
   units each, which is what the brush, the blur radius and the rim contour
   were all tuned against and none of them should have to be retuned for a
   bigger field. It costs four times the texture: four megabytes resident, and
   a scene file that gzips to a few hundred kilobytes instead of sixty. */
const PAINT_N = 1024;
export const PAINT_EXTENT = 96; // world units across the whole field

/* ---------------------------------------------------------------------------
 * where a patch stops being a patch
 *
 * Measured in radii, and the three numbers are not interchangeable.
 *
 * EDGE_IN is where the ground stops being solid. It is well inside r, not at
 * it, because everything past this point is being spent on the transition and
 * the patch should not grow to pay for it.
 *
 * EDGE_TAIL is the shape of the letting go, and it is the one that decides
 * whether the edge reads as soft. A smoothstep is symmetric — it leaves as
 * fast as it arrives — and symmetric is exactly wrong here: it gives a band
 * of half-coverage with a definite outer end, which is a fatter version of
 * the same hard edge. A power above one drops quickly at first, so the body
 * keeps its mass, and then takes a very long time about the last tenth. That
 * long tail is the whole effect: a wide stretch of ground the field barely
 * claims, where what grows is single blades with paper between them.
 *
 * EDGE_OUT is where even that runs out.
 * ------------------------------------------------------------------------- */
const EDGE_IN = 0.84;
const EDGE_OUT = 1.44;
const EDGE_TAIL = 2.6;

export function makePaint() {
  const n = PAINT_N;
  const extent = PAINT_EXTENT;
  const data = new Uint8Array(n * n * 4);
  const depth = new Float32Array(n * n);
  const a = new Float32Array(n * n);
  const b = new Float32Array(n * n);

  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;

  const world = (i) => (i / (n - 1) - 0.5) * extent;
  const texel = (w) => THREE.MathUtils.clamp((w / extent + 0.5) * (n - 1), 0, n - 1);

  let inside = [];
  let fringe = [];
  let halo = [];

  /* the blur's constants, hoisted out of three million inner iterations */
  const R = 30;
  const INV = 1 / (R * 2 + 1);
  const STRIP = 64; // columns carried down together
  const last = n - 1;
  const sums = new Float32Array(STRIP);

  /* Lay the generated islands into the zone channel.
     Each island is walked over its own bounding square rather than over the
     whole field: an island's radius wanders by a third at most, so anything
     further than 1.4r from its centre cannot be inside it, and asking is an
     atan2 per texel per island. On a field this size that test was the whole
     cost of a Replant — a megabyte of texels against nine islands, of which a
     satellite covers a fifth of one per cent. */
  function seed(islands) {
    data.fill(0);
    for (let k = 0; k < n * n; k++) data[k * 4 + 1] = 128; // ordinary thickness

    const span = EDGE_OUT - EDGE_IN;
    for (const isl of islands) {
      /* the box has to hold the FRAYED island, not the drawn one: the tail
         runs a third past r and the coast carries it further still */
      const reach = isl.r * (EDGE_OUT + 0.36) + 1.4;
      const i0 = Math.max(0, Math.floor(texel(isl.cx - reach)));
      const i1 = Math.min(n - 1, Math.ceil(texel(isl.cx + reach)));
      const j0 = Math.max(0, Math.floor(texel(isl.cz - reach)));
      const j1 = Math.min(n - 1, Math.ceil(texel(isl.cz + reach)));
      const fray = isl.fray ?? (() => 0);
      for (let j = j0; j <= j1; j++) {
        const wz = world(j);
        const lz = wz - isl.cz;
        for (let i = i0; i <= i1; i++) {
          const wx = world(i);
          const lx = wx - isl.cx;
          const u =
            Math.hypot(lx, lz) / isl.radiusAt(Math.atan2(lz, lx)) + fray(wx, wz);
          if (u >= EDGE_OUT) continue;
          const cover =
            u <= EDGE_IN ? 1 : Math.pow(1 - (u - EDGE_IN) / span, EDGE_TAIL);
          const k = (j * n + i) * 4;
          data[k] = Math.max(data[k], Math.round(cover * 255));
        }
      }
    }
    relax();
  }

  /* ---------------------------------------------------------------------
   * R blurred into B, then the sampling lists rebuilt.
   *
   * Three passes of a box blur, each one a running sum, which is the right
   * algorithm and was not the problem. The problem was the second half of
   * each pass: a column is a stride of n floats apart, so walking one down
   * the field was a cache miss per texel — a million of them, three times
   * over, and it made this the most expensive thing a brush stroke did at
   * ANY blade count.
   *
   * So the downward pass takes sixty-four columns at a time and keeps a
   * running sum for each. Every read is then a contiguous run of sixty-four
   * floats out of three rows, which is a working set that fits in cache and
   * gets reused by the next row down. Identical arithmetic, same result to
   * the bit — it is only the order it is done in that changed.
   * ------------------------------------------------------------------- */
  function relax(blur = true) {
    if (blur) sweep();
    lists();
  }

  /* The three passes. This is the half that costs, and it produces the DEPTH
     channel — how far inside the patch a texel is, which decides clump size
     and the order the grass grows in. None of that changes visibly while a
     brush is still moving, so a stroke leaves it until the end and works off
     the depth it already had. */
  function sweep() {
    /* The blur is fed the SILHOUETTE, not the raw coverage, and that
       distinction is load-bearing now that the zone channel has a long thin
       tail on it. Depth means "how far inside the drawn shape am I", and the
       drawn shape is where coverage passes a half — so a wide halo of ground
       the field barely claims must not be allowed to count. Blurring the raw
       channel let it count, and the result was that widening the tail made
       the grass in the MIDDLE shorter, which is not a knob anybody would go
       looking for. Soft-thresholded rather than hard, so a brush stroke's
       own falloff still grades and the edge does not follow texels. */
    for (let k = 0; k < n * n; k++)
      a[k] = THREE.MathUtils.smoothstep(data[k * 4] / 255, 0.34, 0.66);

    for (let pass = 0; pass < 3; pass++) {
      for (let j = 0; j < n; j++) {
        // across, already contiguous
        const row = j * n;
        let sum = 0;
        for (let i = -R; i <= R; i++) sum += a[row + (i < 0 ? 0 : i > last ? last : i)];
        for (let i = 0; i < n; i++) {
          b[row + i] = sum * INV;
          sum +=
            a[row + (i + R < last ? i + R + 1 : last)] - a[row + (i > R ? i - R : 0)];
        }
      }
      for (let i0 = 0; i0 < n; i0 += STRIP) {
        // down, sixty-four at a time
        const w = Math.min(STRIP, n - i0);
        sums.fill(0, 0, w);
        for (let j = -R; j <= R; j++) {
          const row = (j < 0 ? 0 : j > last ? last : j) * n + i0;
          for (let c = 0; c < w; c++) sums[c] += b[row + c];
        }
        for (let j = 0; j < n; j++) {
          const out = j * n + i0;
          const add = (j + R < last ? j + R + 1 : last) * n + i0;
          const sub = (j > R ? j - R : 0) * n + i0;
          for (let c = 0; c < w; c++) {
            a[out + c] = sums[c] * INV;
            sums[c] += b[add + c] - b[sub + c];
          }
        }
      }
    }

    for (let k = 0; k < n * n; k++) {
      /* the blur never reaches 1 — normalise so the middle of a decent patch
         reads as fully inside, or every clump ends up a small one */
      depth[k] = THREE.MathUtils.clamp(a[k] * 2.2, 0, 1);
      data[k * 4 + 2] = Math.round(depth[k] * 255);
    }
  }

  /* Where grass is allowed to grow, off the zone channel alone. One pass and
     no blur, so a stroke can afford it between frames — which it has to, or
     ground painted a moment ago would stay bare until you let go.

     Three bands, not two, and the third is the one that matters. Inside is
     ground the field is confident about and fringe is ground it half claims;
     halo is the long tail — ground it barely claims at all, where coverage is
     under a sixth and still falling. Splitting that off rather than widening
     the fringe is what lets the planter treat it differently: a fringe texel
     gets a small clump, a halo texel gets one blade and a coin toss. */
  function lists() {
    inside = [];
    fringe = [];
    halo = [];
    for (let k = 0; k < n * n; k++) {
      const zone = data[k * 4];
      if (zone > 150) inside.push(k);
      else if (zone > 38) fringe.push(k);
      else if (zone > 3) halo.push(k);
    }
    tex.needsUpdate = true;
  }

  /* the brush. delta is signed: pushing a channel up paints, down erases */
  function stamp(x, z, radius, delta, channel) {
    const ci = texel(x);
    const cj = texel(z);
    const rr = (radius / extent) * n;
    const i0 = Math.max(0, Math.floor(ci - rr));
    const i1 = Math.min(n - 1, Math.ceil(ci + rr));
    const j0 = Math.max(0, Math.floor(cj - rr));
    const j1 = Math.min(n - 1, Math.ceil(cj + rr));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - ci, j - cj) / rr;
        if (d > 1) continue;
        const fall = 1 - THREE.MathUtils.smoothstep(d, 0.15, 1);
        const k = (j * n + i) * 4 + channel;
        data[k] = THREE.MathUtils.clamp(data[k] + delta * fall, 0, 255);
        /* ground that has just been painted starts at ordinary thickness */
        if (channel === 0 && delta > 0) {
          const g = (j * n + i) * 4 + 1;
          if (data[g] < 128) data[g] = Math.max(data[g], Math.round(128 * fall));
        }
      }
    }
    tex.needsUpdate = true;
  }

  /* Written into a caller's object rather than returning a fresh one. This is
     asked several hundred thousand times inside one plant, in rejection loops
     that throw most of the answers away, and at that rate the garbage is the
     measurement — see buildBlades. */
  const at = (x, z, out = { zone: 0, thick: 0, depth: 0 }) => {
    const k = (Math.round(texel(z)) * n + Math.round(texel(x))) * 4;
    out.zone = data[k] / 255;
    out.thick = data[k + 1] / 128;
    out.depth = data[k + 2] / 255;
    return out;
  };

  /* the fourth channel: how much of a path has been laid here. Bilinear
     rather than nearest, because the slab lattice asks about single points
     and a nearest lookup makes the edge of a stroke follow texels. */
  const paveAt = (x, z) => {
    const fx = THREE.MathUtils.clamp(texel(x), 0, n - 1.001);
    const fz = THREE.MathUtils.clamp(texel(z), 0, n - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const g = (ii, jj) => data[(jj * n + ii) * 4 + 3] / 255;
    return (
      (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) +
      (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v
    );
  };

  /* a world point somewhere in texel k, jittered so a stroke of grass does
     not land on a lattice */
  const pointAt = (k, rng, out = { x: 0, z: 0 }) => {
    const i = k % n;
    const j = (k - i) / n;
    const step = extent / (n - 1);
    out.x = world(i) + (rng() - 0.5) * step;
    out.z = world(j) + (rng() - 0.5) * step;
    return out;
  };

  return {
    n,
    extent,
    data,
    depth,
    tex,
    seed,
    relax,
    stamp,
    at,
    paveAt,
    pointAt,
    lists: () => ({ inside, fringe, halo }),
  };
}

/* ---------------------------------------------------------------------------
 * the ground — step one, the wash
 *
 * One quad over the whole field, and the silhouette comes entirely out of the
 * paint texture: below the threshold there is no ground, just past it there
 * is the contour line, and beyond that the wash.
 *
 * The threshold used to be crossed with a little noise on it, and a threshold
 * crossed with a little noise on it is still a threshold: the field ended on
 * a line, a wobbly one. It is DISSOLVED now. Three noises at three scales are
 * added to the coverage, and all three are scaled by how near the rim this
 * fragment already is — so the body of the patch is untouched, and the last
 * few feet of it come apart. Bays first, then flecks with paper between them,
 * then nothing. Where the wash ends is no longer a place you can point at.
 * ------------------------------------------------------------------------- */
const GROUND_VERT = /* glsl */ `
  varying vec2 vXZ;
  ${FIELD_GLSL}
  void main(){
    vXZ = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix
      * vec4(position + vec3(0.0, fieldAt(vXZ).a, 0.0), 1.0);
  }
`;

const GROUND_FRAG = /* glsl */ `
  uniform sampler2D uPaint;
  uniform float uExtent, uReveal, uEdge;
  uniform vec3  uInkColor;
  varying vec2  vXZ;
  ${NOISE_GLSL}
  ${FIELD_GLSL}
  ${SUN_GLSL}
  ${SHADOW_GLSL}
  void main(){
    vec4 p = texture2D(uPaint, vXZ / uExtent + 0.5);

    /* p.b is the blurred coverage — already "how far inside am I", and the
       one channel that answers it without a second fetch. Squared, because
       the dissolve should be confined hard: anywhere the ground is properly
       there, it is properly there. */
    float rim = 1.0 - smoothstep(0.0, 0.30, p.b);
    rim *= rim;

    /* Three scales, three jobs. The slow one decides which stretches of coast
       pull back; the middle one is the raggedness along them; the fast one is
       one tuft wide and is the only reason the tail breaks into flecks rather
       than thinning into a grey band. */
    float coast = (fbm(vXZ * 0.55)   - 0.5) * 0.36
                + (fbm(vXZ * 1.90)   - 0.5) * 0.30
                + (vnoise(vXZ * 6.2) - 0.5) * 0.22;

    float wobble = (fbm(vXZ * 2.1) - 0.5) * 0.09;
    float e = p.r + wobble + coast * rim;
    if (e < 0.5) discard;                      // no ground here
    if ((1.0 - p.b) > uReveal) discard;        // the wash, spreading outwards

    /* The line is measured in pixels, not in field units. A brushed edge
       falls off over the width of the brush and a generated one over a fixed
       distance, so a band taken straight off the field would be a hairline
       on one and a stripe on the other. The screen-space derivative makes
       both of them the same line. */
    if ((e - 0.5) < fwidth(e) * uEdge) {       // the contour, drawn last
      gl_FragColor = vec4(uInkColor, 1.0);
    } else {
      /* the wash, the patches, the sun on this slope and the shadow of the
         hill upwind of it, all of it worked out once in field.js */
      vec3 c = fieldAt(vXZ).rgb;
      /* and the one shadow that could not be baked, because the things that
         throw it are moving */
      c = tone(c, uShadeColor, castShadow(vXZ));
      gl_FragColor = vec4(c, 1.0);
    }
    #include <colorspace_fragment>
  }
`;

/* The ground was four vertices, because a flat thing needs four and the whole
   silhouette came out of the paint texture in the fragment shader. A hill has
   to be somewhere for the geometry to go, so it is a grid now — 160 a side,
   which puts about eleven vertices across the smallest hill the Size slider
   can make and none of them anywhere the eye can find. */
const GROUND_SEGMENTS = 160;

export function buildGround(paint, uniforms, bake) {
  const geo = new THREE.PlaneGeometry(
    paint.extent,
    paint.extent,
    GROUND_SEGMENTS,
    GROUND_SEGMENTS,
  );
  geo.rotateX(-Math.PI / 2);

  const mesh = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: {
        uPaint: { value: paint.tex },
        uExtent: { value: paint.extent },
        uReveal: uniforms.uReveal,
        uEdge: uniforms.uEdge,
        uInkColor: uniforms.uInkColor,
        ...sunSlots(uniforms),
        ...shadowSlots(uniforms),
        ...fieldSlots(bake),
      },
      vertexShader: GROUND_VERT,
      fragmentShader: GROUND_FRAG,
      side: THREE.DoubleSide,
    }),
  );
  mesh.frustumCulled = false;
  return mesh;
}

/* ---------------------------------------------------------------------------
 * the blades — step three
 *
 * One strip of quads, instanced. Everything below the `position` attribute is
 * per-blade and constant; the shader does the rest.
 * ------------------------------------------------------------------------- */
const BLADE_VERT = /* glsl */ `
  attribute vec3  iPos;      // where it grows
  attribute vec4  iParams;   // height, width, resting lean, phase
  attribute vec2  iFace;     // cos/sin of its yaw off camera-facing
  attribute vec2  iLean;     // the WORLD direction it leans in, at rest
  attribute float iDelay;    // when it sprouts
  attribute float iInk;      // its place in the queue for an outline
  attribute float iShape;    // how round its profile is: 1.6 wispy, 4 leafy
  attribute float iRank;     // its place in the queue when the field thins out

  uniform float uTime, uWind, uGust, uGrow, uCrop, uInkAmount, uVary, uPatch, uWidth;
  uniform vec2  uWindDir;    // world, normalised
  uniform vec4  uBall;       // xz centre, y unused, w radius (0 = no ball)
  uniform vec4  uTrail[8];   // xz, strength, unused — where the ball has been
  uniform vec3  uInkColor, uGrass, uGrassPale, uGrassDeep, uWarm, uCold;
  varying vec3  vColor;
  varying float vAcross;  // -1 at one long edge, +1 at the other
  varying float vHalf;     // half the blade's width here, in world units
  varying float vToTip;    // world distance to the tip
  varying float vInked;    // whether this blade draws a line at all
  uniform float uGrassDepth, uDensity;
  uniform vec2  uCullPad;
  ${NOISE_GLSL}
  ${FIELD_GLSL}
  ${SUN_GLSL}
  ${SHADOW_GLSL}

  void main(){
    float t = position.y;                       // 0 root → 1 tip

    /* ---- the two ways a blade gets out of doing any work ----------------
       Everything below this is a texture fetch, a noise field, nine distance
       tests and sixteen shadow capsules, and it runs on all twenty-two of a
       blade's vertices. At three hundred thousand blades most of that is
       being spent on grass nobody is looking at, so both of these are the
       first thing in the shader and not the last.

       First: is it on screen? One matrix multiply against the root, with a
       margin wide enough for the tallest blade leaning the hardest — see
       uCullPad, which is worked out from the zoom every frame.

       Second: at this zoom, is it wanted at all? Every blade holds a rank,
       and when the field thins out the ones above the line go. They do not
       vanish — they are scaled into the ground across a band, so thinning is
       something you can watch happen without ever catching it. */
    vec4 rootClip = projectionMatrix * modelViewMatrix * vec4(iPos.x, 0.0, iPos.z, 1.0);
    vec2 rootNdc = rootClip.xy / rootClip.w;
    if (abs(rootNdc.x) > uCullPad.x || abs(rootNdc.y) > uCullPad.y) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
    }
    float thin = smoothstep(uDensity, uDensity - 0.14, iRank);
    if (thin <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    /* One fetch, and it is everything about the ground this blade stands on:
       how high it is, and what colour it is once the wash, the patches, the
       sun, the slope and the hill's own shadow have all had their say. All of
       that used to be worked out here, per vertex, twenty-two times a blade —
       see field.js for how much of the frame that was. */
    vec4 field = fieldAt(iPos.xz);
    float ground = field.a;

    float g = clamp((uGrow - iDelay) / 0.32, 0.0, 1.0);
    g = g * g * (3.0 - 2.0 * g);
    if (g <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    /* not every blade gets a line. The ones that don't are the same green as
       the ground they stand in, so they read as mass rather than as line —
       which is how the drawing keeps a dense patch from turning into a
       scribble. uInkAmount is the share that keeps its outline. */
    vInked = 1.0 - step(uInkAmount, iInk);

    /* billboard about Y: the blade turns to keep its face to the camera, so
       it always reads as a stroke, never as an edge-on sliver. iFace rotates
       it a little off that, which is what keeps the field from looking like
       one blade stamped ten thousand times. */
    vec3 toCam = cameraPosition - iPos;
    toCam.y = 0.0;
    vec3 f = normalize(toCam);
    vec3 r = normalize(cross(vec3(0.0, 1.0, 0.0), f));
    vec3 side = normalize(r * iFace.x + f * iFace.y);

    float phase = iParams.w;

    /* ---- which way it leans, in the world -----------------------------
       This used to be a signed amount along the billboard axis, so the wind
       blew left-to-right across the SCREEN: turn the camera and the weather
       turned with it. A lean is a world direction now. The billboard still
       owns the blade's width; it no longer owns where the blade is going. */
    vec3 push = vec3(iLean.x, 0.0, iLean.y) * iParams.z;

    /* ---- the wind -----------------------------------------------------
       One field, moving. Sampling the noise at (position − direction × time)
       is what makes a gust travel: the pattern is fixed in its own space and
       that space slides across the field, so a wave crosses the grass
       instead of every blade waving on its own clock. The flutter on top is
       small and fast, and only there so the lull between gusts is not
       glassy. */
    float wave = fbm(iPos.xz * 0.13 - uWindDir * uTime * 1.15) * 2.0 - 1.0;
    float flutter = sin(uTime * 3.3 + phase * 2.1) * 0.09;
    float force = max(0.0, uWind * (0.42 + uGust * wave) + flutter * uWind);
    push += vec3(uWindDir.x, 0.0, uWindDir.y) * force;

    /* ---- the ball -----------------------------------------------------
       One distance test against the ball and eight against where it has
       been. Blades near it are shoved outwards and squashed; the trail
       samples fade, so the wake stands back up behind it. This is the whole
       of the interaction — no collision, no per-blade state, nothing on the
       CPU but nine vec4s. */
    float squash = 0.0;
    if (uBall.w > 0.0) {
      vec2 d = iPos.xz - uBall.xz;
      float dist = length(d);
      float k = 1.0 - smoothstep(uBall.w * 0.5, uBall.w * 2.1, dist);
      push += vec3(d.x, 0.0, d.y) / max(dist, 0.001) * k * 1.7;
      squash = k;

      for (int i = 0; i < 8; i++) {
        vec2 td = iPos.xz - uTrail[i].xy;
        float tdist = length(td);
        float tk = (1.0 - smoothstep(uBall.w * 0.4, uBall.w * 1.7, tdist)) * uTrail[i].z;
        push += vec3(td.x, 0.0, td.y) / max(tdist, 0.001) * tk * 1.1;
        squash = max(squash, tk * 0.8);
      }
    }

    /* Lean, wind and ball all push the same vector, so they can stack into a
       blade lying flat and stretched to three times its length. One clamp on
       the total is the whole fix — and it is also the right physics, since a
       blade bent right over cannot bend any further. */
    float pl = length(push);
    if (pl > 1.5) push *= 1.5 / pl;

    float h = iParams.x * g * uCrop * (1.0 - 0.6 * clamp(squash, 0.0, 1.0)) * thin;

    /* an elliptical profile rather than a taper to a point: full width most
       of the way up, then rounded off at the tip. Short, fat and round is
       most of what separates a cute blade from a blade of wheat, and the
       exponent is per-blade — a wisp thins out early, a leaf stays fat
       almost to its tip and then turns over.

       The outer power blunts that turn: a wisp keeps 0.5 and comes to a
       point, a leaf drops towards 0.36 and ends round, like a leaf does. */
    float outer = mix(0.5, 0.36, clamp((iShape - 2.0) / 2.6, 0.0, 1.0));
    float w = iParams.y * uWidth * pow(max(0.0, 1.0 - pow(t, iShape)), outer);

    /* What the fragment shader needs to find this blade's own outline. Note
       what is NOT passed: the distance to the edge itself. The strip is two
       vertices wide, so that distance is zero at both of them and would
       interpolate to zero all the way across — it has to be rebuilt per
       fragment from a coordinate that IS linear across the ribbon.

       Nothing here is drawn twice and nothing is coincident with anything,
       which is the entire point: an outline that is a second copy of the
       blade will always fight the original in depth, and no offset makes
       that exactly right. */
    vAcross = position.x * 2.0;
    vHalf = w * 0.5;
    vToTip = (1.0 - t) * h;

    float curve = t * t;                              // the lean, quadratic
    float wobble = sin(t * 6.5 + phase * 4.0) * 0.018; // a drawn line is never straight
    float over = dot(push, push);

    /* the hill it is rooted in. Added here rather than baked into iPos on the
       CPU for two reasons: the height is a live uniform, so a blade follows
       the Hills slider without the field being rebuilt — and iPos.y is
       already carrying a meaning, which is the loose-leaf flag below. */
    vec3 p = iPos + vec3(0.0, ground, 0.0)
      + side * (position.x * w + wobble * h)
      + push * (curve * h)
      + vec3(0.0, 1.0, 0.0) * (t * h * (1.0 - 0.18 * min(over, 2.0) * curve));

    /* A few leaves have come loose and are drifting. Every rooted blade sits
       at exactly y = 0, so its own height is the flag — no attribute needed,
       and the ones in the air get a slow wander, downwind, instead of a
       root. */
    float loose = step(0.05, iPos.y);
    p += loose * (
      vec3(uWindDir.x, 0.0, uWindDir.y) * (sin(uTime * 0.31 + phase) * 0.5 + 0.5) * (0.7 + uWind)
      + vec3(0.0, sin(uTime * 0.47 + phase * 1.4) * 0.17, 0.0)
      + vec3(-uWindDir.y, 0.0, uWindDir.x) * cos(uTime * 0.26 + phase * 0.8) * 0.45);

    /* The fill is the ground's green exactly. Sampled at the ROOT, not at
       the vertex — one colour for the whole blade, and the same colour the
       ground beneath it is drawing, so the two stay one shape however far
       the variation is pushed. */
    /* the ground's own colour, from the ground's own texture — so a blade and
       the ground beneath it are not two greens that nearly match, they are the
       same number */
    vec3 green = field.rgb;

    /* The field's own shadow. Nothing casts this — the bottom of a blade is
       simply down among ten thousand others and the top of it is not, and one
       mix up the length of the blade is the whole of it. It is the cheapest
       thing on this page and it is most of what stops a field of strokes
       reading as a flat green mat with lines on it. */
    green = tone(green, uShadeColor, uGrassDepth * (1.0 - smoothstep(0.0, 0.62, t)));

    /* and whatever is standing between this blade and the sun. Asked once, at
       the root, so a blade is in shadow or out of it and never half-lit up
       its own length — which is what a drawn shadow does. */
    /* the hill's shadow is already in field.rgb; this is the one thrown by
       things that move */
    green = tone(green, uShadeColor, castShadow(iPos.xz));

    vColor = green;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const BLADE_FRAG = /* glsl */ `
  uniform bool uWireframe;
  uniform vec3 uWireColor;
  uniform float uLine;      // in pixels
  uniform vec3  uInkColor;
  varying vec3  vColor;
  varying float vAcross;
  varying float vHalf;
  varying float vToTip;
  varying float vInked;
  void main(){
    /* distance to the nearest edge of this blade, rebuilt here rather than
       interpolated, then fwidth turns world units into pixels — so the line
       is the same weight at any zoom and on any blade, however thin. A wisp
       narrower than the line simply becomes one. */
    float d = min((1.0 - abs(vAcross)) * vHalf, vToTip);
    float px = max(fwidth(d), 1e-6);
    float e = 1.0 - smoothstep(uLine * px * 0.35, uLine * px * 1.15, d);
    gl_FragColor = vec4(uWireframe ? uWireColor : mix(vColor, uInkColor, e * vInked), 1.0);
    #include <colorspace_fragment>
  }
`;

/* ---------------------------------------------------------------------------
 * how many pieces a blade is in
 *
 * Culling the blades you cannot see turned out to save almost nothing, and
 * that measurement is the whole reason this exists: once the ground was baked
 * (see field.js) the work INSIDE a vertex shader was no longer the cost. The
 * cost was how many times it runs, and an early return still runs it. Three
 * hundred thousand blades at ten segments is six and a half million vertex
 * invocations whether or not any of them do anything.
 *
 * So the only lever left is fewer vertices, and a blade only needs segments to
 * curve. A blade forty pixels tall bends visibly and gets all ten; one twelve
 * pixels tall gets six, and the difference between the two is a fraction of a
 * pixel; below that it is a stroke and three will do.
 *
 * The switch is on the SHARED geometry, not on the instances, so it costs one
 * small buffer swap and no rebuild — and it happens on zoom, which is already
 * a moment when the picture is changing.
 * ------------------------------------------------------------------------- */
const LOD_SEGMENTS = [3, 6, 10];

function bladeStrip(segments = 10) {
  const pos = [];
  const idx = [];
  for (let i = 0; i <= segments; i++) {
    const t = 1 - Math.pow(1 - i / segments, 1.7);
    pos.push(-0.5, t, 0, 0.5, t, 0);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  return { pos, idx };
}

/* built once and shared by whichever level the zoom asks for */
const LOD_STRIPS = LOD_SEGMENTS.map((n) => {
  const strip = bladeStrip(n);
  return {
    position: new THREE.Float32BufferAttribute(strip.pos, 3),
    index: new THREE.Uint16BufferAttribute(strip.idx, 1),
    verts: strip.pos.length / 3,
  };
});

/* Roots come off the paint field now, not the island shapes: a texel is
   picked from one of two lists — the ones the zone channel says are ground,
   and the ones at its fringe — and jittered inside itself. Whatever painted
   that texel, a generated island or a brush, the grass does not know. */
/* One root and one reading of the field, reused. Nothing holds on to either
   past the iteration that asked for it, which is what makes this safe — and
   it is worth checking that stays true, because the day something does keep a
   reference this turns into a bug that only shows up at scale. */
const scratchRoot = { x: 0, y: 0, z: 0, depth: 0, thick: 0, u: 0, zone: 0 };
const scratchField = { zone: 0, thick: 0, depth: 0 };

function rootFrom(rng, paint, list) {
  if (!list.length) return null;
  const p = paint.pointAt(list[(rng() * list.length) | 0], rng, scratchRoot);
  const f = paint.at(p.x, p.z, scratchField);
  p.y = 0;
  p.depth = f.depth;
  p.thick = f.thick;
  p.u = 1 - f.depth;
  /* the raw coverage, which the halo needs and the body has no use for: out
     there depth has already bottomed out at zero and cannot tell one end of
     the tail from the other */
  p.zone = f.zone;
  return p;
}

/* ---------------------------------------------------------------------------
 * what is standing here
 *
 * Objects do one of two things to the grass under them, and which one is not
 * a detail: clearing everything makes a bald ring round each object and the
 * scene reads as models on a lawn, while crushing everything makes them
 * hover. Solid things with a flat bottom clear; things that rest on top of
 * the grass crush it and let it come up around them.
 *
 * A path is the third case and the most particular: the stones clear, the
 * JOINTS do not, so grass comes up between the slabs. That is the difference
 * between a paved area and a grey shape.
 * ------------------------------------------------------------------------- */
const scratchStood = { clear: false, crush: 0 };

function standingAt(world, x, z) {
  const out = scratchStood;
  out.clear = false;
  out.crush = 0;
  for (const f of world.footprints) {
    const dx = x - f.x;
    const dz = z - f.z;
    const d = Math.sqrt(dx * dx + dz * dz); // hypot is the careful one; this is the hot one
    if (d > f.r) continue;
    if (f.mode === "clear") {
      out.clear = true;
      out.crush = 1;
      return out;
    }
    /* soft at the rim: a cushion does not have a hard edge to its dent */
    const k = 1 - THREE.MathUtils.smoothstep(d, f.r * 0.45, f.r);
    out.crush = Math.max(out.crush, k * (f.soft ?? 0.7));
  }
  if (world.paving && world.paved(x, z) && world.paving.on(x, z)) {
    out.clear = true;
    out.crush = 1;
  }
  return out;
}

export function buildBlades(
  field,
  paint,
  count,
  uniforms,
  heights,
  world,
  bake,
  inspectClumps = false,
  studyClumpBlades = 0,
) {
  const { rng, density } = field;
  const { inside, fringe, halo } = paint.lists();
  if (!inside.length) return null;

  const iPos = new Float32Array(count * 3);
  const iParams = new Float32Array(count * 4);
  const iFace = new Float32Array(count * 2);
  const iLean = new Float32Array(count * 2);
  const iDelay = new Float32Array(count);
  const iInk = new Float32Array(count);
  const iShape = new Float32Array(count);
  const iRank = new Float32Array(count);
  const flowers = [];
  const clumps = [];
  const maxFlowers = THREE.MathUtils.clamp(Math.round(count / 110), 5, 40);

  /* a handful of leaves are held back to come loose at the end */
  const loose = THREE.MathUtils.clamp(Math.round(count * 0.012), 3, 40);

  let i = 0;
  while (i < count - loose) {
    /* --- the clump's root ------------------------------------------------
       Three bands, and a third of the budget goes to the two that are not
       the body of the patch. That is a lot of grass spent on the edge, and
       it is the right amount: the edge is most of what the eye reads, and a
       silhouette that ends where the painted shape ends reads as a cut-out
       however good the grass inside it is.

       The fringe gets small clumps. The halo — the long tail of the falloff
       — gets single blades, and then gets thinned a SECOND time against its
       own coverage. That second roll is the point. A band of texels planted
       evenly is a band, and a band around a shape is a ring; rolling again
       against how much ground is really there turns it into a scatter that
       thins outwards and simply runs out, with paper showing through long
       before it does.

       Body roots are rejected against the density noise and against whatever
       the thickness channel says about that spot, so a brushed-in thick patch
       really does end up with more grass in it. */
    /* These are shares of PICKS, not of blades, and the difference is the
       whole reason the first attempt at this was invisible. A body clump is
       ten or twelve blades and a halo clump is one; spending a sixth of the
       PICKS out there spends about one blade in a hundred, which is nothing
       at all. Two picks in five is what a visible scatter costs. */
    const where = rng();
    const strays = halo.length > 0;
    const outer = strays && where < 0.36;
    const outside = !outer && where < 0.56;
    const edge = outer || outside;

    let root = rootFrom(
      rng,
      paint,
      outer ? halo : outside ? (fringe.length ? fringe : inside) : inside,
    );
    if (!root) break;
    if (outer) {
      /* zone runs from about 0.015 to 0.15 across the halo, so this keeps
         almost everything at the inner end and almost nothing at the outer.
         A rejected pick costs an iteration and no budget — it goes round
         again — so the thinning is free in grass and cheap in time. */
      if (rng() > root.zone * 8) continue;
    } else if (!outside) {
      for (let tries = 0; tries < 4 && rng() > density(root) * root.thick; tries++) {
        root = rootFrom(rng, paint, inside);
      }
    }
    /* how much of a foothold this root has, 0 at the very last of the tail
       and 1 anywhere the field is properly claimed. The halo's clumps are
       scaled by it, so they do not all stop at one size and then stop. */
    const hold = outer ? THREE.MathUtils.clamp(root.zone * 8, 0.15, 1) : 1;

    /* and now: is anything standing here? A cleared spot is tried again a few
       times before giving up, so a scene full of objects still spends its
       whole blade budget on the grass that IS there. */
    let stood = standingAt(world, root.x, root.z);
    for (let tries = 0; stood.clear && tries < 6; tries++) {
      root = rootFrom(rng, paint, inside);
      if (!root) break;
      stood = standingAt(world, root.x, root.z);
    }
    if (!root || stood.clear) continue;
    const scale = 1;

    /* --- what kind of clump ----------------------------------------------
       The fluff in the storybook references is never a field of strokes: it
       is a mass of rounded lobes, with a few thin things arcing out of it.
       So most clumps are puffs — short wide leaves packed tight enough to
       overlap into one soft blob — and the tufts that read as line work are
       the minority. */
    const roll = rng();
    const kind = outer
      ? /* Mostly single blades, and out at the very end nothing else: a puff
           there is a blob of green sitting on paper with no ground under it.
           But the inner half of the halo is where the small detached PATCHES
           live — a dozen short leaves with paper all round them — and those
           are what stop the scatter from reading as stubble. */
        roll < 0.5
        ? "single"
        : roll < 0.82 || hold < 0.55
          ? "tuft"
          : "puff"
      : outside
        ? roll < 0.45
          ? "single"
          : roll < 0.8
            ? "tuft"
            : "puff"
        : roll < 0.1
          ? "single"
          : roll < 0.42
            ? "tuft"
            : roll < 0.93
              ? "puff"
              : "flower";

    /* Size falls off towards the rim, not up. A patch of grass is a mound of
       mass in the middle feathering out to single small things at its edge —
       the other way round gives a crater with a wall, and a hard silhouette
       where you want the shape to break up into paper.

       The exceptions matter as much as the rule: one clump in ten ignores it
       entirely and stands tall wherever it happens to be, which is what stops
       the falloff from reading as a formula. */
    const mid = root.depth; // 1 well inside → 0 at the rim
    const exception = rng() < 0.1 ? 1.5 + rng() * 0.8 : 1;

    /* a proper bush, and only really in the body of the patch */
    const big = kind === "puff" && rng() < 0.28 * mid + 0.04 ? 1.6 + rng() * 0.6 : 1;

    let n = Math.max(
      1,
      Math.round(
        (kind === "single"
          ? rng() < 0.35
            ? 2
            : 1
          : kind === "puff"
            ? /* A halo patch is a PATCH — half a dozen leaves with paper all
                 round it. Left at the body's count it is a bush standing on
                 nothing, and it also quietly eats the budget: these are the
                 most numerous clumps on the field and the least of it. */
              outer
              ? 5 + rng() * 4
              : 10 + rng() * (edge ? 6 : 14)
            : 4 + rng() * (edge ? 3 : 8)) *
          (big > 1 ? 1.8 : 1) *
          (outer ? 0.3 + 0.7 * hold : 1),
      ),
    );
    // A tutorial can inspect one denser puff using the same planting rules.
    if (
      inspectClumps &&
      studyClumpBlades &&
      kind === "puff" &&
      !clumps.some((c) => c.kind === "puff")
    )
      n = Math.min(count - i, studyClumpBlades);
    const spread =
      kind === "single"
        ? 0.02
        : kind === "puff"
          ? (0.17 + rng() * 0.2) * scale * big * (0.5 + 0.5 * mid)
          : (0.07 + rng() * 0.2) * scale * (0.6 + 0.4 * mid) * (outer ? 0.6 : 1);

    /* every clump has its own idea of how tall it is — this is most of what
       stops the field reading as one height with noise on top */
    const body = 0.34 + 0.72 * mid;
    const clumpH =
      body *
      scale *
      (heights.min + rng() * Math.max(0.02, heights.max - heights.min)) *
      /* Shorter towards the edge, and shortest at the very end of it. This is
         the other half of the softness: a full-height blade standing alone on
         paper is a mark, and a row of them is a fence. Half-height ones read
         as the field carrying on and getting quieter. */
      (outer ? 0.44 + 0.36 * hold : outside ? 0.55 : 1) *
      big *
      exception *
      THREE.MathUtils.clamp(root.thick, 0.35, 1.8) *
      (1 - stood.crush * 0.82);
    const clumpW = 0.105 * scale * (0.75 + rng() * 0.55);
    const fan = 0.45 + rng() * 0.95; // short and round wants more arc, not less
    const delay = THREE.MathUtils.clamp(root.u * 0.45 + rng() * 0.3, 0, 0.75);
    const stem = kind === "flower" && flowers.length < maxFlowers;

    /* --- the blades in it ------------------------------------------------ */
    const take = Math.min(n + (stem ? 1 : 0), count - i);
    if (inspectClumps)
      clumps.push({ start: i, count: take, kind, x: root.x, z: root.z });
    for (let b = 0; b < take; b++, i++) {
      const isStem = stem && b === 0;

      const a = rng() * Math.PI * 2;
      const d = isStem ? 0 : Math.sqrt(rng()); // 0 centre → 1 edge of the clump
      const lx = Math.cos(a) * d * spread;
      const lz = Math.sin(a) * d * spread;

      /* Three things a blade can be. A leaf is short, fat and round and is
         what builds the fluff; a wisp is long, thin and strongly curved and
         is what keeps the fluff from looking upholstered. */
      const isLeaf = kind === "puff" ? rng() < 0.88 : rng() < 0.3;
      const isWisp = !isLeaf && rng() < (kind === "puff" ? 0.45 : 0.3);

      /* A tuft is a fountain: tallest in the middle, falling off linearly.
         A puff is a dome — its blade tips are set to describe a hemisphere,
         so the clump has a genuinely round silhouette from any angle rather
         than a round arrangement seen from above. That envelope, plus the
         ink landing on its outermost leaves, is the whole of the fluff. */
      let h =
        kind === "puff"
          ? clumpH *
            (0.35 + 0.8 * Math.sqrt(Math.max(0, 1 - d * d))) *
            (0.9 + rng() * 0.2)
          : clumpH * (0.5 + 0.62 * (1 - d)) * (0.85 + rng() * 0.3);
      let w = clumpW * (0.75 + rng() * 0.5);
      let shape = 2.6;
      if (isLeaf) {
        h *= 0.85;
        w *= 2.4 + rng() * 0.9;
        shape = 3.4 + rng() * 1.3;
      }
      if (isWisp) {
        h *= 1.9 + rng() * 0.7;
        w *= 0.55;
        shape = 1.5 + rng() * 0.4;
      }

      /* Fan the lean evenly across the clump rather than randomly, so the
         blades splay off each other instead of clustering one way. The fan
         is an angle around the clump's root now, not a signed amount: a
         tuft splays in every direction on the ground, and which of those
         directions happens to face the camera is the camera's business. */
      const spoke = a + (take > 1 ? b / (take - 1) - 0.5 : 0) * 2.4;
      /* a magnitude now, not a signed amount — the sign lived in the lean
         direction the moment that became a world vector */
      const bend = fan * (0.3 + 0.7 * d) * (isWisp ? 1.5 : 1) * (0.35 + 0.65 * rng());
      const yaw = (rng() - 0.5) * 0.95;

      iPos.set([root.x + lx, 0, root.z + lz], i * 3);
      iParams.set(
        isStem
          ? [clumpH * 1.7 + 0.52, clumpW * 0.42, bend * 0.3, rng() * 6.28] // clear of the fluff
          : [h, w, bend, rng() * 6.28],
        i * 4,
      );
      iFace.set([Math.cos(yaw), Math.sin(yaw)], i * 2);
      iLean.set([Math.cos(spoke), Math.sin(spoke)], i * 2);
      iDelay[i] = THREE.MathUtils.clamp(delay + rng() * 0.04, 0, 0.75);
      /* Which blades keep a line is not a fair coin. In the references the
         drawn edges are the lobes on the OUTSIDE of a clump — the inside is
         left as flat mass, which is what stops a dense patch from greying
         out into pencil shading. So a blade's place in the ink queue is
         weighted by how far out of its clump it sits. */
      iInk[i] = isStem ? 0 : Math.min(0.999, rng() * (0.45 + 0.75 * (1 - d)));
      /* A flat random, and it has to be flat: this is the order the field
         thins out in, so anything correlated with where a blade IS would thin
         the field in patches instead of evenly. The stems that carry flowers
         are ranked first so a thinned field keeps its flowers. */
      iRank[i] = isStem ? 0 : rng();
      iShape[i] = isStem ? 2.2 : shape;

      if (isStem)
        flowers.push({
          i,
          size: 0.3 + rng() * 0.14,
          kind: (rng() * DAISY_KINDS.length) | 0,
        });
    }
  }

  /* --- and the ones that came loose --------------------------------------
     Leaves adrift over the patch. They are ordinary blades whose root is in
     the air, which is the whole implementation — the shader reads a non-zero
     height as "this one is floating" and hands it a slow wander instead. */
  for (; i < count; i++) {
    const root = rootFrom(rng, paint, inside);
    const yaw = (rng() - 0.5) * 0.95;

    const spoke = rng() * Math.PI * 2;
    iPos.set([root.x, 0.55 + rng() * 1.9, root.z], i * 3);
    iParams.set(
      [0.2 + rng() * 0.16, 0.1 + rng() * 0.05, 0.6 + rng() * 1.6, rng() * 6.28],
      i * 4,
    );
    iFace.set([Math.cos(yaw), Math.sin(yaw)], i * 2);
    iLean.set([Math.cos(spoke), Math.sin(spoke)], i * 2);
    iDelay[i] = 0.68 + rng() * 0.07; // they come loose once the grass is up
    iInk[i] = rng() * 0.6; // and are mostly drawn, or they vanish
    iShape[i] = 3.2 + rng() * 1.2;
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", LOD_STRIPS[LOD_STRIPS.length - 1].position);
  geo.setIndex(LOD_STRIPS[LOD_STRIPS.length - 1].index.clone());
  geo.setAttribute("iPos", new THREE.InstancedBufferAttribute(iPos, 3));
  geo.setAttribute("iParams", new THREE.InstancedBufferAttribute(iParams, 4));
  geo.setAttribute("iFace", new THREE.InstancedBufferAttribute(iFace, 2));
  geo.setAttribute("iLean", new THREE.InstancedBufferAttribute(iLean, 2));
  geo.setAttribute("iDelay", new THREE.InstancedBufferAttribute(iDelay, 1));
  geo.setAttribute("iInk", new THREE.InstancedBufferAttribute(iInk, 1));
  geo.setAttribute("iShape", new THREE.InstancedBufferAttribute(iShape, 1));
  geo.setAttribute("iRank", new THREE.InstancedBufferAttribute(iRank, 1));
  geo.instanceCount = count;

  const shared = {
    uWireframe: { value: false },
    uWireColor: { value: new THREE.Color(INK) },
    uTime: uniforms.uTime,
    uWind: uniforms.uWind,
    uGrow: uniforms.uGrow,
    uCrop: uniforms.uCrop,
    uLine: uniforms.uLine,
    uInkAmount: uniforms.uInkAmount,
    uInkColor: uniforms.uInkColor,
    uGrass: uniforms.uGrass,
    uGrassPale: uniforms.uGrassPale,
    uGrassDeep: uniforms.uGrassDeep,
    uVary: uniforms.uVary,
    uPatch: uniforms.uPatch,
    uWarm: uniforms.uWarm,
    uCold: uniforms.uCold,
    uWidth: uniforms.uWidth,
    uGust: uniforms.uGust,
    uWindDir: uniforms.uWindDir,
    uBall: uniforms.uBall,
    uTrail: uniforms.uTrail,
    uGrassDepth: uniforms.uGrassDepth,
    uDensity: uniforms.uDensity,
    uCullPad: uniforms.uCullPad,
    ...sunSlots(uniforms),
    ...shadowSlots(uniforms),
    ...fieldSlots(bake),
  };
  /* One pass. The outline used to be a second, slightly fatter copy of every
     blade, which meant two draw calls, twice the vertices, and two coincident
     surfaces arguing about depth for as long as it existed. */
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: shared,
      vertexShader: BLADE_VERT,
      fragmentShader: BLADE_FRAG,
      side: THREE.DoubleSide,
    }),
  );
  mesh.frustumCulled = false;
  group.add(mesh);

  let detail = LOD_STRIPS.length - 1;
  return {
    group,
    geo,
    flowers,
    count,
    data: { iPos, iParams, iLean, iDelay },
    clumps,
    get detail() {
      return detail;
    },
    setDetail(level) {
      if (level === detail) return;
      detail = level;
      geo.setAttribute("position", LOD_STRIPS[level].position);
      // Three caches wireframe indices by index.version. A different LOD
      // with the same version otherwise retains out-of-range old edges.
      const index = LOD_STRIPS[level].index.clone();
      index.version = geo.index.version + 1;
      geo.setIndex(index);
    },
  };
}

/* ---------------------------------------------------------------------------
 * the small flowers
 *
 * Not the daisies on their stems — these are the specks down in the grass:
 * a few dozen little five-petal things in warm colours, low enough that the
 * blades half hide them. They are here to break the texture. A field of one
 * green at one scale reads as material; a field of one green with something
 * small and warm every so often reads as a place.
 *
 * One quad each, billboarded in view space (no Y-axis trick — a flower has
 * no up), tinted per instance, and swaying a little with the wind.
 * ------------------------------------------------------------------------- */
const SPECK_VERT = /* glsl */ `
  attribute vec3  iPos;
  attribute vec3  iColor;    // its petals
  attribute vec3  iCore;     // and its middle, which is the other half of a species
  attribute vec3  iSize;     // size, phase, which of the four it is
  uniform float uTime, uWind, uGrow;
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec3 vCore;
  ${FIELD_GLSL}
  void main(){
    /* its cell of the atlas: two across, two down */
    vec2 cell = vec2(mod(iSize.z, 2.0), floor(iSize.z * 0.5));
    vUv = (uv + cell) * 0.5;
    vColor = iColor;
    vCore = iCore;

    float g = clamp((uGrow - 0.72) / 0.3, 0.0, 1.0);   // they open last of all
    g = g * g * (3.0 - 2.0 * g);
    if (g <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    vec4 mv = modelViewMatrix * vec4(iPos + vec3(0.0, fieldAt(iPos.xz).a, 0.0), 1.0);
    float sway = sin(uTime * 1.3 + iSize.y) * 0.018 * uWind;
    /* and each one is turned differently on its own face. Four shapes stamped
       at the same angle still read as four stamps. */
    float ca = cos(iSize.y), sa = sin(iSize.y);
    vec2 turned = vec2(position.x * ca - position.y * sa, position.x * sa + position.y * ca);
    mv.xy += turned * (iSize.x * g) + vec2(sway, 0.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SPECK_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uInkColor;
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec3 vCore;
  void main(){
    vec4 t = texture2D(uMap, vUv);
    if (t.a < 0.5) discard;
    /* red is petal, green is centre, and what is neither is the line */
    float petal = t.r, core = t.g;
    float line = clamp(1.0 - petal - core, 0.0, 1.0);
    vec3 c = (vColor * petal + vCore * core + uInkColor * line) / max(0.001, petal + core + line);
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }
`;

export function buildSpecks(field, paint, count, uniforms, map, world, bake) {
  const { rng, density } = field;
  const { inside } = paint.lists();
  if (!inside.length) return null;

  const iPos = new Float32Array(count * 3);
  const iColor = new Float32Array(count * 3);
  const iCore = new Float32Array(count * 3);
  const iSize = new Float32Array(count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    /* The opposite roll to a blade's. A blade is kept where the density and
       thickness fields are high; a speck is kept where they are LOW, and
       near the edge rather than deep in — the thin ground, the small
       outlying tufts, the gaps. A flower in the middle of a thick clump is
       a flower nobody ever sees. */
    let p = rootFrom(rng, paint, inside);
    for (
      let tries = 0;
      tries < 6 && rng() < density(p) * p.thick * (0.35 + 0.65 * p.depth);
      tries++
    ) {
      p = rootFrom(rng, paint, inside);
    }
    /* a flower under a stone is a flower nobody sees, same as before */
    for (let tries = 0; tries < 4 && standingAt(world, p.x, p.z).clear; tries++) {
      p = rootFrom(rng, paint, inside);
    }
    const scale = 0.55 + 0.45 * (1 - p.depth);

    /* sitting in the grass, not on top of it, and never quite at ground
       level or they read as painted spots on the floor */
    iPos.set([p.x, 0.04 + rng() * 0.3 * scale, p.z], i * 3);
    c.set(PETALS[(rng() * PETALS.length) | 0]);
    iColor.set([c.r, c.g, c.b], i * 3);
    c.set(PETAL_CORES[(rng() * PETAL_CORES.length) | 0]);
    iCore.set([c.r, c.g, c.b], i * 3);
    /* the fine-rayed one is a smaller flower than the four-petal one, so the
       kind leans on the size a little rather than every species being the
       same width across */
    const kind = (rng() * PETAL_KINDS) | 0;
    const spread = kind === 1 ? 0.78 : kind === 3 ? 1.15 : 1;
    iSize.set([(0.15 + rng() * 0.15) * scale * spread, rng() * 6.28, kind], i * 3);
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
      3,
    ),
  );
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute("iPos", new THREE.InstancedBufferAttribute(iPos, 3));
  geo.setAttribute("iColor", new THREE.InstancedBufferAttribute(iColor, 3));
  geo.setAttribute("iCore", new THREE.InstancedBufferAttribute(iCore, 3));
  geo.setAttribute("iSize", new THREE.InstancedBufferAttribute(iSize, 3));
  geo.instanceCount = count;

  const mesh = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: {
        uTime: uniforms.uTime,
        uWind: uniforms.uWind,
        uGrow: uniforms.uGrow,
        uInkColor: uniforms.uInkColor,
        uMap: { value: map },
        ...fieldSlots(bake),
      },
      vertexShader: SPECK_VERT,
      fragmentShader: SPECK_FRAG,
      side: THREE.DoubleSide,
    }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

/* ---------------------------------------------------------------------------
 * daisies
 *
 * Drawn once into a 2D canvas — petals in white, closed with the same ink —
 * and pinned to the tip of the stem that carries them. The tip is the one
 * place the blade maths has to be repeated on the CPU.
 * ------------------------------------------------------------------------- */
/* Six of them, not one.
 *
 * These are the heads on stems, and unlike the specks they are sprites — so
 * they cannot take a colour per instance and each kind has to be its own
 * texture. Six textures and six materials, SHARED, is also strictly less than
 * what was here before: every head used to be handed a SpriteMaterial of its
 * own, forty of them, all identical. */
export const DAISY_KINDS = [
  { petals: 7, rx: 22, ry: 42, at: 62, eye: 26, fill: "#fdfdf7", core: "#e5dc82" },
  { petals: 5, rx: 30, ry: 34, at: 54, eye: 22, fill: "#f6e79a", core: "#d08b34" },
  { petals: 13, rx: 9, ry: 48, at: 60, eye: 30, fill: "#fbf6ec", core: "#c9772f" },
  { petals: 6, rx: 26, ry: 38, at: 58, eye: 20, fill: "#f0b9c6", core: "#b8577a" },
  { petals: 8, rx: 16, ry: 44, at: 60, eye: 24, fill: "#cfd6ee", core: "#7d6bb0" },
  { petals: 4, rx: 34, ry: 30, at: 50, eye: 18, fill: "#f8d9a4", core: "#a4562c" },
];

export function daisyTexture(k) {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  g.translate(S / 2, S / 2);
  g.strokeStyle = INK;
  g.lineWidth = 7;
  g.lineJoin = g.lineCap = "round";
  g.fillStyle = k.fill;
  for (let i = 0; i < k.petals; i++) {
    g.save();
    g.rotate((i / k.petals) * Math.PI * 2 + 0.2);
    g.beginPath();
    g.ellipse(0, -k.at, k.rx, k.ry, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.restore();
  }
  g.beginPath();
  g.arc(0, 0, k.eye, 0, Math.PI * 2);
  g.fillStyle = k.core;
  g.fill();
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ---------------------------------------------------------------------------
 * the palette, as uniforms
 *
 * One table for the grass AND every object that stands in it. That sharing is
 * the point rather than a convenience: a key dropped into the field catches
 * the same gold patch the grass around it caught, and that is the only reason
 * any of it looks like one drawing.
 *
 * A factory and not a constant, because two pages must not share one set of
 * live THREE.Color instances — the editor writes to these on every slider.
 * ------------------------------------------------------------------------- */
export function makeUniforms() {
  return {
    uTime: { value: 0 },
    uWind: { value: REDUCED ? 0 : 0.55 },
    uGrow: { value: 0 },
    /* A live multiplier on every blade's height, 1 at full length.
       `uGrow` cannot do this job: it is the entrance, staggered per blade by
       `iDelay`, and blades whose `g` reaches 0 are discarded outright — so
       driving it down to shorten the sward would make blades vanish at
       different moments rather than the field getting shorter. This scales
       what `uGrow` has already opened. */
    uCrop: { value: 1 },
    uReveal: { value: 0 },
    uLine: { value: 1.3 }, // the blade outline, in pixels — same units as uEdge
    uInkAmount: { value: 0.5 },
    uInkColor: { value: new THREE.Color(INK) },
    uGrass: { value: new THREE.Color(GRASS) },
    uGrassPale: { value: new THREE.Color(GRASS_PALE) },
    uGrassDeep: { value: new THREE.Color(GRASS_DEEP) },
    uVary: { value: 0.55 },
    uPatch: { value: 0.5 },
    uWarm: { value: new THREE.Color(GRASS_WARM) },
    uCold: { value: new THREE.Color(GRASS_COLD) },
    uWidth: { value: 1 },
    uEdge: { value: 1.8 }, // the ground's contour, in pixels
    uGust: { value: 0.75 },
    uWindDir: { value: new THREE.Vector2(1, 0.35).normalize() },
    uBall: { value: new THREE.Vector4(0, 0, 0, 0) },
    uTrail: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) },

    /* ---- the light ---------------------------------------------------------
       Two colours, a direction and how hard the line between them is — see
       shade.js, which is where the reasoning for that being the whole model
       lives. Everything here is derived from cfg.sun by placeSun() except the
       colours and the three amounts, which are yours.

       uCasters is the only thing in this table that is not a setting: it is
       rewritten from the objects' own footprints whenever anything moves. */
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunSkew: { value: new THREE.Vector2(0, 0) },
    uSunColor: { value: new THREE.Color(SUNLIGHT) },
    uShadeColor: { value: new THREE.Color(SHADOW) },
    uSunAmount: { value: 0.22 },
    uSunEdge: { value: 0.6 },
    uShadowAmount: { value: 0.55 },
    uShadowSoft: { value: 0.45 },
    uGrassDepth: { value: 0.25 },
    uCasters: {
      value: Array.from({ length: MAX_CASTERS }, () => new THREE.Vector4(0, 0, 0, 0)),
    },

    /* both worked out from the camera every frame, in step() */
    uDensity: { value: 1 },
    uCullPad: { value: new THREE.Vector2(2, 2) },

    /* ---- the hills ---------------------------------------------------------
       How high, and how far apart. Both are live: the ground, the blades and
       the specks are all displaced in their own vertex shaders, so dragging
       Hills rolls the whole field in real time and nothing is rebuilt. Only the
       objects and the ball are placed by the CPU, and they are re-placed on the
       same stroke. uHillSeed comes off cfg.seed, so Replant moves the hills as
       well as the grass on them. */
    uHills: { value: 1.4 },
    uHillSize: { value: 13 },
    uHillSeed: { value: new THREE.Vector2(0, 0) },

    /* ---- what the objects are made of --------------------------------------
       The scene's palette, which every asset clones at birth. Sharing the
       grass's own uWarm/uCold/uVary/uPatch is deliberate: a key dropped into
       the field catches the same gold patch the grass around it caught, which
       is the only reason any of it looks like one drawing. */
    uSharp: { value: 0.25 },
    uFaceTone: { value: 0.05 },
    uHull: { value: 0.02 },

    uKey: { value: new THREE.Color("#e7e4d8") },
    uKeyPale: { value: new THREE.Color("#f2efe4") },
    uKeyDeep: { value: new THREE.Color("#d6d2c2") },

    uMug: { value: new THREE.Color("#f1ece0") },
    uMugPale: { value: new THREE.Color("#faf6ec") },
    uMugDeep: { value: new THREE.Color("#ded7c6") },
    uStripe: { value: new THREE.Color("#f2d275") },
    uDrink: { value: new THREE.Color("#5a3524") },
    uDrinkPale: { value: new THREE.Color("#8a5330") },
    uDrinkDeep: { value: new THREE.Color("#331d13") },
    uSwirl: { value: 0.55 },

    uStone: { value: new THREE.Color("#cfc9bb") },
    uStonePale: { value: new THREE.Color("#e6e1d4") },
    uStoneSide: { value: new THREE.Color("#b6b0a0") },
    uStoneDeep: { value: new THREE.Color("#a8a293") },
    uEarth: { value: new THREE.Color("#b0a894") },
    uGrit: { value: 0.35 },
    uWearBand: { value: 0.06 },

    uCushion: { value: new THREE.Color("#e8c463") },
    uCushionPale: { value: new THREE.Color("#f2d888") },
    uCushionDeep: { value: new THREE.Color("#c19a3c") },
    uWeave: { value: 0.3 },

    uPanel: { value: new THREE.Color("#8b9a76") },
    uPanelPale: { value: new THREE.Color("#a3b08c") },
    uPanelDeep: { value: new THREE.Color("#6d7a5c") },
    uPaperSheet: { value: new THREE.Color("#f4f1e6") },
    uPanelText: { value: new THREE.Color("#6f7468") },
    uPanelChip: { value: new THREE.Color("#8d9aa8") },

    uChair: { value: new THREE.Color("#93a67e") },
    uChairPale: { value: new THREE.Color("#aab894") },
    uChairDeep: { value: new THREE.Color("#6f8060") },
    uChairLeg: { value: new THREE.Color("#c9c4b6") },
    uGrain: { value: 0.22 },

    uTin: { value: new THREE.Color("#c2c3bd") },
    uTinPale: { value: new THREE.Color("#dcdcd5") },
    uTinDeep: { value: new THREE.Color("#8f9089") },
    uScuff: { value: 0.4 },
    uInside: { value: 0.5 },

    uBark: { value: new THREE.Color("#9d8468") },
    uBarkDeep: { value: new THREE.Color("#5f4c39") },
    uBarkPale: { value: new THREE.Color("#c0a884") },
    uHeart: { value: new THREE.Color("#c9a878") },
    uRingColor: { value: new THREE.Color("#a07f56") },
    uSap: { value: new THREE.Color("#e2cba1") },
    uFissure: { value: 0.75 },
    uRingCount: { value: 14 },
    uPithOff: { value: 0.22 },
    uChecks: { value: 4 },
    uWoodGrain: { value: 0.85 },
  };
}

/* ---------------------------------------------------------------------------
 * the ground and the blade tips, on the CPU
 *
 * Anything this side of the program places ON the grass needs the same answers
 * the vertex shaders are computing on the GPU: a bench stands at the ground's
 * height, and a daisy head is pinned to the top of a stem the blade shader is
 * bending. So TERRAIN_GLSL and the blade shader's noise are written out a
 * second time here and the two have to agree to the last decimal — the cost of
 * them drifting is a flower floating an inch off its own stalk and a bench
 * standing in the air. It is a dozen lines said twice against a GPU readback
 * that would cost a frame.
 *
 * Factories over the uniforms rather than bare functions, because the uniforms
 * are per-page now: two pages have two hill seeds, and one shared hillsAt would
 * answer for whichever page happened to build last.
 * ------------------------------------------------------------------------- */
const fract = (x) => x - Math.floor(x);
const hash21 = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453123);

function vnoise(x, y) {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const fx = x - ix,
    fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy),
    b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1),
    d = hash21(ix + 1, iy + 1);
  const top = a + (b - a) * ux;
  return top + (c + (d - c) * ux - top) * uy;
}

const fbm2 = (x, y) =>
  0.58 * vnoise(x, y) +
  0.28 * vnoise(x * 2.13 + 3.7, y * 2.13 + 3.7) +
  0.14 * vnoise(x * 4.37 + 11.2, y * 4.37 + 11.2);

export function makeTerrain(uniforms) {
  function hillsAt(x, z) {
    const a = uniforms.uHills.value;
    if (a <= 0) return 0;
    const s = Math.max(uniforms.uHillSize.value, 0.5);
    const seed = uniforms.uHillSeed.value;
    const px = x / s + seed.x;
    const pz = z / s + seed.y;
    return (
      (vnoise(px, pz) * 0.72 + vnoise(px * 2.31 + 5.1, pz * 2.31 + 5.1) * 0.28 - 0.5) *
      4 *
      a
    );
  }

  /* which way the ground falls away from here, for anything that has to roll */
  const slopeAt = (x, z, d = 0.35) => ({
    x: (hillsAt(x + d, z) - hillsAt(x - d, z)) / (2 * d),
    z: (hillsAt(x, z + d) - hillsAt(x, z - d)) / (2 * d),
  });

  return { hillsAt, slopeAt };
}

/* Where instance `i`'s blade tip actually is this frame, wind and all. Bound
   to one blades object because it reads that object's instance attributes. */
export function makeTipOf(blades, uniforms, hillsAt) {
  const push = new THREE.Vector3();

  return function tipOf(i, time) {
    const { iPos, iParams, iLean, iDelay } = blades.data;
    const px = iPos[i * 3],
      pz = iPos[i * 3 + 2];
    const py = iPos[i * 3 + 1] + hillsAt(px, pz);
    const h0 = iParams[i * 4],
      rest = iParams[i * 4 + 2],
      phase = iParams[i * 4 + 3];

    let g = THREE.MathUtils.clamp((uniforms.uGrow.value - iDelay[i]) / 0.32, 0, 1);
    g = g * g * (3 - 2 * g);

    const dir = uniforms.uWindDir.value;
    push.set(iLean[i * 2] * rest, 0, iLean[i * 2 + 1] * rest);

    const wave =
      fbm2(px * 0.13 - dir.x * time * 1.15, pz * 0.13 - dir.y * time * 1.15) * 2 - 1;
    const wind = uniforms.uWind.value;
    const flutter = Math.sin(time * 3.3 + phase * 2.1) * 0.09;
    const force = Math.max(
      0,
      wind * (0.42 + uniforms.uGust.value * wave) + flutter * wind,
    );
    push.x += dir.x * force;
    push.z += dir.y * force;

    let squash = 0;
    const b = uniforms.uBall.value;
    if (b.w > 0) {
      const dx = px - b.x,
        dz = pz - b.z;
      const dist = Math.hypot(dx, dz) || 1e-3;
      const k = 1 - THREE.MathUtils.smoothstep(dist, b.w * 0.5, b.w * 2.1);
      push.x += (dx / dist) * k * 1.7;
      push.z += (dz / dist) * k * 1.7;
      squash = k;
    }

    /* uCrop as well as uGrow — a daisy is pinned to the tip of a blade, and a
       tip computed from the uncropped height leaves the flower hanging in the
       air above a sward that has just been shortened. */
    const h =
      h0 * g * uniforms.uCrop.value * (1 - 0.6 * THREE.MathUtils.clamp(squash, 0, 1));
    const over = Math.min(push.lengthSq(), 2);

    return {
      x: px + push.x * h,
      y: py + h * (1 - 0.18 * over),
      z: pz + push.z * h,
      g,
    };
  };
}
