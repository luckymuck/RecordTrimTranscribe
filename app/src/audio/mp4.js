// Minimal MP4 / M4A / MOV demuxer: enough to find the audio track's samples.
//
// A two-hour video is over 2 GB while its audio track is a couple of hundred
// megabytes, and `decodeAudioData` refuses an ArrayBuffer over 2 GB. Reading the
// box tree lets the app pull out only the audio samples, so the video is never
// read, never decoded and never held in memory -- and any time range can be
// decoded on its own, because every sample's byte offset and time is known.
//
// Kept free of DOM imports so it can be unit-tested under Node.

function fourCC(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

/**
 * Parse the boxes in `view.bytes` between absolute positions `start` and `end`.
 *
 * Every returned box carries absolute file positions, so a child can be sliced
 * without re-deriving offsets from three levels of nesting.
 */
export function parseBoxesIn(view, start, end) {
  const { bytes, base } = view;
  const view$ = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const from = start - base;
  const to = Math.min(bytes.length, end - base);
  const out = [];
  let offset = from;
  while (offset + 8 <= to) {
    let size = view$.getUint32(offset, false);
    const type = fourCC(bytes, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > to) break;
      size = Number(view$.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < headerSize || offset + size > bytes.length) break;
    out.push({
      type,
      start: base + offset,
      bodyStart: base + offset + headerSize,
      size,
      headerSize,
      bodySize: size - headerSize,
    });
    offset += size;
  }
  return out;
}

/** The payload of `box` as its own view, for reading that box's children. */
export function childView(view, box) {
  const from = box.bodyStart - view.base;
  const to = Math.min(view.bytes.length, from + box.bodySize);
  return { bytes: view.bytes.subarray(from, to), base: box.bodyStart };
}

function view(bytes, base = 0) {
  return { bytes, base };
}

function childrenOf(v, box) {
  return parseBoxesIn(childView(v, box), box.bodyStart, box.bodyStart + box.bodySize);
}

function find(v, box, type) {
  return childrenOf(v, box).find((b) => b.type === type) || null;
}

function u32(v, box, offset) {
  return new DataView(v.bytes.buffer, v.bytes.byteOffset, v.bytes.byteLength).getUint32(
    box.bodyStart - v.base + offset,
    false
  );
}

function u16(v, box, offset) {
  return new DataView(v.bytes.buffer, v.bytes.byteOffset, v.bytes.byteLength).getUint16(
    box.bodyStart - v.base + offset,
    false
  );
}

function byteAt(v, box, offset) {
  return v.bytes[box.bodyStart - v.base + offset];
}

/** Timescale from an `mvhd`/`mdhd`; the version changes the layout. */
function timescaleOf(v, box) {
  const version = byteAt(v, box, 0);
  return u32(v, box, version === 1 ? 20 : 12);
}

/**
 * Walk an MP4 `esds` to its DecoderSpecificInfo, which is the AudioSpecificConfig
 * `AudioDecoder` needs as its `description`.
 *
 * Each descriptor is a tag, a variable-length size (one to four bytes, high bit
 * set on every byte but the last), then its body. The body of the ES_Descriptor
 * starts with ES_ID and a flags byte, and the DecoderConfigDescriptor starts with
 * thirteen fixed bytes; neither is another descriptor, so both have to be stepped
 * over before descending. Skipping that step made the walk land in the middle of
 * the flags and find nothing, and an AAC decoder configured without its config
 * produces silence rather than an error.
 */
export function audioSpecificConfig(bytes) {
  let offset = 4; // version and flags
  const end = bytes.length;
  const readLength = () => {
    let length = 0;
    for (let i = 0; i < 4 && offset < end; i++) {
      const b = bytes[offset++];
      length = (length << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return length;
  };
  while (offset < end) {
    const tag = bytes[offset++];
    const length = readLength();
    if (tag === 0x03) {
      // ES_Descriptor: ES_ID (2 bytes), flags (1), then the optional fields the
      // flags announce.
      if (offset + 3 > end) return null;
      const flags = bytes[offset + 2];
      offset += 3;
      if (flags & 0x80) offset += 2; // dependsOn_ES_ID
      if (flags & 0x40) {
        if (offset >= end) return null;
        offset += 1 + bytes[offset]; // URL string, length-prefixed
      }
      if (flags & 0x20) offset += 2; // OCR_ES_Id
      continue;
    }
    if (tag === 0x04) {
      // DecoderConfigDescriptor: objectTypeIndication, streamType/bufferSize,
      // maxBitrate, avgBitrate.
      offset += 13;
      continue;
    }
    if (tag === 0x05) {
      return bytes.slice(offset, Math.min(end, offset + length));
    }
    offset += length;
  }
  return null;
}

/**
 * An AudioSpecificConfig built from the sample entry, for a file whose `esds` is
 * malformed or missing. AAC-LC at the track's rate and channel count is what the
 * sample entry describes in every practical case.
 */
export function fallbackAudioConfig(sampleRate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const index = rates.indexOf(Math.round(sampleRate));
  if (index < 0) return null;
  const channelConfig = Math.min(7, Math.max(1, Math.round(channels) || 2));
  const objectType = 2; // AAC-LC
  return Uint8Array.from([
    (objectType << 3) | (index >> 1),
    ((index & 1) << 7) | (channelConfig << 3),
  ]);
}

/**
 * The codec's own rate and channel count from an AudioSpecificConfig, or null.
 *
 * The first two bytes carry the object type, the sampling-frequency index and
 * the channel configuration; that is what the decoder must be configured with.
 */
export function audioConfigInfo(asc) {
  if (!asc || asc.length < 2) return null;
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const objectType = (asc[0] >> 3) & 0x1f;
  const frequencyIndex = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
  const channelConfig = (asc[1] >> 3) & 0x0f;
  return {
    objectType,
    frequencyIndex,
    sampleRate: rates[frequencyIndex] || 0,
    // 7 means eight channels; 0 means "describe it in the stream instead".
    channels: channelConfig === 7 ? 8 : channelConfig || 0,
  };
}

function parseStts(v, box) {
  const count = u32(v, box, 4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 8 + i * 8;
    if (box.bodyStart - v.base + o + 8 > v.bytes.length) break;
    out.push({ count: u32(v, box, o), delta: u32(v, box, o + 4) });
  }
  return out;
}

function parseStsz(v, box) {
  const uniform = u32(v, box, 4);
  const count = u32(v, box, 8);
  if (uniform) return { uniform, sizes: null, count };
  const sizes = new Float64Array(count);
  const dv = new DataView(v.bytes.buffer, v.bytes.byteOffset, v.bytes.byteLength);
  for (let i = 0; i < count; i++) {
    const o = box.bodyStart - v.base + 12 + i * 4;
    if (o + 4 > v.bytes.length) break;
    sizes[i] = dv.getUint32(o, false);
  }
  return { uniform: 0, sizes, count };
}

function parseStsc(v, box) {
  const count = u32(v, box, 4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 8 + i * 12;
    if (box.bodyStart - v.base + o + 12 > v.bytes.length) break;
    out.push({ firstChunk: u32(v, box, o), samplesPerChunk: u32(v, box, o + 4) });
  }
  return out;
}

function parseChunkOffsets(v, box, is64) {
  const count = u32(v, box, 4);
  const dv = new DataView(v.bytes.buffer, v.bytes.byteOffset, v.bytes.byteLength);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const o = box.bodyStart - v.base + 8 + i * (is64 ? 8 : 4);
    if (o + (is64 ? 8 : 4) > v.bytes.length) break;
    out[i] = is64 ? Number(dv.getBigUint64(o, false)) : dv.getUint32(o, false);
  }
  return out;
}

/** Read a box's payload from the file as its own view. */
async function readBox(file, box) {
  const buffer = await file.slice(box.bodyStart, box.bodyStart + box.bodySize).arrayBuffer();
  return view(new Uint8Array(buffer), box.bodyStart);
}

/**
 * Locate the `moov` box. It is usually before `mdat`, but some encoders put it at
 * the end, where a forward walk from the head cannot reach it; the tail is
 * scanned for the box type and read from the size field in front of it.
 *
 * A candidate is only accepted when it parses as a movie header. The four
 * characters "moov" occur in video data often enough that the first match in a
 * tail scan cannot be trusted.
 */
function looksLikeMoov(bytes, base) {
  const boxes = parseBoxesIn(view(bytes, base), base, base + bytes.length);
  return boxes.some((b) => b.type === "mvhd" || b.type === "trak");
}

async function readMoov(file) {
  const head = view(new Uint8Array(await file.slice(0, Math.min(file.size, 8 * 1024 * 1024)).arrayBuffer()));
  const top = parseBoxesIn(head, 0, head.bytes.length);
  const found = top.find((b) => b.type === "moov");
  if (found) {
    if (found.bodySize > 64 * 1024 * 1024) throw new Error("the MP4's moov box is implausibly large");
    const payload = await file.slice(found.bodyStart, found.bodyStart + found.bodySize).arrayBuffer();
    return view(new Uint8Array(payload), found.bodyStart);
  }
  // Tail scan: find the "moov" type, then read the 4-byte size just before it.
  const tailSize = Math.min(file.size, 32 * 1024 * 1024);
  const tailStart = file.size - tailSize;
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  for (let i = tail.length - 8; i >= 4; i--) {
    if (fourCC(tail, i + 4) !== "moov") continue;
    const size = new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getUint32(i, false);
    if (size < 8 || size > 64 * 1024 * 1024) continue;
    const absolute = tailStart + i;
    const payload = new Uint8Array(await file.slice(absolute + 8, absolute + size).arrayBuffer());
    if (!looksLikeMoov(payload, absolute + 8)) continue;
    return view(payload, absolute + 8);
  }
  throw new Error("the MP4 has no moov box");
}

/**
 * Demux an MP4's audio track.
 *
 * Returns `{ container, codec, description, sampleRate, channels,
 * durationSeconds, samples: [{ offset, size, time }] }`, `time` in seconds on
 * the track timeline. Only the header regions are read: no media data.
 */
export async function demuxMp4(file) {
  const moov = await readMoov(file);
  const moovChildren = parseBoxesIn(moov, moov.base, moov.base + moov.bytes.length);

  function byteIn(v, box, offset) {
    return v.bytes[box.bodyStart - v.base + offset] || 0;
  }

  let mdiaView = null;
  let mdiaBox = null;
  for (const trak of moovChildren) {
    if (trak.type !== "trak") continue;
    const trakView = childView(moov, trak);
    const mdia = find(trakView, { bodyStart: trak.bodyStart, bodySize: trak.bodySize }, "mdia");
    if (!mdia) continue;
    const mdiaV = childView(trakView, mdia);
    const hdlr = find(mdiaV, mdia, "hdlr");
    if (!hdlr) continue;
    // The handler type is the four characters after version/flags and pre_defined.
    const handler = String.fromCharCode(
      byteIn(mdiaV, hdlr, 8),
      byteIn(mdiaV, hdlr, 9),
      byteIn(mdiaV, hdlr, 10),
      byteIn(mdiaV, hdlr, 11)
    );
    if (handler !== "soun") continue;
    mdiaView = mdiaV;
    mdiaBox = mdia;
    break;
  }
  if (!mdiaBox) throw new Error("the MP4 has no audio track");

  const mdhd = find(mdiaView, mdiaBox, "mdhd");
  const timescale = mdhd ? timescaleOf(mdiaView, mdhd) : 0;
  const minf = find(mdiaView, mdiaBox, "minf");
  if (!minf) throw new Error("the audio track has no media information");
  const minfView = childView(mdiaView, minf);
  const stbl = find(minfView, minf, "stbl");
  if (!stbl) throw new Error("the audio track has no sample table");
  const stblView = childView(minfView, stbl);

  const stsd = find(stblView, stbl, "stsd");
  const sttsBox = find(stblView, stbl, "stts");
  const stszBox = find(stblView, stbl, "stsz");
  const stscBox = find(stblView, stbl, "stsc");
  const stcoBox = find(stblView, stbl, "stco");
  const co64Box = find(stblView, stbl, "co64");
  if (!stsd || !sttsBox || !stszBox || !stscBox || (!stcoBox && !co64Box)) {
    throw new Error("the audio track's sample table is incomplete");
  }

  // stsd: a count, then sample entries. Audio fields sit 28 bytes in.
  const entryCount = u32(stblView, stsd, 4);
  if (!entryCount) throw new Error("the audio track has no sample description");
  const entryOffset = 8;
  const entryType = fourCC(stblView.bytes, stsd.bodyStart - stblView.base + entryOffset + 4);
  const entrySize = new DataView(
    stblView.bytes.buffer,
    stblView.bytes.byteOffset,
    stblView.bytes.byteLength
  ).getUint32(stsd.bodyStart - stblView.base + entryOffset, false);
  const entryBody = stsd.bodyStart + entryOffset + 8;
  let channels = new DataView(
    stblView.bytes.buffer,
    stblView.bytes.byteOffset,
    stblView.bytes.byteLength
  ).getUint16(entryBody - stblView.base + 16, false);
  const entryRate =
    new DataView(stblView.bytes.buffer, stblView.bytes.byteOffset, stblView.bytes.byteLength).getUint32(
      entryBody - stblView.base + 24,
      false
    ) / 65536;

  let codec = entryType;
  let description = null;
  const entryView = {
    bytes: stblView.bytes.subarray(entryBody - stblView.base, entryBody - stblView.base + entrySize - 8),
    base: entryBody,
  };
  // The audio sample entry header is 28 bytes at version 0; versions 1 and 2 are
  // QuickTime variants that append 16 and 36 bytes before the child boxes.
  const entryVersion = new DataView(
    stblView.bytes.buffer,
    stblView.bytes.byteOffset,
    stblView.bytes.byteLength
  ).getUint16(entryBody - stblView.base, false);
  const entryHeader = 28 + (entryVersion === 1 ? 16 : entryVersion === 2 ? 36 : 0);
  const entryChildren = parseBoxesIn(entryView, entryBody + entryHeader, entryBody + entrySize - 8);
  let esds = entryChildren.find((b) => b.type === "esds");
  if (!esds) {
    // QuickTime wraps the decoder config in a `wave` box.
    const wave = entryChildren.find((b) => b.type === "wave");
    if (wave) {
      esds = parseBoxesIn(childView(entryView, wave), wave.bodyStart, wave.bodyStart + wave.bodySize).find(
        (b) => b.type === "esds"
      );
    }
  }
  if (esds) {
    const payload = childView(entryView, esds);
    description = audioSpecificConfig(payload.bytes);
  }
  if (description && description.length >= 2) {
    const objectType = (description[0] >> 3) & 0x1f;
    codec = `mp4a.40.${objectType || 2}`;
  } else if (entryType === "Opus" || entryType === "opus") {
    codec = "opus";
  } else if (entryType === "fLaC") {
    codec = "flac";
  } else if (entryType === "mp4a") {
    // No usable config descriptor: describe AAC-LC from the sample entry, which
    // is what the entry says in every practical case. Without a description an
    // AAC decoder is configured but has nothing to decode and yields silence.
    description = fallbackAudioConfig(entryRate || timescale, channels);
    codec = "mp4a.40.2";
  }

  // The config descriptor is authoritative about the codec's own rate and channel
  // count. The sample entry often disagrees -- a 5.1 track commonly declares two
  // channels there -- and configuring the decoder from the entry then mismatches
  // the stream.
  const codecInfo = audioConfigInfo(description);
  if (codecInfo && codecInfo.channels) channels = codecInfo.channels;

  const stts = parseStts(stblView, sttsBox);
  const sizes = parseStsz(stblView, stszBox);
  const stsc = parseStsc(stblView, stscBox);
  const chunkOffsets = parseChunkOffsets(stblView, stcoBox || co64Box, !stcoBox);

  const durations = new Float64Array(sizes.count);
  {
    let i = 0;
    for (const e of stts) {
      for (let k = 0; k < e.count && i < sizes.count; k++) durations[i++] = e.delta;
    }
  }

  const samples = new Array(sizes.count);
  let sampleIndex = 0;
  let time = 0;
  let sc = 0;
  for (let chunk = 0; chunk < chunkOffsets.length && sampleIndex < sizes.count; chunk++) {
    while (sc + 1 < stsc.length && stsc[sc + 1].firstChunk <= chunk + 1) sc++;
    const perChunk = stsc[sc] ? stsc[sc].samplesPerChunk : 0;
    let offset = chunkOffsets[chunk];
    for (let i = 0; i < perChunk && sampleIndex < sizes.count; i++, sampleIndex++) {
      const size = sizes.uniform || sizes.sizes[sampleIndex];
      samples[sampleIndex] = {
        offset,
        size,
        time: timescale ? time / timescale : 0,
      };
      offset += size;
      time += durations[sampleIndex];
    }
  }

  return {
    container: "mp4",
    codec,
    description,
    sampleRate: timescale || entryRate || 48000,
    channels: channels || 2,
    timescale,
    durationSeconds: timescale ? time / timescale : 0,
    samples,
  };
}

/**
 * Samples covering `[startSec, endSec)`, with a couple of frames of preroll so
 * the decoder has settled by the first wanted sample.
 */
export function selectSamples(track, startSec = 0, endSec = null) {
  const samples = track.samples || [];
  if (!samples.length) return { samples: [], preroll: 0, startSec: 0, endSec: 0 };
  const end = endSec == null ? track.durationSeconds : endSec;
  let first = 0;
  while (first < samples.length && samples[first].time < startSec) first++;
  const preroll = Math.min(2, first);
  const from = first - preroll;
  let last = from;
  while (last < samples.length && samples[last].time < end) last++;
  return {
    samples: samples.slice(from, last),
    preroll,
    startSec: samples[from] ? samples[from].time : 0,
    endSec: samples[Math.max(from, last - 1)] ? samples[Math.max(from, last - 1)].time : end,
  };
}
