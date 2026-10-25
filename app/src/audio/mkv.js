// Minimal Matroska / WebM demuxer: enough to find the audio track's blocks.
//
// The same reasoning as the MP4 demuxer: a video container is large because of
// the video, and the audio can be read on its own. Header elements (Info,
// Tracks, Cues) are usually near the start, so the track list and duration cost
// almost nothing; clusters are then walked only as far as the wanted range.
//
// Kept free of DOM imports so it can be unit-tested under Node.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
};

/** Read an EBML variable-length integer, returning `{ value, length }`. */
export function readVint(bytes, offset, keepMarker = false) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i];
  return { value, length };
}

/** Read an element header at `offset`: `{ id, size, headerLength, sizeLength, unknown }`. */
export function readElementHeader(bytes, offset) {
  const id = readVint(bytes, offset, true);
  if (!id) return null;
  const size = readVint(bytes, offset + id.length, false);
  if (!size) return null;
  // All-ones means "unknown size", used by live streams.
  const allOnes = size.value === Math.pow(2, size.length * 7) - 1;
  return {
    id: id.value,
    size: allOnes ? -1 : size.value,
    unknown: allOnes,
    headerLength: id.length + size.length,
    bodyStart: offset + id.length + size.length,
  };
}

function readUint(bytes, offset, length) {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[offset + i];
  return value;
}

function readFloat(bytes, offset, length) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
  return length === 8 ? dv.getFloat64(0) : dv.getFloat32(0);
}

function readString(bytes, offset, length) {
  let end = offset + length;
  while (end > offset && bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

/**
 * Walk the children of `[start, end)` in `bytes`, calling `visit(id, header)`.
 * Stops at the first element that runs past the end.
 */
function walk(bytes, start, end, visit) {
  let offset = start;
  while (offset + 2 < end) {
    const header = readElementHeader(bytes, offset);
    if (!header) return;
    if (header.unknown) {
      // Unknown-size cluster: its children follow inline. Visit it and let the
      // caller skip to the next known element.
      visit(header.id, header, offset);
      offset = header.bodyStart;
      continue;
    }
    if (header.bodyStart + header.size > end) return;
    visit(header.id, header, offset);
    offset = header.bodyStart + header.size;
  }
}

/**
 * Parse the audio track description and duration from the header elements.
 *
 * The Segment's children are walked for Info and Tracks; the clusters are not
 * touched here.
 */
export function parseMkvHeader(bytes) {
  let timecodeScale = 1000000; // 1 ms, the Matroska default
  let duration = 0;
  const tracks = [];
  let segmentDataStart = 0;

  const readSegmentChildren = (start, end) => {
    walk(bytes, start, end, (id, header) => {
      if (id === ID.Info) {
        walk(bytes, header.bodyStart, header.bodyStart + header.size, (sid, sh) => {
          if (sid === ID.TimecodeScale) timecodeScale = readUint(bytes, sh.bodyStart, sh.size);
          if (sid === ID.Duration) duration = readFloat(bytes, sh.bodyStart, sh.size);
        });
        return;
      }
      if (id !== ID.Tracks) return;
      walk(bytes, header.bodyStart, header.bodyStart + header.size, (tid, th) => {
        if (tid !== ID.TrackEntry) return;
        const track = {
          number: 0,
          type: 0,
          codec: "",
          codecPrivate: null,
          sampleRate: 0,
          channels: 0,
          defaultDurationNs: 0,
        };
        walk(bytes, th.bodyStart, th.bodyStart + th.size, (eid, eh) => {
          if (eid === ID.TrackNumber) track.number = readUint(bytes, eh.bodyStart, eh.size);
          else if (eid === ID.TrackType) track.type = readUint(bytes, eh.bodyStart, eh.size);
          else if (eid === ID.CodecID) track.codec = readString(bytes, eh.bodyStart, eh.size);
          else if (eid === ID.CodecPrivate)
            track.codecPrivate = bytes.slice(eh.bodyStart, eh.bodyStart + eh.size);
          else if (eid === ID.DefaultDuration)
            track.defaultDurationNs = readUint(bytes, eh.bodyStart, eh.size);
          else if (eid === ID.Audio) {
            walk(bytes, eh.bodyStart, eh.bodyStart + eh.size, (aid, ah) => {
              if (aid === ID.SamplingFrequency)
                track.sampleRate = readFloat(bytes, ah.bodyStart, ah.size);
              else if (aid === ID.Channels) track.channels = readUint(bytes, ah.bodyStart, ah.size);
            });
          }
        });
        tracks.push(track);
      });
    });
  };

  walk(bytes, 0, bytes.length, (id, header) => {
    if (id !== ID.Segment) return;
    segmentDataStart = header.bodyStart;
    readSegmentChildren(header.bodyStart, header.bodyStart + header.size);
  });

  const audio = tracks.find((t) => t.type === 2) || null;
  return {
    timecodeScale,
    durationSeconds: (duration * timecodeScale) / 1e9,
    audio,
    tracks,
    segmentDataStart,
  };
}

/**
 * Parse a block (SimpleBlock or Block) payload for `trackNumber`.
 *
 * Returns `{ keyframe, timecodeMs, frames: [{ start, size }] }` with frame
 * positions relative to the payload, or null when the block is another track's.
 * Laced blocks carry several frames, which are split so the decoder sees one
 * packet per chunk.
 */
export function parseBlock(payload, trackNumber) {
  const track = readVint(payload, 0, false);
  if (!track || track.value !== trackNumber) return null;
  let offset = track.length;
  if (offset + 3 > payload.length) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const timecode = dv.getInt16(offset, false);
  offset += 2;
  const flags = payload[offset++];
  const keyframe = (flags & 0x80) !== 0;
  const lacing = (flags >> 1) & 0x03;
  const frames = [];
  if (lacing === 0) {
    frames.push({ start: offset, size: payload.length - offset });
  } else {
    if (offset >= payload.length) return null;
    const laceCount = payload[offset++] + 1;
    const sizes = [];
    if (lacing === 2) {
      // Fixed-size lacing: every frame is the same length.
      const each = Math.floor((payload.length - offset) / laceCount);
      for (let i = 0; i < laceCount; i++) sizes.push(each);
    } else if (lacing === 1) {
      // Xiph lacing: sizes as 255-chained bytes; the last frame takes the rest.
      let total = 0;
      for (let i = 0; i < laceCount - 1; i++) {
        let size = 0;
        let b = 255;
        while (b === 255 && offset < payload.length) {
          b = payload[offset++];
          size += b;
        }
        sizes.push(size);
        total += size;
      }
      sizes.push(payload.length - offset - total);
    } else {
      // EBML lacing: a vint first size, then signed vint differences.
      const first = readVint(payload, offset, false);
      if (!first) return null;
      offset += first.length;
      let total = first.value;
      sizes.push(first.value);
      for (let i = 1; i < laceCount - 1; i++) {
        const diff = readVint(payload, offset, true);
        if (!diff) return null;
        offset += diff.length;
        const bias = Math.pow(2, diff.length * 7 - 1) - 1;
        const size = sizes[i - 1] + (diff.value - bias);
        sizes.push(size);
        total += size;
      }
      sizes.push(payload.length - offset - total);
    }
    let cursor = offset;
    for (const size of sizes) {
      if (size < 0 || cursor + size > payload.length) break;
      frames.push({ start: cursor, size });
      cursor += size;
    }
  }
  return { keyframe, timecodeMs: timecode, frames };
}

/**
 * Demux the audio track of an MKV/WebM.
 *
 * `samples` carry `{ offset, size, time }` where `offset` locates the payload in
 * the file, so the decode step can read only those bytes.
 */
export async function demuxMkv(file, { stopAfterSec = null } = {}) {
  const head = new Uint8Array(
    await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer()
  );
  const header = parseMkvHeader(head);
  if (!header.audio) throw new Error("the Matroska file has no audio track");
  const track = header.audio;
  if (!track.number) throw new Error("the audio track has no number");

  // Walk clusters, locating audio block payloads without reading media data.
  // Other tracks -- video, in practice -- are skipped by size: their payloads
  // are never fetched, which is what keeps a multi-gigabyte video cheap.
  const samples = [];
  let lastName = 0;
  const READ = 4 * 1024 * 1024;
  let buffer = new Uint8Array(0);
  let bufferStart = 0;
  const need = async (from, length) => {
    const end = Math.min(file.size, from + length);
    if (bufferStart <= from && end <= bufferStart + buffer.length) return;
    bufferStart = from;
    buffer = new Uint8Array(await file.slice(from, end).arrayBuffer());
  };
  const frameStepMs = track.defaultDurationNs ? track.defaultDurationNs / 1e6 : 0;

  let offset = header.segmentDataStart || 0;
  let guard = 0;
  while (offset < file.size && guard++ < 1000000) {
    await need(offset, READ);
    // Element positions are relative to the buffer window; `bufferStart` turns
    // them into file positions.
    const element = readElementHeader(buffer, offset - bufferStart);
    if (!element) break;
    const elementBody = bufferStart + element.bodyStart;
    if (element.id !== ID.Cluster) {
      if (element.size < 0) break;
      const next = elementBody + element.size;
      if (next <= offset) break; // malformed size: stop rather than spin
      offset = next;
      continue;
    }
    const clusterEnd =
      element.size < 0 ? file.size : Math.min(file.size, elementBody + element.size);
    let clusterTime = 0;
    let cursor = elementBody;
    let innerGuard = 0;
    while (cursor < clusterEnd && cursor < file.size && innerGuard++ < 1000000) {
      await need(cursor, 64);
      const child = readElementHeader(buffer, cursor - bufferStart);
      if (!child || child.size < 0) break;
      const childBody = bufferStart + child.bodyStart;
      const next = childBody + child.size;
      if (next <= cursor) break; // malformed size: stop rather than spin
      const localBody = child.bodyStart;
      const block = child.id === ID.SimpleBlock || child.id === ID.Block;
      // Peek at the block's track number before deciding to fetch its payload.
      const trackVint =
        block && localBody >= 0 && localBody < buffer.length
          ? readVint(buffer, localBody, false)
          : null;
      const isAudio = !!trackVint && trackVint.value === track.number;
      if (isAudio && localBody + child.size > buffer.length) {
        await need(cursor, child.size + (childBody - cursor) + 64);
      }
      if (child.id === ID.Timestamp) {
        clusterTime = readUint(buffer, localBody, child.size);
      } else if (isAudio) {
        const payload = buffer.subarray(localBody, localBody + child.size);
        const parsed = parseBlock(payload, track.number);
        if (parsed) {
          const blockTime = (clusterTime + parsed.timecodeMs) / 1000;
          parsed.frames.forEach((frame, i) => {
            samples.push({
              offset: childBody + frame.start,
              size: frame.size,
              time: blockTime + (frameStepMs ? (i * frameStepMs) / 1000 : 0),
            });
          });
          lastName = blockTime;
        }
      }
      cursor = next;
    }
    offset = element.size < 0 ? cursor : elementBody + element.size;
    if (samples.length > 500000) break;
    if (stopAfterSec != null && lastName > stopAfterSec) break;
  }

  if (!samples.length) throw new Error("the audio track has no readable blocks");
  const codecId = track.codec.toUpperCase();
  const codec = codecId.includes("OPUS")
    ? "opus"
    : codecId.includes("AAC")
      ? "mp4a.40.2"
      : codecId.includes("VORBIS")
        ? "vorbis"
        : codecId.includes("FLAC")
          ? "flac"
          : null;
  if (!codec) throw new Error(`unsupported Matroska audio codec ${track.codec}`);

  return {
    container: "mkv",
    codec,
    description: track.codecPrivate,
    sampleRate: track.sampleRate || 48000,
    channels: track.channels || 2,
    durationSeconds: Math.max(header.durationSeconds, lastName),
    samples,
  };
}
