const assert = require("node:assert/strict");

const {
  calculateSpatialAudio,
} = require("./spatial-math.js");

function approximatelyEqual(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 0.000001,
    `Expected ${expected}, received ${actual}`
  );
}

// Same position.
let result = calculateSpatialAudio([50, 40], [50, 40], 100);

approximatelyEqual(result.distance, 0);
approximatelyEqual(result.gain, 1);
approximatelyEqual(result.pan, 0);
assert.equal(result.audible, true);

// 30 units to the right.
result = calculateSpatialAudio([50, 40], [80, 40], 100);

approximatelyEqual(result.distance, 30);
approximatelyEqual(result.gain, 0.7);
approximatelyEqual(result.pan, 0.3);

// 30 units to the left.
result = calculateSpatialAudio([50, 40], [20, 40], 100);

approximatelyEqual(result.distance, 30);
approximatelyEqual(result.gain, 0.7);
approximatelyEqual(result.pan, -0.3);

// 60 units horizontally and 80 vertically: distance is 100.
result = calculateSpatialAudio([0, 0], [60, 80], 100);

approximatelyEqual(result.distance, 100);
approximatelyEqual(result.gain, 0);
assert.equal(result.audible, false);

// Beyond the radius: gain cannot become negative.
result = calculateSpatialAudio([0, 0], [150, 0], 100);

approximatelyEqual(result.gain, 0);
approximatelyEqual(result.pan, 1);

// Invalid inputs must be rejected.
assert.throws(() => calculateSpatialAudio([0], [20, 40], 100));
assert.throws(() => calculateSpatialAudio([0, 0], [20, 40], 0));
assert.throws(() => calculateSpatialAudio([0, 0], [NaN, 40], 100));

console.log("All spatial-audio calculation tests passed.");