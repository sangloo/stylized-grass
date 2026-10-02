import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

// The renderer's only eager browser preference; this test needs no WebGL context.
globalThis.matchMedia = () => ({ matches: false });
const { makeField, makePaint, makeUniforms, buildBlades } = await import("./meadow.js");

function planting(inspectClumps) {
  const field = makeField(7);
  const paint = makePaint();
  paint.seed(field.islands.slice(0, 1));
  const bake = { texture: new THREE.Texture(), extent: 96 };
  const blades = buildBlades(
    field,
    paint,
    500,
    makeUniforms(),
    { min: 0.05, max: 0.65 },
    { footprints: [], paved: () => false },
    bake,
    inspectClumps,
  );
  return {
    blades,
    dispose() {
      blades.geo.dispose();
      blades.group.children[0].material.dispose();
      paint.tex.dispose();
      bake.texture.dispose();
    },
  };
}

test("LOD changes invalidate cached wireframe edges without changing instances", () => {
  const a = planting(true),
    b = planting(false);
  try {
    const roots = a.blades.geo.getAttribute("iPos").array.slice();
    const otherIndex = b.blades.geo.index;
    let version = a.blades.geo.index.version;
    for (const level of [0, 1, 2, 1, 0, 2]) {
      a.blades.setDetail(level);
      const geometry = a.blades.geo;
      assert.ok(
        geometry.index.version > version,
        "cached wireframe must see a newer index version",
      );
      version = geometry.index.version;
      assert.equal(geometry.index.count, [18, 36, 60][level]);
      assert.ok(
        Math.max(...geometry.index.array) < geometry.getAttribute("position").count,
      );
      assert.deepEqual(geometry.getAttribute("iPos").array, roots);
      assert.equal(
        b.blades.geo.index,
        otherIndex,
        "another meadow retains its own index",
      );
    }
    assert.ok(a.blades.clumps.length > 0);
    for (const name of Object.keys(a.blades.geo.attributes).filter(
      (n) => n !== "position",
    )) {
      assert.deepEqual(
        a.blades.geo.getAttribute(name).array,
        b.blades.geo.getAttribute(name).array,
        "clump inspection must not alter the planting sequence",
      );
    }
  } finally {
    a.dispose();
    b.dispose();
  }
});
