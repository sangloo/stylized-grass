/* ---------------------------------------------------------------------------
 * turntable.js — a camera that can only turn, and only to certain angles.
 *
 * One axis, one detent size, nothing else. There is no zoom here, no pan and
 * no elevation control — not disabled behind a flag, absent. A rig that can
 * only do the one thing cannot drift into doing the others, and the drawing
 * depends on it: the whole pen-and-wash look assumes a fixed isometric
 * elevation, and the ground plane stops reading as ground the moment the
 * camera rises off it.
 *
 * The detent is the point rather than a nicety. Every angle between two
 * detents is a worse picture than either of them — foreshortened props, the
 * ink line at an angle it was never drawn for — so the camera is never left
 * there. You can drag it through those angles, and when you let go it goes to
 * the nearest one it is allowed to be at.
 *
 * ── What a detent means to the page ───────────────────────────────────────
 *
 * `index` is the whole interface between the camera and whatever is being
 * shown. It counts detents from north, wraps at a full turn, and changes the
 * instant the TARGET changes — on the drag, not on the arrival. That is
 * deliberate: a page that swaps its content when the camera finishes moving
 * feels like it is lagging behind you, and one that swaps when you let go
 * feels like it is reading your mind. The turn then plays out underneath the
 * new content and covers the change.
 *
 * ── Why the angle is not the state ────────────────────────────────────────
 *
 * `target` is kept as an integer detent index and never as radians. Storing
 * radians and rounding on demand accumulates: turn far enough and the
 * rounding drifts off the grid, so a detent stops being exactly a multiple of
 * the step and the scene it selects starts flickering between two at the
 * boundary. An integer cannot drift. The angle is derived from it, always.
 *
 * The index is also NOT wrapped internally — it counts up and down forever,
 * so the camera keeps turning the way you dragged it rather than unwinding
 * the long way round when it crosses north. Only `scene` wraps.
 * ------------------------------------------------------------------------- */

import * as THREE from "three";

/* The true isometric elevation: atan(1/√2) ≈ 35.264°, the angle at which the
   three axes are equally foreshortened. Everything in the meadow — the blade
   billboards, the ink skirt at the ground's rim, every prop's silhouette —
   was drawn to look right from here. */
export const ISOMETRIC = Math.atan(1 / Math.SQRT2);

const RAD = Math.PI / 180;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function makeTurntable({
  step = 15,
  scenes = 0,
  elevation = ISOMETRIC,
  distance = 40,
  frustum = 31,
  centre = new THREE.Vector3(0, 0.6, 0),
  /* How fast the turn catches up, as an exponential rate. 9 is the editor's
     and it reads as "heavy but willing" at 45°; the same rate over a 15° step
     lands in about a fifth of a second, which is short enough that a drag
     feels connected and long enough to see the grass go round. */
  ease = 9,
  /* Screen pixels per detent when dragging. Roughly a thumb's width, so a
     deliberate flick is one scene and a lazy one is none. */
  grab = 90,
  start = 0,
} = {}) {
  const stepRad = step * RAD;
  const wrap = scenes || Math.max(1, Math.round(360 / step));

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const home = centre.clone();

  /* `index` is where it is going; `angle` is where it actually is. They are
     different for about a fifth of a second at a time and that gap is the
     whole animation. */
  let index = Math.round(start);
  let angle = index * stepRad;
  const listeners = new Set();

  const azimuthOf = (i) => i * stepRad;
  const sceneOf = (i) => ((i % wrap) + wrap) % wrap;

  function place() {
    const flat = Math.cos(elevation) * distance;
    camera.position.set(
      home.x + Math.cos(angle) * flat,
      home.y + Math.sin(elevation) * distance,
      home.z + Math.sin(angle) * flat,
    );
    camera.lookAt(home);
    camera.updateProjectionMatrix();
  }

  function announce(from) {
    if (sceneOf(from) === sceneOf(index)) return;
    for (const fn of listeners) fn(sceneOf(index), sceneOf(from), index - from);
  }

  /* every way of asking for a turn ends up here, so there is one place where
     the index changes and one place that tells the page about it */
  function goTo(next) {
    const wanted = Math.round(next);
    if (wanted === index) return;
    const from = index;
    index = wanted;
    if (REDUCED) angle = azimuthOf(index); // no sweep to watch, so don't make them wait
    announce(from);
  }

  const turn = (steps) => goTo(index + steps);

  function update(dt) {
    const to = azimuthOf(index);
    if (angle === to) return false;
    const k = 1 - Math.exp(-dt * ease);
    angle += (to - angle) * k;
    /* Land it rather than approach it forever: an exponential never arrives,
       and a camera a thousandth of a degree off its detent still re-renders
       every frame for the rest of the session. */
    if (Math.abs(to - angle) < 1e-4) angle = to;
    place();
    return true;
  }

  /* The last size the host measured, kept so that changing the framing does
     not have to wait for a window resize to take effect. */
  let lastW = 0;
  let lastH = 0;

  function resize(w = lastW, h = lastH) {
    /* A hidden or not-yet-laid-out host measures zero, and 0/0 is NaN — which
       goes into the frustum, out through every projection this frame does,
       and shows up as nothing being drawn rather than as an error. */
    if (!w || !h) return false;
    lastW = w;
    lastH = h;
    const a = w / h;
    camera.left = (-frustum * a) / 2;
    camera.right = (frustum * a) / 2;
    camera.top = frustum / 2;
    camera.bottom = -frustum / 2;
    place();
    return true;
  }

  /* ---------------------------------------------------------------------
   * input
   *
   * A drag is measured against where it STARTED, not against the last
   * pointer event. Accumulating per-move deltas means a slow drag that
   * wanders back and forth racks up detents it never visually passed
   * through, and the camera arrives somewhere the hand never went.
   * ------------------------------------------------------------------- */
  let drag = null;
  const detach = [];

  /**
   * @param when  a predicate asked before every gesture, and GIVEN THE EVENT.
   *              The page owns the question of whether a drag means "turn" —
   *              with a brush in hand it means "paint", and on a control it
   *              means whatever that control says it means — and answering it
   *              here rather than by attaching and detaching keeps the pointer
   *              capture, the cursor class and the wheel lock in one place.
   *
   *              It gets the event because the answer usually depends on what
   *              was pressed. This rig is attached to the BODY, so every
   *              pointerdown in the page reaches it, including ones that
   *              landed on a slider — and a rig that cannot see the target
   *              cannot decline those. What it did instead was call
   *              `setPointerCapture` on the body, which retargets every
   *              subsequent pointer event for that pointer away from the
   *              control that was actually being dragged: the control stops
   *              receiving moves mid-gesture, never sees its own pointerup,
   *              and is left believing a drag is still in progress. On the
   *              track that read as a scrub that got stuck and then a bar that
   *              moved on hover ever after.
   */
  function attach(el, { when = () => true } = {}) {
    const onDown = (e) => {
      if (!when(e)) return;
      if (e.button !== undefined && e.button !== 0) return;
      drag = { x: e.clientX, from: index };
      el.setPointerCapture?.(e.pointerId);
      el.classList.add("is-turning");
    };

    const onMove = (e) => {
      if (!drag) return;
      /* The hand and the ground move together: drag left and the field goes
         left, as though you had put a palm on it and pushed.

         The other sign is defensible on paper — you are moving the CAMERA, and
         a camera dragged left looks rightward — and it is what this shipped
         with, and it was wrong every single time anyone touched it. What is
         under the cursor is grass, not a viewfinder, so the grass is what has
         to follow. */
      goTo(drag.from + Math.round((e.clientX - drag.x) / grab));
    };

    const onUp = (e) => {
      if (!drag) return;
      drag = null;
      el.releasePointerCapture?.(e.pointerId);
      el.classList.remove("is-turning");
    };

    /* A trackpad sends a long tail of small deltas for one flick, so this
       takes the first event of a gesture and then ignores the rest until the
       wheel goes quiet. Without it a single two-finger swipe spins the field
       through half a turn. */
    let wheelLock = 0;
    const onWheel = (e) => {
      if (!when(e)) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(d) < 2) return;
      e.preventDefault();
      const now = performance.now();
      if (now < wheelLock) return;
      wheelLock = now + 320;
      turn(Math.sign(d));
    };

    /* The same `when` as the pointer and the wheel. The keys went without it,
       so every arrow key anywhere on the page turned the field and had its
       own meaning cancelled: the caret in the letter's email field would not
       move, and a post open in the reader would not scroll by keyboard. */
    const onKey = (e) => {
      if (!when(e)) return;
      const by = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (by === undefined) return;
      e.preventDefault();
      turn(e.shiftKey ? by * Math.round(wrap / 4) : by);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("keydown", onKey);

    detach.push(() => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
    });
  }

  place();

  return {
    camera,
    step,
    scenes: wrap,
    get index() {
      return index;
    },
    get scene() {
      return sceneOf(index);
    },
    get azimuth() {
      return angle;
    },
    /* true while the camera is still catching up with the detent — the page
       uses it to hold a transition open until the turn has actually landed */
    get turning() {
      return angle !== azimuthOf(index);
    },
    /* ---- the framing, live -------------------------------------------
       Three numbers that only make sense together — how much ground the
       angle shows, how much of the frame that fills, and where in the frame
       it sits — so they are settable rather than fixed at construction and
       there is a tuning panel that moves all three at once. */
    get elevation() {
      return elevation;
    },
    set elevation(v) {
      elevation = v;
      place();
    },
    orbit(azimuth, tilt = elevation) {
      angle = azimuth;
      index = azimuth / stepRad;
      elevation = tilt;
      place();
    },
    get frustum() {
      return frustum;
    },
    set frustum(v) {
      frustum = v;
      resize();
    },
    /* the look-at point, mutated in place; call place() after */
    home,
    place,

    turn,
    goTo,
    /* absolute, in scenes rather than detents: picks whichever way round is
       shorter so a nav dot never takes the long way */
    goToScene(n) {
      const here = sceneOf(index);
      let d = (((n - here) % wrap) + wrap) % wrap;
      if (d > wrap / 2) d -= wrap;
      turn(d);
    },
    update,
    resize,
    attach,
    onDetent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      for (const off of detach) off();
      detach.length = 0;
      listeners.clear();
    },
  };
}
