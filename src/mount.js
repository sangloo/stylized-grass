/* ---------------------------------------------------------------------------
 * field.js — a meadow with nothing on top of it.
 *
 * The home page's engine is one function that owns a renderer, a hero, a
 * masthead, a track, an entrance and a sunset. That is correct for a home page
 * and useless for an experiment: a sketch that has to stand up the whole page
 * to change one uniform is not isolating anything.
 *
 * So this is the field and only the field. It takes an element, builds the
 * scene out of the same `_meadow/*` modules the home page uses, and hands back
 * the handles — the rig, the uniforms, the paint, the frame loop. Everything a
 * sketch wants to try is then a few lines against those.
 *
 * **It does not import from `_meadow/clearing.js` and never should.** The
 * point of the lab is that nothing here can break the home page, and the only
 * way to guarantee that is to share the vocabulary and not the page.
 * ------------------------------------------------------------------------- */

import * as THREE from "three";

import { makeFieldBake } from "./meadow/field.js";
import {
  PAINT_EXTENT,
  REDUCED,
  petalAtlas,
  mulberry32,
  makeField,
  makePaint,
  makeUniforms,
  buildGround,
  buildBlades,
  buildSpecks,
  DAISY_KINDS,
  daisyTexture,
  makeTerrain,
  makeTipOf,
} from "./meadow/meadow.js";
import { makeTurntable } from "./meadow/turntable.js";

/** The home page's own framing, so a sketch looks like the thing it is about. */
export const LOOK = {
  elevation: 15.5,
  frustum: 24,
  height: 6.5,
  distance: 60,
};

/** Midday, as the home page has it. A sketch that moves the light starts here. */
export const DAY = {
  grass: "#84a555",
  pale: "#99ab6d",
  deep: "#052e42",
  warm: "#d73d09",
  cold: "#bfb788",
  sunOffset: 20,
  sunHeight: 37,
  sunAmount: 0.07,
  sunEdge: 0.31,
  relief: 1.5,
  shadow: 0.64,
  shadowSoft: 0.26,
  wind: 0.55,
  gust: 0.85,
  hills: 0.6,
  hillSize: 9.5,
};

/**
 * Stand a field up in `host`.
 *
 * @param host   an element to fill. Sized by CSS; this only measures it.
 * @param opts.blades   how many. Halved on a coarse pointer, floored on
 *                      reduced motion — a sketch is not worth a hot phone.
 * @param opts.seed     which field. Same number, same meadow, every time.
 * @param opts.flowers  daisies and specks.
 *
 * @returns the handles, and a `dispose` that must be called — every sketch is
 *          a React effect and StrictMode runs each of them twice.
 */
export function mountField(host, opts = {}) {
  const {
    blades: bladeCount = 150000,
    seed = 7,
    flowers = true,
    paper = "#faf8f2",
  } = opts;

  const look = { ...LOOK, ...(opts.look ?? {}) };
  const sky = { ...DAY, ...(opts.sky ?? {}) };

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(new THREE.Color(paper), 0);
  host.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.inlineSize = "100%";
  renderer.domElement.style.blockSize = "100%";

  const scene = new THREE.Scene();
  const uniforms = makeUniforms();
  const bake = makeFieldBake(uniforms, PAINT_EXTENT, sky.relief);
  const paint = makePaint();
  const petalMap = petalAtlas();
  const world = { footprints: [], paved: () => false };
  const { hillsAt } = makeTerrain(uniforms);

  const daisyKit = DAISY_KINDS.map(
    (k) =>
      new THREE.SpriteMaterial({
        map: daisyTexture(k),
        transparent: true,
        depthWrite: false,
      }),
  );
  const daisyGroup = new THREE.Group();
  scene.add(daisyGroup);

  const rig = makeTurntable({
    step: 15,
    elevation: look.elevation * (Math.PI / 180),
    distance: look.distance,
    frustum: look.frustum,
    centre: new THREE.Vector3(0, look.height, 0),
  });

  /* ---- the palette and the light, pushed at the shader ------------------ */
  function light(next = {}) {
    Object.assign(sky, next);
    uniforms.uGrass.value.set(sky.grass);
    uniforms.uGrassPale.value.set(sky.pale);
    uniforms.uGrassDeep.value.set(sky.deep);
    uniforms.uWarm.value.set(sky.warm);
    uniforms.uCold.value.set(sky.cold);
    uniforms.uVary.value = 0.69;
    uniforms.uPatch.value = 1;
    uniforms.uGrassDepth.value = 0.63;
    uniforms.uWidth.value = 0.4;
    uniforms.uSunAmount.value = sky.sunAmount;
    uniforms.uSunEdge.value = sky.sunEdge;
    uniforms.uShadowAmount.value = sky.shadow;
    uniforms.uShadowSoft.value = sky.shadowSoft;
    uniforms.uInkAmount.value = 0.02;
    uniforms.uLine.value = 1.45;
    uniforms.uEdge.value = 0;
    uniforms.uWind.value = REDUCED ? 0 : sky.wind;
    uniforms.uGust.value = sky.gust;
    uniforms.uHills.value = sky.hills;
    uniforms.uHillSize.value = sky.hillSize;
    bake.relief = sky.relief;
  }

  /* The sun is placed relative to the camera, so it has to be re-placed on
     every turn as well as whenever the elevation moves. */
  function placeSun(azimuth) {
    const a = azimuth + sky.sunOffset * (Math.PI / 180);
    const e = sky.sunHeight * (Math.PI / 180);
    uniforms.uSunDir.value.set(
      Math.cos(a) * Math.cos(e),
      Math.sin(e),
      Math.sin(a) * Math.cos(e),
    );
    /* one cotangent of the elevation per unit of height, clamped — past six
       the scene is all shadow and none of it is legible */
    const reach = Math.min(1 / Math.tan(Math.max(e, 0.02)), 6);
    uniforms.uSunSkew.value.set(-Math.cos(a) * reach, -Math.sin(a) * reach);
  }

  /* ---- the field itself -------------------------------------------------- */
  let field = null;
  let ground = null;
  let bladeSet = null;
  let specks = null;
  let daisyHeads = [];
  let tipOf = null;

  function drop(obj) {
    if (!obj) return;
    scene.remove(obj);
    obj.traverse?.((n) => {
      n.geometry?.dispose?.();
      if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
      else n.material?.dispose?.();
    });
  }

  function reseed(n = seed) {
    const rng = mulberry32((n ^ 0x9e3779b9) >>> 0);
    uniforms.uHillSeed.value.set(rng() * 64, rng() * 64);
    field = makeField(n);
    /* Only the main island — the scattered ones read as mats floating in the
       paper from down at grass height, because nothing is drawn between. */
    paint.seed(field.islands.slice(0, 1));
  }

  function sow() {
    drop(bladeSet?.group);
    drop(specks);
    daisyGroup.clear();

    const coarse = matchMedia("(pointer: coarse)").matches;
    const count = opts.exactBladeCount
      ? bladeCount
      : REDUCED
        ? Math.min(bladeCount, 40000)
        : coarse
          ? Math.round(bladeCount * 0.5)
          : bladeCount;

    bladeSet = buildBlades(
      field,
      paint,
      count,
      uniforms,
      { min: 0.05, max: 0.65 },
      world,
      bake,
      opts.inspectClumps ?? false,
      opts.studyClumpBlades ?? 0,
    );
    if (bladeSet) scene.add(bladeSet.group);
    tipOf = bladeSet ? makeTipOf(bladeSet, uniforms, hillsAt) : null;

    specks = buildSpecks(
      field,
      paint,
      THREE.MathUtils.clamp(Math.round(count / 45), 16, 400),
      uniforms,
      petalMap,
      world,
      bake,
    );
    if (specks) scene.add(specks);

    daisyHeads = (bladeSet?.flowers ?? []).map((f) => {
      const sprite = new THREE.Sprite(daisyKit[f.kind]);
      sprite.scale.setScalar(f.size);
      daisyGroup.add(sprite);
      return { ...f, sprite };
    });

    if (specks) specks.visible = flowers;
    daisyGroup.visible = flowers;
  }

  light();
  reseed();
  ground = buildGround(paint, uniforms, bake);
  if (ground) scene.add(ground);
  sow();

  /* Straight to full, no grow-in. A sketch that makes you watch three and a
     half seconds of sprouting before you can try the thing is a sketch nobody
     reloads, and every one of these is reloaded constantly. */
  uniforms.uReveal.value = 1.2;
  uniforms.uGrow.value = 1.2;

  /* ---- pointer → ground -------------------------------------------------- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();

  /** Where on the ground a pointer event is, or null above the horizon. */
  function pointerWorld(e) {
    const r = renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    ray.setFromCamera(ndc, rig.camera);
    plane.constant = 0;
    for (let i = 0; i < 4; i++) {
      if (!ray.ray.intersectPlane(plane, hit)) return null;
      plane.constant = -hillsAt(hit.x, hit.z);
    }
    return hit.clone();
  }

  /** Where a world point lands on screen, in CSS pixels within the host. */
  const projected = new THREE.Vector3();
  function toScreen(v) {
    const r = renderer.domElement.getBoundingClientRect();
    projected.copy(v).project(rig.camera);
    return {
      x: ((projected.x + 1) / 2) * r.width,
      y: ((1 - projected.y) / 2) * r.height,
      behind: projected.z > 1,
    };
  }

  /* ---- the loop ---------------------------------------------------------- */
  const frameFns = new Set();
  /** Called every frame with (dt, time). Returns an unsubscribe. */
  function onFrame(fn) {
    frameFns.add(fn);
    return () => frameFns.delete(fn);
  }

  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    rig.resize(w, h);
    // Resizing clears the drawing buffer. Paint in the ResizeObserver turn
    // so an animated focus transition never presents an empty canvas.
    bake.ensure(renderer);
    renderer.render(scene, rig.camera);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  let raf = 0;
  let last = performance.now();
  let dead = false;

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    uniforms.uTime.value += dt;

    for (const fn of frameFns) fn(dt, uniforms.uTime.value);

    rig.update(dt);
    placeSun(rig.azimuth);
    bake.ensure(renderer);

    /* the heads ride the tips of their own stems, which the shader moves — so
       they are re-pinned every frame from the same maths, on the CPU */
    if (tipOf) {
      for (const f of daisyHeads) {
        const p = tipOf(f.i, uniforms.uTime.value);
        f.sprite.position.set(p.x, p.y, p.z);
      }
    }

    renderer.render(scene, rig.camera);
    if (!dead) raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    THREE,
    get blades() {
      return bladeSet;
    },
    get ground() {
      return ground;
    },
    scene,
    renderer,
    rig,
    uniforms,
    paint,
    world,
    hillsAt,
    get sky() {
      return sky;
    },
    light,
    reseed,
    sow,
    onFrame,
    pointerWorld,
    sampleGround(x, z) {
      const [r, g, b, height] = bake.sample(renderer, x, z);
      return { color: "#" + new THREE.Color(r, g, b).getHexString(), height };
    },
    toScreen,
    /** Read the pixels behind a rect, composited over the paper. 0–1. */
    luminanceAt(rect) {
      const gl = renderer.getContext();
      const dpr = renderer.getPixelRatio();
      const box = renderer.domElement.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const x = Math.max(0, Math.round((rect.left - box.left) * dpr));
      const y = Math.round((box.height - (rect.top - box.top + rect.height / 2)) * dpr);
      if (y < 0 || y >= gl.drawingBufferHeight || x >= gl.drawingBufferWidth)
        return null;
      const buf = new Uint8Array(w * 4);
      gl.readPixels(x, y, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const p = new THREE.Color(paper);
      let sum = 0;
      for (let i = 0; i < w; i++) {
        const k = i * 4;
        const a = buf[k + 3] / 255;
        const r = buf[k] / 255 + p.r * (1 - a);
        const g = buf[k + 1] / 255 + p.g * (1 - a);
        const b = buf[k + 2] / 255 + p.b * (1 - a);
        sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      return sum / w;
    },
    dispose() {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      rig.dispose();
      frameFns.clear();
      drop(bladeSet?.group);
      drop(specks);
      drop(ground);
      daisyGroup.clear();
      bake.dispose();
      paint.tex.dispose();
      petalMap.dispose();
      for (const material of daisyKit) {
        material.map?.dispose();
        material.dispose();
      }
      renderer.dispose();
      /* Browsers cap live WebGL contexts, and a lab is a place people click
         through fifteen pages in a row. Losing it explicitly gives it back. */
      renderer.forceContextLoss();
      host.replaceChildren();
    },
  };
}
