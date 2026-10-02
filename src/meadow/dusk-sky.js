/* ---------------------------------------------------------------------------
 * dusk-sky.js — what the field looks like at each point of the crossing.
 *
 * Shared, because there is more than one meadow on this site now: the home
 * page's field and the verge along the bottom of a reading page. They have to
 * go down at the same time and in the same colours, and a second copy of this
 * table is a second sunset that drifts.
 *
 * The blend is the one `_theme/arc.js` describes: base = day → night by
 * `night`, then the dusk anchor mixed over the top by `gold`. Identical to
 * what the stylesheet does to the palette, driven by the same clock.
 * ------------------------------------------------------------------------- */

import { blend } from "./arc.js";

/**
 * Three anchors for the things a sunset moves — where the sun is, how hard it
 * is, and what colour the grass goes.
 *
 * `relief` is deliberately absent. It is baked into a texture rather than read
 * per frame, so animating it would re-bake the field sixty times a second to
 * move a number nobody can see moving.
 */
export const SKY = {
  day: {
    grass: "#84a555",
    pale: "#99ab6d",
    deep: "#052e42",
    warm: "#d73d09",
    cold: "#bfb788",
    sunHeight: 37,
    sunAmount: 0.07,
    sunEdge: 0.31,
    shadow: 0.64,
    shadowSoft: 0.26,
  },
  dusk: {
    grass: "#9c9a4a",
    pale: "#d8b46a",
    deep: "#35203a",
    warm: "#ff8a2b",
    cold: "#e0b884",
    /* Low, hard and long: a five-degree sun throws a shadow eleven times the
       height of what casts it, which the clamp cuts to six. */
    sunHeight: 5,
    sunAmount: 0.34,
    sunEdge: 0.55,
    shadow: 0.8,
    shadowSoft: 0.3,
  },
  night: {
    grass: "#36443a",
    pale: "#4a5647",
    deep: "#060f19",
    warm: "#7d3a1c",
    cold: "#566276",
    /* Not below the horizon. Shadow reach is one over the tangent of this, so
       a negative elevation does not mean "dark" — it means the shadows point
       the wrong way and the field lights from underneath. */
    sunHeight: 3,
    sunAmount: 0.06,
    sunEdge: 0.2,
    shadow: 0.4,
    shadowSoft: 0.45,
  },
};

export const SKY_COLOURS = ["grass", "pale", "deep", "warm", "cold"];
export const SKY_NUMBERS = [
  "sunHeight",
  "sunAmount",
  "sunEdge",
  "shadow",
  "shadowSoft",
];

/**
 * The five numbers, blended. Colours are left to the caller, which usually
 * wants to do them component-wise on values three.js already holds rather
 * than by parsing hex strings sixty times a second.
 */
export function skyNumbers(drivers) {
  const out = {};
  for (const k of SKY_NUMBERS) {
    out[k] = blend(SKY.day[k], SKY.dusk[k], SKY.night[k], drivers);
  }
  return out;
}
