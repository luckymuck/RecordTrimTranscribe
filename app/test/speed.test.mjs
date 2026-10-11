import { test } from "node:test";
import assert from "node:assert/strict";
import { clampSpeed, snapToStep, speedAfterDrag, speedFromDrag, stepSpeed } from "../src/ui/speed.js";

test("clampSpeed bounds and rounds", () => {
  assert.equal(clampSpeed(0.5), 1);
  assert.equal(clampSpeed(9), 4);
  assert.equal(clampSpeed(1.234), 1.23);
  assert.equal(clampSpeed(NaN), 1);
});

test("speedFromDrag is linear in pixels", () => {
  assert.equal(speedFromDrag(1, 0), 1);
  assert.equal(speedFromDrag(1, 200), 2);
  assert.equal(speedFromDrag(2, -100), 1.5);
});

test("speedAfterDrag treats a sub-threshold drag as a click", () => {
  // A 1 px wobble used to leave 1.005, then add 0.25, giving 1.26.
  assert.equal(speedAfterDrag(1, 1), 1.25);
  assert.equal(speedAfterDrag(1, -2), 1.25);
  assert.equal(speedAfterDrag(1.26, 2), 1.5, "click steps from the snapped start");
  assert.equal(speedAfterDrag(4, 0), 4, "clamped at the top");
});

test("speedAfterDrag keeps the dragged value past the threshold", () => {
  assert.equal(speedAfterDrag(1, 100), 1.5);
  assert.equal(speedAfterDrag(3, -200), 2);
});

test("stepSpeed stays on quarter values after a drag", () => {
  assert.equal(stepSpeed(1, 1), 1.25);
  assert.equal(stepSpeed(1.26, 1), 1.5);
  assert.equal(stepSpeed(1.26, -1), 1);
  assert.equal(stepSpeed(4, 1), 4);
  assert.equal(stepSpeed(1, -1), 1);
});

test("snapToStep rounds to the nearest quarter", () => {
  assert.equal(snapToStep(1.26), 1.25);
  assert.equal(snapToStep(1.13), 1.25);
  assert.equal(snapToStep(1.1), 1);
});
