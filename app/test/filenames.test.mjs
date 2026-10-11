import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backupName,
  clipExportName,
  exportBaseName,
  recordingName,
  sanitizeName,
  stripExtension,
  wholeExportName,
} from "../src/util/filenames.js";

test("stripExtension removes only the final extension", () => {
  assert.equal(stripExtension("a.v2.final.mp3"), "a.v2.final");
  assert.equal(stripExtension("talk.mp3"), "talk");
  assert.equal(stripExtension("noext"), "noext");
  assert.equal(stripExtension(""), "");
});

test("sanitizeName removes path-hostile characters and collapses spaces", () => {
  assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
  assert.equal(sanitizeName("  two   spaces  "), "two spaces");
});

test("exportBaseName strips the extension and defaults when empty", () => {
  assert.equal(exportBaseName("talk.mp3"), "talk");
  assert.equal(exportBaseName(""), "recording");
  assert.equal(exportBaseName(null), "recording");
});

test("wholeExportName keeps the speed even when silence is skipped", () => {
  assert.equal(wholeExportName("talk.mp3", {}), "talk.wav");
  assert.equal(
    wholeExportName("talk.mp3", { baked: true, speed: 2 }),
    "talk-2.00x.wav"
  );
  assert.equal(
    wholeExportName("talk.mp3", { baked: true, skip: true, speed: 4 }),
    "talk-4.00x-nosilence.wav"
  );
  assert.equal(wholeExportName("talk.mp3", { skip: true, speed: 4, format: "mp3" }), "talk-nosilence.mp3");
});

test("backupName and clipExportName", () => {
  assert.equal(backupName("talk.mp3"), "talk-backup.wav");
  assert.equal(clipExportName("talk.mp3", "intro", "mp3"), "talk-intro.mp3");
  assert.equal(clipExportName("talk.mp3", "", "wav"), "talk-clip.wav");
});

test("recordingName is sortable and padded", () => {
  const d = new Date(2026, 9, 10, 9, 5, 0); // 10 Oct 2026 09:05 local
  assert.equal(recordingName(d), "2026-10-10 0905");
  const later = new Date(2026, 9, 10, 23, 59, 0);
  assert.ok(recordingName(d) < recordingName(later), "names must sort chronologically");
});
