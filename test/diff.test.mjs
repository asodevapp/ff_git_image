import test from "node:test";
import assert from "node:assert/strict";
import { comparePixels } from "../media/diff.mjs";

const size = (width, height) => ({ width, height });
const compare = (a, b, opts = {}) =>
  comparePixels({
    before: new Uint8ClampedArray(a),
    after: new Uint8ClampedArray(b),
    width: 1,
    height: 1,
    beforeSize: size(1, 1),
    afterSize: size(1, 1),
    ...opts,
  });
test("identical pixels have no bounds and do not create a highlight", () => {
  const result = compare([20, 30, 40, 255], [20, 30, 40, 255]);
  assert.equal(result.changed, 0);
  assert.equal(result.total, 1);
  assert.equal(result.bounds, null);
  assert.equal(result.mask[3], 0);
});
test("RGBA changes include alpha and respect a per-channel tolerance", () => {
  assert.equal(compare([20, 30, 40, 255], [20, 30, 40, 254]).changed, 1);
  assert.equal(
    compare([20, 30, 40, 255], [21, 29, 40, 254], { tolerance: 1 }).changed,
    0,
  );
  assert.equal(
    compare([20, 30, 40, 255], [22, 29, 40, 254], { tolerance: 1 }).changed,
    1,
  );
});
test("transparent added pixels are changes even at maximum tolerance", () => {
  const result = compare([0, 0, 0, 0], [0, 0, 0, 0], {
    beforeSize: size(0, 0),
    tolerance: 255,
  });
  assert.equal(result.changed, 1);
  assert.deepEqual([...result.mask], [255, 82, 158, 255]);
});
test("differently shaped images count the occupied union, not the bounding rectangle", () => {
  const result = compare(new Array(24).fill(0), new Array(24).fill(0), {
    width: 3,
    height: 2,
    beforeSize: size(3, 1),
    afterSize: size(1, 2),
  });
  assert.equal(result.total, 4);
  assert.equal(result.changed, 3);
  assert.deepEqual(result.bounds, { x: 0, y: 0, width: 3, height: 2 });
  assert.equal(result.diff[(1 * 3 + 2) * 4 + 3], 0);
});
test("bounds enclose only changed pixels", () => {
  const a = new Array(16).fill(255),
    b = [...a];
  b[12] = 0;
  assert.deepEqual(
    compare(a, b, {
      width: 2,
      height: 2,
      beforeSize: size(2, 2),
      afterSize: size(2, 2),
    }).bounds,
    { x: 1, y: 1, width: 1, height: 1 },
  );
});
