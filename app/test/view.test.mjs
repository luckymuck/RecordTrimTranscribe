import { test } from "node:test";
import assert from "node:assert/strict";
import { zoomAnchor, zoomAround } from "../src/ui/view.js";

test("zoomAround keeps the anchor at the same fraction", () => {
  const { viewStart, viewLen } = zoomAround(0, 100, 0.5, 50);
  assert.equal(viewLen, 50);
  assert.equal(viewStart, 25, "anchor 50 must stay centred");
});

test("zoomAround anchored at the left edge does not scroll right", () => {
  const { viewStart, viewLen } = zoomAround(0, 100, 0.5, 0);
  assert.equal(viewStart, 0);
  assert.equal(viewLen, 50);
});

test("zoomAround zooms out around the centre", () => {
  const { viewStart, viewLen } = zoomAround(100, 100, 2, 150);
  assert.equal(viewLen, 200);
  assert.equal(viewStart, 50);
});

test("zoomAnchor prefers the playhead when it is on screen", () => {
  assert.equal(zoomAnchor(100, 100, 150), 150);
  assert.equal(zoomAnchor(100, 100, 100), 100);
  assert.equal(zoomAnchor(100, 100, 200), 200);
});

test("zoomAnchor falls back to the view centre", () => {
  assert.equal(zoomAnchor(100, 100, 40), 150);
  assert.equal(zoomAnchor(100, 100, 900), 150);
  assert.equal(zoomAnchor(100, 100, NaN), 150);
});
