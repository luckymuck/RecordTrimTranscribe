import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audioSpecificConfig,
  demuxMp4,
  parseBoxesIn,
  selectSamples,
} from "../src/audio/mp4.js";
import { demuxMkv, parseBlock, parseMkvHeader, readVint } from "../src/audio/mkv.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function u32(value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, true);
  return b;
}
function u16(value) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, true);
  return b;
}
function ascii(text) {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
}
function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function box(type, ...children) {
  const body = concat(children);
  return concat([u32(body.length + 8), ascii(type), body]);
}
function fullBox(type, version, flags, ...children) {
  const head = new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
  return box(type, head, ...children);
}

/** A minimal MP4 with one AAC audio track: 3 chunks, 2 samples each. */
function makeMp4() {
  const timescale = 48000;
  const sampleSizes = [10, 10, 10, 10, 10, 10];
  const chunkOffsets = [100, 130, 160];
  const sampleTime = 1024; // samples (21.3 ms at 48 kHz)
  const mdat = new Uint8Array(200);

  const asc = Uint8Array.from([0x12, 0x10]); // AAC-LC, 44.1 kHz, stereo
  const esdsBody = concat([
    new Uint8Array([0x03, 3 + 2 + 15, 0x00, 0x01, 0x00]), // ES descriptor
    new Uint8Array([0x04, 15, 0x40, 0x15]),
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // bitrates/buffer
    new Uint8Array([0x05, asc.length]),
    asc,
  ]);
  const esds = fullBox("esds", 0, 0, esdsBody);
  const sampleEntry = concat([
    new Uint8Array(6), // reserved
    u16(1), // data reference index
    new Uint8Array(8), // reserved
    u16(2), // channels
    u16(16), // sample size
    u16(0),
    u16(0),
    u32(48000 << 16), // 16.16 sample rate
    esds,
  ]);
  const mp4a = concat([u32(sampleEntry.length + 8), ascii("mp4a"), sampleEntry]);
  const stsd = fullBox("stsd", 0, 0, u32(1), mp4a);

  const stts = fullBox(
    "stts",
    0,
    0,
    u32(1),
    u32(sampleSizes.length),
    u32(sampleTime)
  );
  const stsz = fullBox("stsz", 0, 0, u32(0), u32(sampleSizes.length), ...sampleSizes.map(u32));
  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(2), u32(1));
  const stco = fullBox("stco", 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u32));
  const stbl = box("stbl", stsd, stts, stsz, stsc, stco);
  const mdhd = fullBox("mdhd", 0, 0, new Uint8Array(8), u32(timescale), u32(0), new Uint8Array(4));
  const hdlr = fullBox("hdlr", 0, 0, new Uint8Array(4), ascii("soun"), new Uint8Array(12), new Uint8Array([0]));
  const minf = box("minf", box("stbl", stsd, stts, stsz, stsc, stco));
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", mdia);
  const moov = box("moov", fullBox("mvhd", 0, 0, new Uint8Array(96)), trak);
  const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso2"));
  return concat([ftyp, moov, box("mdat", mdat)]);
}

function toFile(bytes) {
  return new Blob([bytes]);
}

// ── MP4 ─────────────────────────────────────────────────────────────────────

test("parseBoxesIn reads sizes and types", () => {
  const bytes = concat([box("ftyp", ascii("isom")), box("free")]);
  const boxes = parseBoxesIn({ bytes, base: 0 }, 0, bytes.length);
  assert.deepEqual(
    boxes.map((b) => b.type),
    ["ftyp", "free"]
  );
  assert.equal(boxes[0].size, 12);
});

test("audioSpecificConfig walks the descriptors to the config", () => {
  const asc = Uint8Array.from([0x12, 0x10]);
  const payload = concat([
    new Uint8Array([0x03, 3 + 2 + 15, 0x00, 0x01, 0x00]),
    new Uint8Array([0x04, 15, 0x40, 0x15]),
    new Uint8Array(11),
    new Uint8Array([0x05, asc.length]),
    asc,
  ]);
  assert.deepEqual([...audioSpecificConfig(payload)], [...asc]);
});

test("demuxMp4 finds the audio track, codec and sample table", async () => {
  const track = await demuxMp4(toFile(makeMp4()));
  assert.equal(track.container, "mp4");
  assert.equal(track.codec, "mp4a.40.2");
  assert.deepEqual([...track.description], [0x12, 0x10]);
  assert.equal(track.sampleRate, 48000);
  assert.equal(track.samples.length, 6);
  // Two samples per chunk at the declared chunk offsets.
  assert.deepEqual(
    track.samples.map((s) => s.offset),
    [100, 110, 130, 140, 160, 170]
  );
  const expected = 1024 / 48000;
  for (let i = 1; i < track.samples.length; i++) {
    assert.ok(Math.abs(track.samples[i].time - i * expected) < 1e-9, `sample ${i}`);
  }
  assert.ok(Math.abs(track.durationSeconds - 6 * expected) < 1e-9);
});

test("selectSamples covers a range with preroll", () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({ offset: i * 10, size: 10, time: i }));
  const track = { samples, durationSeconds: 10 };
  const selected = selectSamples(track, 3.5, 6.5);
  assert.equal(selected.samples[0].time, 2, "two frames of preroll");
  assert.equal(selected.samples[selected.samples.length - 1].time, 6);
  assert.equal(selectSamples(track, 0, 2).preroll, 0);
});

test("demuxMp4 rejects a file with no audio track", async () => {
  const ftyp = box("ftyp", ascii("isom"));
  const mvhd = fullBox("mvhd", 0, 0, new Uint8Array(96));
  const moov = box("moov", mvhd);
  await assert.rejects(demuxMp4(toFile(concat([ftyp, moov]))), /no audio track/);
});

// ── Matroska ────────────────────────────────────────────────────────────────

/** EBML element: id bytes as given, size as a 1- or 2-byte vint. */
function el(idBytes, body) {
  const id = idBytes instanceof Uint8Array ? idBytes : Uint8Array.from(idBytes);
  const len = body.length;
  const size = len < 0x7f ? Uint8Array.from([0x80 | len]) : Uint8Array.from([0x40 | (len >> 8), len & 0xff]);
  return concat([id, size, body]);
}
function beUint(value, bytes = 1) {
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return out;
}
function beFloat64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

function makeMkv() {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x86], Uint8Array.from([1])));
  const info = el(
    [0x15, 0x49, 0xa9, 0x66],
    concat([el([0x2a, 0xd7, 0xb1], beUint(1000000, 3)), el([0x44, 0x89], beFloat64(2400))])
  );
  const audio = el(
    [0xe1],
    concat([el([0xb5], beFloat64(48000)), el([0x9f], Uint8Array.from([1]))])
  );
  const videoTrack = el(
    [0xae],
    concat([
      el([0xd7], Uint8Array.from([1])),
      el([0x83], Uint8Array.from([1])), // video
      el([0x86], ascii("V_VP9")),
    ])
  );
  const audioTrack = el(
    [0xae],
    concat([
      el([0xd7], Uint8Array.from([2])),
      el([0x83], Uint8Array.from([2])), // audio
      el([0x86], ascii("A_OPUS")),
      el([0x63, 0xa2], Uint8Array.from([0x4f, 0x70, 0x75, 0x73])),
      audio,
    ])
  );
  const tracks = el([0x16, 0x54, 0xae, 0x6b], concat([videoTrack, audioTrack]));

  const blockFor = (trackNumber, timecode, payload, keyframe = true) =>
    concat([
      Uint8Array.from([0x80 | trackNumber]),
      Uint8Array.from([(timecode >> 8) & 0xff, timecode & 0xff]),
      Uint8Array.from([keyframe ? 0x80 : 0x00]), // flags, no lacing
      payload,
    ]);
  const cluster1 = el(
    [0x1f, 0x43, 0xb6, 0x75],
    concat([
      el([0xe7], beUint(0)),
      el([0xa3], blockFor(1, 0, Uint8Array.from([9, 9, 9, 9]))), // video, skipped
      el([0xa3], blockFor(2, 0, Uint8Array.from([1, 2, 3]))),
      el([0xa3], blockFor(2, 20, Uint8Array.from([4, 5]))),
    ])
  );
  const cluster2 = el(
    [0x1f, 0x43, 0xb6, 0x75],
    concat([el([0xe7], beUint(40)), el([0xa3], blockFor(2, 0, Uint8Array.from([6])))])
  );
  const segment = el([0x18, 0x53, 0x80, 0x67], concat([info, tracks, cluster1, cluster2]));
  return concat([ebml, segment]);
}

test("readVint and element headers", () => {
  const bytes = Uint8Array.from([0x81, 0x00]);
  assert.deepEqual(readVint(bytes, 0, false), { value: 1, length: 1 });
  assert.deepEqual(readVint(bytes, 0, true), { value: 0x81, length: 1 });
  assert.equal(readVint(Uint8Array.from([0x40, 0x7f]), 0, false).value, 0x7f);
});

test("parseMkvHeader reads the duration and the audio track", () => {
  const header = parseMkvHeader(makeMkv());
  assert.equal(header.timecodeScale, 1000000);
  assert.ok(Math.abs(header.durationSeconds - 2.4) < 1e-9);
  assert.equal(header.audio.number, 2);
  assert.equal(header.audio.codec, "A_OPUS");
  assert.equal(header.audio.sampleRate, 48000);
  assert.equal(header.audio.channels, 1);
});

test("parseBlock splits laced and plain blocks", () => {
  // Plain: track 2, timecode 20, keyframe.
  const plain = Uint8Array.from([0x82, 0x00, 0x14, 0x80, 1, 2, 3]);
  const parsed = parseBlock(plain, 2);
  assert.equal(parsed.timecodeMs, 20);
  assert.equal(parsed.keyframe, true);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0].size, 3);
  // A block for another track is not ours.
  assert.equal(parseBlock(plain, 1), null);
  // Fixed lacing: 2 frames of 2 bytes.
  const laced = Uint8Array.from([0x82, 0x00, 0x00, 0x84, 0x01, 1, 2, 3, 4]);
  const split = parseBlock(laced, 2);
  assert.deepEqual(
    split.frames.map((f) => f.size),
    [2, 2]
  );
});

test("demuxMkv finds the audio samples and skips the video track", async () => {
  const track = await demuxMkv(toFile(makeMkv()));
  assert.equal(track.codec, "opus");
  assert.equal(track.samples.length, 3);
  assert.deepEqual(
    track.samples.map((s) => s.size),
    [3, 2, 1]
  );
  assert.deepEqual(
    track.samples.map((s) => Math.round(s.time * 1000)),
    [0, 20, 40]
  );
  // The payloads are located, not copied, so sizes and offsets agree.
  for (const sample of track.samples) {
    assert.ok(sample.offset > 0);
  }
});

test("demuxMkv rejects a file without an audio track", async () => {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(0));
  const video = el(
    [0x16, 0x54, 0xae, 0x6b],
    el([0xae], concat([el([0xd7], Uint8Array.from([1])), el([0x83], Uint8Array.from([1]))]))
  );
  const segment = el([0x18, 0x53, 0x80, 0x67], video);
  await assert.rejects(demuxMkv(toFile(concat([ebml, segment]))), /no audio track/);
});
