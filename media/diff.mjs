// This function is also serialized into a local worker. Keep it self-contained.
export function comparePixels({
  before,
  after,
  beforeSize,
  afterSize,
  width,
  height,
  tolerance = 0,
  countsOnly = false,
}) {
  const diff = new Uint8ClampedArray(countsOnly ? 0 : width * height * 4);
  const mask = new Uint8ClampedArray(diff.length);
  let changed = 0,
    total = 0,
    minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = x < beforeSize.width && y < beforeSize.height;
      const b = x < afterSize.width && y < afterSize.height;
      if (!a && !b) continue;
      total++;
      const i = (y * width + x) * 4;
      const different =
        a !== b ||
        Math.abs(before[i] - after[i]) > tolerance ||
        Math.abs(before[i + 1] - after[i + 1]) > tolerance ||
        Math.abs(before[i + 2] - after[i + 2]) > tolerance ||
        Math.abs(before[i + 3] - after[i + 3]) > tolerance;
      if (different) {
        changed++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        if (countsOnly) continue;
        diff[i] = mask[i] = 255;
        diff[i + 1] = mask[i + 1] = 82;
        diff[i + 2] = mask[i + 2] = 158;
        diff[i + 3] = mask[i + 3] = 255;
      } else if (!countsOnly) {
        diff[i] = after[i];
        diff[i + 1] = after[i + 1];
        diff[i + 2] = after[i + 2];
        diff[i + 3] = Math.round(after[i + 3] * 0.25);
      }
    }
  }
  return {
    diff,
    mask,
    changed,
    total,
    bounds: changed
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null,
  };
}
