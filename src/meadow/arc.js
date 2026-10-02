/* ---------------------------------------------------------------------------
 * arc.js — the sun going down, as two numbers.
 *
 * Dark mode here is not a class swap. It is a two-second sunset that the page
 * and the meadow perform together, and the whole of it is described by two
 * drivers:
 *
 *   night   0 → 1, monotonic. How far through the day-to-night crossing.
 *   gold    0 → 1 → 0, a bump. How much low, warm sun is on everything.
 *
 * Every colour on the site has three anchors — day, dusk, night — and is
 * assembled the same way from those two numbers:
 *
 *   base   = mix(day, night, nightʹ)
 *   result = mix(base, dusk, goldʹ)
 *
 * The CSS does that with `color-mix(in oklab, …)` and the meadow does it with
 * the same arithmetic on floats. They agree because they are the same formula
 * driven by the same clock, not because anyone kept two timelines in step.
 *
 * ── Why a bump and not a fade ─────────────────────────────────────────────
 *
 * A straight crossfade from paper to slate is a light being switched off. The
 * bump is the thing that makes it read as an evening: the sheet WARMS before
 * it darkens, the sun drops toward the horizon, and the shadows in the field
 * get long before the colour goes out of them. `gold` peaking at exactly 1 is
 * deliberate — at the peak the colour IS the dusk anchor, so those anchors can
 * be chosen by eye rather than back-solved out of a blend.
 *
 * ── Why the keyframes are sampled and the easing is linear ────────────────
 *
 * The browser animates the CSS custom properties and the meadow reads the same
 * animation's `currentTime`. If the easing lived in the timing function, the
 * meadow would have to re-implement a cubic bézier solver to agree with it,
 * and "agrees to within a frame" is exactly the kind of nearly that shows up
 * as the paper and the grass parting company halfway through.
 *
 * So the shape is IN the stops, the timing function is linear on both sides,
 * and the two renderers interpolate the same table. There is one source of
 * truth for what the sunset looks like and it is the array below.
 * ------------------------------------------------------------------------- */

/** How long the sun takes to go down. */
export const DUSK_MS = 2000;

/**
 * The arc, sampled. `at` is normalised time; the shape of the ease is carried
 * by the spacing of the stops rather than by a timing function — see above.
 *
 * `night` is deliberately still under 0.4 at the golden moment: the sheet has
 * barely started to darken when it is at its warmest, which is what the hour
 * actually looks like. Most of the darkening happens in the last third, fast,
 * the way it does.
 */
export const ARC = [
  { at: 0, night: 0, gold: 0 },
  { at: 0.16, night: 0.07, gold: 0.5 },
  { at: 0.42, night: 0.34, gold: 1 },
  { at: 0.62, night: 0.66, gold: 0.6 },
  { at: 0.8, night: 0.89, gold: 0.22 },
  { at: 0.92, night: 0.97, gold: 0.06 },
  { at: 1, night: 1, gold: 0 },
];

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * The two drivers at a normalised time. Reading the same table the CSS
 * keyframes were built from is the entire synchronisation strategy.
 *
 * @param {number} t 0..1, clamped
 */
export function driversAt(t) {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  let i = 1;
  while (i < ARC.length - 1 && ARC[i].at < u) i++;
  const a = ARC[i - 1];
  const b = ARC[i];
  const k = b.at === a.at ? 0 : (u - a.at) / (b.at - a.at);
  return { night: lerp(a.night, b.night, k), gold: lerp(a.gold, b.gold, k) };
}

/**
 * Assemble one value from its three anchors. Numbers here; the CSS does the
 * identical thing to colours with `color-mix`.
 */
export const blend = (day, dusk, night, d) =>
  lerp(lerp(day, night, d.night), dusk, d.gold);

/* ---------------------------------------------------------------------------
 * the clock
 *
 * One `Animation` object per crossing, held here. The page reads it by having
 * the browser interpolate `--night` and `--gold`; the meadow reads it by
 * asking for `currentTime`, which costs nothing and cannot drift.
 * ------------------------------------------------------------------------- */

/** The moment in the arc where the sun is lowest and warmest. */
const GOLDEN = ARC.reduce((best, s) => (s.gold > best.gold ? s : best)).at;

/** @type {Animation | null} */
let running = null;
/** Which way the running crossing is going. */
let heading = "night";
/**
 * Where the sun is, adopted from the document at module load.
 *
 * The inline boot script in the layout has already read the stored preference
 * and put `.dark` on the root by the time any of this evaluates — it runs
 * `beforeInteractive` and this module only ever reaches a browser through a
 * client component. So the class is the truth and this reads it, rather than
 * assuming day and correcting itself in an effect afterwards.
 *
 * On the server there is no document and the answer is day, which is what the
 * static HTML is.
 */
/** @type {"day" | "night"} */
let current =
  typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    ? "night"
    : "day";
/** @type {Set<(anim: Animation | null) => void>} */
const listeners = new Set();

export const theme = () => current;

/** The running crossing, or null when the sun is where it was left. */
export const duskAnimation = () => running;

/**
 * Where the sun is, right now, whether or not it is moving.
 *
 * The crossing into day is the same keyframes with `direction: "reverse"`, so
 * wall-clock progress runs 0 → 1 either way and the effect's progress is its
 * mirror. That is the whole reason for the flip here — and the reason there is
 * only one keyframe list to keep honest.
 */
export function driversNow() {
  if (!running) return driversAt(current === "night" ? 1 : 0);
  const w = Number(running.currentTime ?? 0) / DUSK_MS;
  return driversAt(heading === "night" ? w : 1 - w);
}

/**
 * Tell the document where the sun is, without animating. Used to land the
 * animation and to honour `prefers-reduced-motion`.
 */
function pin(root, d) {
  root.style.setProperty("--night", String(d.night));
  root.style.setProperty("--gold", String(d.gold));
}

/**
 * Move the sun.
 *
 * @param {"day" | "night"} to
 * @param {{ animate?: boolean }} [opts]
 */
export function setTheme(to, { animate = true } = {}) {
  const root = document.documentElement;
  current = to;
  heading = to;
  try {
    localStorage.setItem("bb-theme", to);
  } catch {
    /* Private mode, or storage disabled. A remembered preference is not worth
       an exception — the page still works, it just forgets. */
  }

  /* A crossing already under way is overtaken rather than queued. Nothing
     else needs cancelling here: a landed one has already released itself —
     see the note where that happens. */
  running?.cancel();
  running = null;

  const settle = () => {
    root.classList.remove("is-dusking");
    root.classList.toggle("dark", to === "night");
    pin(root, driversAt(to === "night" ? 1 : 0));
  };

  if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    settle();
    for (const fn of listeners) fn(null);
    return;
  }

  running = root.animate(
    ARC.map((s) => ({
      offset: s.at,
      "--night": String(s.night),
      "--gold": String(s.gold),
    })),
    {
      duration: DUSK_MS,
      easing: "linear",
      fill: "forwards",
      /* Into day is the same sunset played backwards, which is a sunrise
         through the same golden moment — rather than a second timeline that
         has to be kept in agreement with the first. */
      direction: to === "night" ? "normal" : "reverse",
    },
  );

  /*
   * The chrome's own colours come from `@animator/tokens`, which is a class
   * swap and cannot be interpolated. So it is timed instead: flipped at the
   * golden moment, under a colour transition the sheet turns on for exactly as
   * long as the crossing lasts. The buttons fall into shadow while the light
   * is going, which is the one instant in the whole thing where a hard swap
   * has somewhere to hide.
   */
  const at = to === "night" ? GOLDEN : 1 - GOLDEN;
  root.classList.add("is-dusking");
  const flip = setTimeout(
    () => root.classList.toggle("dark", to === "night"),
    DUSK_MS * at,
  );

  const anim = running;
  anim.finished
    .then(() => {
      /* Only if nothing overtook us. A second toggle mid-crossing cancels this
         one, and cancellation rejects rather than resolves — but a THIRD
         toggle can land us here with `running` already belonging to someone
         else, and settling then would undo their work. */
      if (running !== anim) return;
      running = null;
      settle();
      /*
       * Landed, so hand the value back to the inline style and let the
       * animation go.
       *
       * `fill: "forwards"` is what stops the palette snapping back to day the
       * instant the clock runs out — but a filling animation does not stop
       * existing when it finishes, it goes on holding the property forever.
       * Without this, every toggle in a session leaves another one on the
       * root, each still filling, and the only reason it looks right is that
       * the newest happens to win.
       *
       * `settle()` has already written the same numbers inline on the line
       * above, and there is no frame between the two, so nothing moves.
       */
      anim.cancel();
      for (const fn of listeners) fn(null);
    })
    .catch(() => clearTimeout(flip));

  for (const fn of listeners) fn(running);
}

/**
 * Told when a crossing starts and when it lands. The meadow uses it to learn
 * there is a clock worth reading; it needs no per-frame notification because
 * it already has a frame loop of its own.
 */
export function onDusk(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
