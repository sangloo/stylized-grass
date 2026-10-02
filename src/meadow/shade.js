/* ---------------------------------------------------------------------------
 * shade.js — the one shading language everything on these pages speaks.
 *
 * Two ideas, and they are the whole look:
 *
 *   washAt   one flat colour drifting between a lighter and a deeper version
 *            of itself over a slow noise field. Sampled in WORLD space, so
 *            two objects standing in the same place agree on their colour.
 *
 *   patchAt  a second, finer field that only surfaces on its peaks, pushing
 *            small islands warm or cool. This is the one you are meant to
 *            notice; the wash is the one you are not.
 *
 * It lives in its own file because the grass and the keycaps have to use the
 * same field, not two fields that look similar. A key sitting in the grass
 * has to catch the same gold patch the grass around it caught, or it reads as
 * a sticker on top of a drawing rather than a thing in it.
 * ------------------------------------------------------------------------- */

export const NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p){
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p){
    return 0.58 * vnoise(p) + 0.28 * vnoise(p * 2.13 + 3.7) + 0.14 * vnoise(p * 4.37 + 11.2);
  }

  /* Sharpness narrows the band the wash crosses in. At 0 it is the long
     smoothstep it always was and the tone drifts; at 1 the band is almost
     nothing and the field breaks into flat regions with definite edges,
     which is what a painter filling shapes actually produces. */
  vec3 washAt(vec2 xz, vec3 base, vec3 pale, vec3 deep, float amount, float sharp){
    float n = fbm(xz * 0.34);
    vec3 tone = mix(deep, pale, smoothstep(mix(0.24, 0.47, sharp), mix(0.76, 0.53, sharp), n));
    return mix(base, tone, amount);
  }

  /* the old five-argument form, kept because GLSL overloads and because the
     grass next door calls it and has no opinion about sharpness */
  vec3 washAt(vec2 xz, vec3 base, vec3 pale, vec3 deep, float amount){
    return washAt(xz, base, pale, deep, amount, 0.0);
  }

  /* the small strong ones, laid over the wash. smoothstep well up the range
     is what keeps them to the peaks — most of the field never sees this. */
  vec3 patchAt(vec2 xz, vec3 c, vec3 warm, vec3 cold, float amount, float sharp){
    float m = fbm(xz * 1.05 + 21.7);
    float here = smoothstep(mix(0.58, 0.655, sharp), mix(0.79, 0.675, sharp), m);
    float side = smoothstep(0.42, 0.58, fbm(xz * 0.17 + 5.1));   // gold or shade
    return mix(c, mix(cold, warm, side), here * amount);
  }

  vec3 patchAt(vec2 xz, vec3 c, vec3 warm, vec3 cold, float amount){
    return patchAt(xz, c, warm, cold, amount, 0.0);
  }
`;

/* ---------------------------------------------------------------------------
 * the line
 *
 * Every drawn edge on these pages is measured the same way: the fragment is
 * given its distance to the nearest edge in WORLD units, fwidth turns that
 * into pixels, and the line is a constant number of pixels wide however far
 * away the thing is or how small it is on screen. Nothing is ever drawn twice
 * to make an outline — a second, fatter copy of a shape will always argue
 * with the original about depth, and no offset settles it.
 * ------------------------------------------------------------------------- */
export const LINE_GLSL = /* glsl */ `
  float lineAt(float dist, float widthPx){
    float px = max(fwidth(dist), 1e-6);
    return 1.0 - smoothstep(widthPx * px * 0.35, widthPx * px * 1.15, dist);
  }
`;

/* ---------------------------------------------------------------------------
 * ownColours
 *
 * Every asset takes its colours from the page palette, but takes a COPY. An
 * asset bench where changing one stone changes every stone is a bench you
 * cannot compare two stones on — which is the only reason to have a bench.
 * The clone means each thing starts in the family and can leave it.
 * ------------------------------------------------------------------------- */
export function ownColours(palette, map) {
  const out = {};
  for (const [key, name] of Object.entries(map)) {
    out[key] = { value: palette[name].value.clone() };
  }
  return out;
}

/* the same for the numbers. A colour has to be cloned because it is an
   object; a number copies itself, so this is only here to keep the two
   readable side by side. */
export function ownValues(palette, map) {
  const out = {};
  for (const [key, name] of Object.entries(map))
    out[key] = { value: palette[name].value };
  return out;
}

/* ---------------------------------------------------------------------------
 * the ground under the ground
 *
 * This drawing was flat on purpose. The note in canvas.js said it best: the
 * ground is a shape on paper, not terrain, and a dome only ever showed up as
 * shading — which was the one thing the picture did not have. That was true
 * right up until the light went in. A hill is nothing but the shading on it,
 * so now that faces are lit and shaded there is something for a hill to BE.
 *
 * Two octaves, not the usual three. Hills want to roll, and the third octave
 * of an fbm is the one that turns a hill into gravel.
 *
 * Everything that stands on the ground reads this: the ground itself, every
 * blade, the specks, and — on the CPU, through a copy of it written out in
 * JavaScript — the objects, the daisies and the ball. The two have to agree
 * exactly or things sink into the hill they are standing on.
 * ------------------------------------------------------------------------- */
export const TERRAIN_GLSL = /* glsl */ `
  uniform float uHills, uHillSize;
  uniform vec2  uHillSeed;

  /* The 4.0 is a calibration, not a taste. Two octaves of value noise only
     ever wander over about half of their nominal 0..1, so the naive *2.0
     made the Hills slider a liar: it said 0.55 and it drew 0.2, which is
     ground you cannot see from an isometric camera. This makes the number on
     the slider the height of a hill in world units, which is the only thing
     it could usefully mean. */
  float hillsAt(vec2 xz){
    if (uHills <= 0.0) return 0.0;
    vec2 p = xz / max(uHillSize, 0.5) + uHillSeed;
    return (vnoise(p) * 0.72 + vnoise(p * 2.31 + 5.1) * 0.28 - 0.5) * 4.0 * uHills;
  }

  /* The slope. Forward differences off a height the caller already needed for
     the displacement, so a hill normal costs two more samples rather than
     four — which matters, because the blades ask for one per vertex and there
     are a hundred thousand of them. */
  vec3 hillNormal(vec2 xz, float h0){
    if (uHills <= 0.0) return vec3(0.0, 1.0, 0.0);
    float d = max(uHillSize, 0.5) * 0.08;
    return normalize(vec3(h0 - hillsAt(xz + vec2(d, 0.0)), d, h0 - hillsAt(xz + vec2(0.0, d))));
  }
`;

/* ---------------------------------------------------------------------------
 * and the shadows the ground throws on itself
 *
 * Objects got their shadows from a capsule test, which works because an object
 * is one squat shape at a known place. A hill is not: it is the ground, all of
 * it, and the only thing that knows whether a hollow is in the shade of the
 * ridge beside it is the height field.
 *
 * So this walks it. Ten steps up the light's own direction, asking each time
 * whether the ground has climbed above the ray leaving this point towards the
 * sun. That is the whole of a height-field shadow, and it is the reason a low
 * sun now pools the valleys in shade instead of lighting every slope equally.
 *
 * Ten steps is not many, and it does not have to be: this is evaluated per
 * VERTEX — on a ground grid whose cells are six-tenths of a unit, and once per
 * blade at its root — and interpolated between. A shadow cast by a hill is the
 * softest edge in the picture, so the one thing it can afford is to be
 * sampled coarsely and smoothed.
 * ------------------------------------------------------------------------- */
export const HILL_SHADOW_GLSL = /* glsl */ `
  float hillShadow(vec2 xz, float h0, vec3 sunDir){
    if (uHills <= 0.0) return 0.0;
    /* Not called "flat": that is an interpolation qualifier in GLSL ES 3.00
       and a reserved word, which costs two silently unlinked programs and a
       scene with no ground in it to find out. */
    float run = max(length(sunDir.xz), 1e-3);
    vec2  dir = sunDir.xz / run;
    float climb = sunDir.y / run;               // how fast the ray rises

    /* No further than the tallest hill could possibly reach at this sun angle,
       and no further than a couple of hills either way — marching past that is
       ten samples spent on ground that cannot be in the way. */
    float reach = min(uHills * 3.0 / max(climb, 0.12), uHillSize * 2.5);

    float s = 0.0;
    for (int k = 1; k <= 10; k++) {
      float d = reach * float(k) * 0.1;
      float over = hillsAt(xz + dir * d) - (h0 + climb * d);
      /* how far above the ray, as a fraction of what a hill even is — so the
         edge softens by itself rather than needing a threshold */
      s = max(s, over / max(uHills, 0.001));
    }
    return clamp(s * 2.5, 0.0, 1.0);
  }
`;

export const terrainSlots = (p) => ({
  uHills: p.uHills,
  uHillSize: p.uHillSize,
  uHillSeed: p.uHillSeed,
});

/* ---------------------------------------------------------------------------
 * the light
 *
 * Not a lighting model. A painter working in this style does not compute a
 * falloff — they decide where the sun is, fill every face turned towards it
 * with one colour and every face turned away with another, and draw a hard
 * line between the two. So that is what this is: two colours, a direction,
 * and how sharp the line between them is.
 *
 * The one thing that has to be right is HOW the two colours are applied. Laid
 * over the fill they paint a blue disc on green grass, which is what the
 * first pass at this did and it looked like a sticker. Light does not replace
 * a colour, it filters it — a shaded green is a deeper, colder green, and it
 * is still the green. So both tones go through soft light, which darkens
 * under a dark swatch, lifts under a pale one, is exactly neutral at mid grey
 * and cannot blow out at either end. That is also what makes the two swatches
 * mean what they say: `sunlight` is a pale warm colour and `shadow` is a deep
 * cool one, the way anyone would write them down.
 * ------------------------------------------------------------------------- */
export const LIGHT_GLSL = /* glsl */ `
  vec3 softLight(vec3 b, vec3 s){
    return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s));
  }
  /* every tone in this file arrives as "how far from neutral, in which
     colour", so this is the only way any of them are ever applied */
  vec3 tone(vec3 c, vec3 colour, float amount){
    return softLight(c, mix(vec3(0.5), colour, clamp(amount, 0.0, 1.0)));
  }
`;

export const SUN_GLSL = /* glsl */ `
  uniform vec3  uSunDir;                 // world, normalised, pointing AT the sun
  uniform vec3  uSunColor, uShadeColor;
  uniform float uSunAmount, uSunEdge;
  ${LIGHT_GLSL}

  /* ---- relief ------------------------------------------------------------
     sunTone answers "which side of the terminator is this face on". That is
     the right question for a keycap and the wrong one for a hillside: at any
     amplitude a rolling hill can reach, EVERY slope on it is on the lit side,
     so the two-tone says the same thing about all of them and the hill
     vanishes — which is exactly what the first pass at this looked like.

     So relief asks the other question: how much more, or less, than flat
     ground does this face the sun. Flat comes out at precisely zero, so the
     ground keeps the tone it had and a hill is the only thing that appears. */
  vec3 reliefTone(vec3 c, vec3 n, float amount){
    if (amount <= 0.0) return c;
    float rel = dot(normalize(n), uSunDir) - uSunDir.y;
    return tone(c, rel > 0.0 ? uSunColor : uShadeColor, abs(rel) * amount);
  }

  vec3 sunTone(vec3 c, vec3 n){
    if (uSunAmount <= 0.0) return c;
    /* the terminator. At uSunEdge 1 the band is two hundredths of a dot
       product wide and a face is simply one colour or the other; at 0 it is
       the whole hemisphere and the tone drifts round the form, which is a
       render rather than a drawing. */
    float w = mix(1.0, 0.02, uSunEdge);
    float k = smoothstep(-w, w, dot(normalize(n), uSunDir));
    return tone(c, mix(uShadeColor, uSunColor, k), uSunAmount);
  }
`;

/* How many things can throw a shadow at once. Sixteen is more than any scene
   on this page has had, and the cost is sixteen iterations in one fragment
   shader — but it IS a cap, so when it is reached the scene drops the
   smallest footprints rather than pretending it drew them all. */
export const MAX_CASTERS = 16;

/* ---------------------------------------------------------------------------
 * the shadows
 *
 * A caster is a circle standing on the ground with a height, and under a
 * directional light what it throws is that circle dragged along the ground
 * away from the light — so the shadow is a capsule from the object's own
 * foot to a point its height away, not a disc sitting beside it. The
 * difference is the whole thing: a shadow that touches the base reads as
 * cast, and one that does not reads as an object hovering over a stain.
 *
 * That is not an approximation either. For a vertical cylinder it is the
 * shadow, exactly, and it costs a dot product. Anything more — a depth pass,
 * a shadow map, a second camera — would buy a fidelity this drawing has no
 * use for and a frame budget it does not have.
 * ------------------------------------------------------------------------- */
export const SHADOW_GLSL = /* glsl */ `
  uniform vec4  uCasters[${MAX_CASTERS}];   // x, height, z, radius — radius 0 is an empty slot
  uniform vec2  uSunSkew;                   // how far a shadow slides per unit of height
  uniform float uShadowAmount, uShadowSoft;

  float castShadow(vec2 xz){
    if (uShadowAmount <= 0.0) return 0.0;
    float s = 0.0;
    for (int i = 0; i < ${MAX_CASTERS}; i++) {
      vec4 c = uCasters[i];
      vec2 pa = xz - c.xz;
      vec2 ba = uSunSkew * c.y;
      float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      float d = length(pa - ba * t) / max(c.w, 1e-4);
      float here = 1.0 - smoothstep(mix(0.96, 0.05, uShadowSoft), 1.0, d);
      /* darkest where the thing meets the ground and thinner at the far end,
         which is both what a real one does and what stops a long shadow from
         reading as a second object lying down */
      s = max(s, step(1e-4, c.w) * here * mix(1.0, 0.45, t));
    }
    return s * uShadowAmount;
  }
`;

/* the slots every material needs to speak about the light, and the extra
   ones only the things that RECEIVE a shadow need */
export const sunSlots = (p) => ({
  uSunDir: p.uSunDir,
  uSunColor: p.uSunColor,
  uShadeColor: p.uShadeColor,
  uSunAmount: p.uSunAmount,
  uSunEdge: p.uSunEdge,
});

export const shadowSlots = (p) => ({
  uCasters: p.uCasters,
  uSunSkew: p.uSunSkew,
  uShadowAmount: p.uShadowAmount,
  uShadowSoft: p.uShadowSoft,
});
