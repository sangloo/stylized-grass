/* ---------------------------------------------------------------------------
 * field.js — the ground, worked out once.
 *
 * Everything the ground is made of is a function of one thing: where you are
 * standing. The wash, the warm and cool patches, the height of the hill, which
 * way its face turns and whether the ridge behind it is in the way — all of
 * them take a world x and z and nothing else. Not the time, not the vertex,
 * not which blade is asking.
 *
 * They were being evaluated per VERTEX, and a blade is twenty-two vertices, so
 * every blade asked the same question twenty-two times and got the same answer
 * twenty-two times. A GPU timer put that redundancy at 45% of the whole frame
 * at three hundred thousand blades — more than the ground, the objects, the
 * shadows and the fragments put together.
 *
 * So it is computed once, into a texture over the field, and everything that
 * stands on the ground reads it: the ground, every blade, every speck. One
 * fetch replaces about a hundred sines.
 *
 *   RGB  the ground's colour — wash, patches, the sun, the relief on a slope,
 *        and the shadow of whatever hill is upwind of it
 *   A    how high the ground is here
 *
 * What is NOT baked is anything that moves on its own: the wind, and the
 * shadows objects and the ball throw. Those stay live in the shaders that
 * want them, because a texture that has to be redrawn every frame is not a
 * saving. This one is redrawn when a slider says something it depends on has
 * changed, which is exactly as often as it needs to be and no more.
 * ------------------------------------------------------------------------- */

import * as THREE from "three";
import {
  NOISE_GLSL,
  TERRAIN_GLSL,
  SUN_GLSL,
  HILL_SHADOW_GLSL,
  sunSlots,
  terrainSlots,
} from "./shade.js";

/* 1024 across the same 96 units the paint field covers — 0.094 world units a
   texel, which is finer than the ground's own grid and far finer than the
   slowest thing in here (the patch noise, about a unit across). */
const N = 1024;

const BAKE_VERT = /* glsl */ `
  varying vec2 vXZ;
  uniform float uFieldExtent;
  void main(){
    vXZ = (uv - 0.5) * uFieldExtent;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BAKE_FRAG = /* glsl */ `
  uniform vec3  uGrass, uGrassPale, uGrassDeep, uWarm, uCold;
  uniform float uVary, uPatch, uRelief;
  /* SHADOW_GLSL is where this normally lives, and it is not included here —
     the object shadows it belongs to are the one thing that cannot be baked */
  uniform float uShadowAmount;
  varying vec2  vXZ;
  ${NOISE_GLSL}
  ${TERRAIN_GLSL}
  ${SUN_GLSL}
  ${HILL_SHADOW_GLSL}
  void main(){
    float h = hillsAt(vXZ);

    vec3 c = washAt(vXZ, uGrass, uGrassPale, uGrassDeep, uVary);
    c = patchAt(vXZ, c, uWarm, uCold, uPatch);
    c = sunTone(c, vec3(0.0, 1.0, 0.0));
    c = reliefTone(c, hillNormal(vXZ, h), uSunAmount * uRelief);
    c = tone(c, uShadeColor, hillShadow(vXZ, h, uSunDir) * uShadowAmount);

    gl_FragColor = vec4(c, h);
  }
`;

/* What the bake depends on. Watched rather than dirty-flagged, because a flag
   is a promise every future control has to remember to keep and a signature is
   not — add a slider that changes the ground and this notices by itself. */
const WATCHED = [
  "uHills",
  "uHillSize",
  "uSunAmount",
  "uSunEdge",
  "uShadowAmount",
  "uShadowSoft",
  "uVary",
  "uPatch",
];
const WATCHED_COLOURS = [
  "uGrass",
  "uGrassPale",
  "uGrassDeep",
  "uWarm",
  "uCold",
  "uSunColor",
  "uShadeColor",
];

export function makeFieldBake(uniforms, extent, relief) {
  const target = new THREE.WebGLRenderTarget(N, N, {
    type: THREE.HalfFloatType, // the height is signed and the colour is not 8-bit flat
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace; // this is data, not a picture

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uGrass: uniforms.uGrass,
      uGrassPale: uniforms.uGrassPale,
      uGrassDeep: uniforms.uGrassDeep,
      uWarm: uniforms.uWarm,
      uCold: uniforms.uCold,
      uVary: uniforms.uVary,
      uPatch: uniforms.uPatch,
      uRelief: { value: relief },
      uFieldExtent: { value: extent },
      ...sunSlots(uniforms),
      ...terrainSlots(uniforms),
      uShadowAmount: uniforms.uShadowAmount,
      uShadowSoft: uniforms.uShadowSoft,
    },
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let was = null;
  let bakes = 0;

  const signature = () => {
    const parts = [
      uniforms.uHillSeed.value.x,
      uniforms.uHillSeed.value.y,
      ...uniforms.uSunDir.value.toArray(),
      /* Relief belongs in here for exactly the reason the block above gives:
         it changes the ground, so the bake has to notice by itself. It was
         the one input that arrived as an argument rather than as a uniform,
         which is how it slipped past a list that only reads `uniforms`. */
      material.uniforms.uRelief.value,
    ];
    for (const k of WATCHED) parts.push(uniforms[k].value);
    for (const k of WATCHED_COLOURS) parts.push(uniforms[k].value.getHex());
    return parts.join(",");
  };

  return {
    texture: target.texture,
    extent,
    get bakes() {
      return bakes;
    },

    /* How hard a slope is toned toward the sun. Live, because it is the
       single loudest control over how much colour the field keeps, and
       finding that out took an afternoon of darkening things downstream of
       it that could not have helped. */
    get relief() {
      return material.uniforms.uRelief.value;
    },
    set relief(v) {
      material.uniforms.uRelief.value = v;
    },

    /* called every frame and does nothing on almost all of them */
    ensure(renderer) {
      const now = signature();
      if (now === was) return false;
      was = now;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prev);
      bakes++;
      return true;
    },

    sample(renderer, x, z) {
      this.ensure(renderer);
      const px = THREE.MathUtils.clamp(Math.floor((x / extent + 0.5) * N), 0, N - 1);
      const py = THREE.MathUtils.clamp(Math.floor((z / extent + 0.5) * N), 0, N - 1);
      const pixel = new Uint16Array(4);
      renderer.readRenderTargetPixels(target, px, py, 1, 1, pixel);
      return Array.from(pixel, THREE.DataUtils.fromHalfFloat);
    },
    dispose() {
      target.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}

/* what everything downstream reads instead of doing the maths */
export const FIELD_GLSL = /* glsl */ `
  uniform sampler2D uField;
  uniform float uFieldExtent;

  vec4 fieldAt(vec2 xz){
    return texture2D(uField, xz / uFieldExtent + 0.5);
  }
`;

export const fieldSlots = (field) => ({
  uField: { value: field.texture },
  uFieldExtent: { value: field.extent },
});
