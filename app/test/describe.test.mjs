import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAge, describeSeconds } from "../src/util/describe.js";

test("describeAge reads in the coarsest useful unit", () => {
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);
  assert.equal(describeAge(now - 5 * 1000, now), "just now");
  assert.equal(describeAge(now - 60 * 1000, now), "1 min ago");
  assert.equal(describeAge(now - 12 * 60 * 1000, now), "12 min ago");
  assert.equal(describeAge(now - 3 * 3600 * 1000, now), "3 h ago");
  assert.equal(describeAge(now - 5 * 24 * 3600 * 1000, now), "5 days ago");
});

test("describeAge is safe on missing or future timestamps", () => {
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);
  assert.equal(describeAge(undefined, now), "unknown time");
  assert.equal(describeAge(0, now), "unknown time");
  assert.equal(describeAge(now + 60 * 1000, now), "just now");
});

test("describeSeconds formats m:ss and h:mm:ss", () => {
  assert.equal(describeSeconds(0), "0:00");
  assert.equal(describeSeconds(9), "0:09");
  assert.equal(describeSeconds(184), "3:04");
  assert.equal(describeSeconds(3661), "1:01:01");
  assert.equal(describeSeconds(-5), "0:00");
  assert.equal(describeSeconds(undefined), "0:00");
});
