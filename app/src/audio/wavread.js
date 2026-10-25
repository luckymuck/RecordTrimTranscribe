// WAV reading: header parsing, PCM decoding, and byte-range reads.
//
// The browser's `decodeAudioData` refuses an ArrayBuffer larger than 2 GB, which
// a 48 kHz 16-bit mono WAV reaches at about six hours, and it cannot decode a
// range at all. Reading the PCM ourselves removes both limits, keeps the memory
// cost to the decoded samples, and lets a very long file be opened one part at a
// time.
//
// Kept free of DOM imports so it can be unit-tested under Node.

/** Where a WAV's header is searched; metadata chunks can be a few kilobytes. */
const HEADER_SCAN_BYTES = 1024 * 1024;
/** Bytes per read while decoding. */
const READ_SLICE_BYTES = 8 * 1024 * 1024;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function fourCC(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

/** Bytes each sample occupies for a format tag and bit depth, or 0 when unsupported. */
export function bytesPerSample(formatTag, bitsPerSample) {
  if (formatTag === FORMAT_FLOAT && bitsPerSample === 32) return 4;
  if (formatTag === FORMAT_PCM && (bitsPerSample === 16 || bitsPerSample === 24 || bitsPerSample === 32)) {
    return bitsPerSample / 8;
  }
  return 0;
}

/**
 * Parse a WAV header from the first bytes of the file.
 *
 * `fileSize` is needed because a streamed WAV can declare a data size of
 * `0xFFFFFFFF`; the real length is then whatever is left in the file.
 */
export function parseWavHeader(bytes, fileSize = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || fourCC(bytes, 0) !== "RIFF" || fourCC(bytes, 8) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = fourCC(bytes, offset);
    const declared = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      let formatTag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (formatTag === FORMAT_EXTENSIBLE && declared >= 40 && body + 26 <= bytes.length) {
        // The real format tag is the first field of the sub-format GUID.
        formatTag = view.getUint16(body + 24, true);
      }
      fmt = { formatTag, channels, sampleRate, blockAlign, bitsPerSample };
    } else if (id === "data") {
      const available = Math.max(0, fileSize - body);
      data = { offset: body, bytes: declared === 0xffffffff ? available : Math.min(declared, available) };
    }
    if (fmt && data) break;
    offset = body + declared + (declared % 2);
  }
  if (!fmt) throw new Error("the WAV has no fmt chunk");
  if (!data) throw new Error("the WAV has no data chunk");
  if (!fmt.channels || !fmt.sampleRate) throw new Error("the WAV header is incomplete");
  const frameBytes = bytesPerSample(fmt.formatTag, fmt.bitsPerSample);
  if (!frameBytes) {
    throw new Error(
      `unsupported WAV encoding (format ${fmt.formatTag}, ${fmt.bitsPerSample}-bit)`
    );
  }
  const blockAlign = fmt.blockAlign || frameBytes * fmt.channels;
  const frames = Math.floor(data.bytes / blockAlign);
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    formatTag: fmt.formatTag,
    blockAlign,
    frameBytes,
    dataOffset: data.offset,
    dataBytes: data.bytes,
    frames,
    durationSeconds: frames / fmt.sampleRate,
  };
}

/** Read the header of a `File`/`Blob`. */
export async function probeWav(file) {
  const head = await file.slice(0, Math.min(file.size, HEADER_SCAN_BYTES)).arrayBuffer();
  return parseWavHeader(new Uint8Array(head), file.size);
}

function sampleAt(view, offset, formatTag, bitsPerSample) {
  if (formatTag === FORMAT_FLOAT) return view.getFloat32(offset, true);
  if (bitsPerSample === 16) return view.getInt16(offset, true) / 32768;
  if (bitsPerSample === 24) {
    const v = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    return (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
  }
  return view.getInt32(offset, true) / 2147483648;
}

/**
 * Decode `[startSec, endSec)` of a WAV into mono `f32`.
 *
 * Only the requested bytes are read, in bounded slices, so a six-hour file costs
 * what its part costs. `onProgress` receives 0..1.
 */
export async function readWavRange(file, { startSec = 0, endSec = null, onProgress } = {}) {
  const header = await probeWav(file);
  const total = header.frames;
  const firstFrame = Math.max(0, Math.min(total, Math.floor(startSec * header.sampleRate)));
  const lastFrame = Math.max(
    firstFrame,
    Math.min(total, Math.ceil((endSec == null ? header.durationSeconds : endSec) * header.sampleRate))
  );
  const frames = lastFrame - firstFrame;
  const out = new Float32Array(frames);
  if (!frames) return { pcm: out, sampleRate: header.sampleRate, header };

  const startBytes = header.dataOffset + firstFrame * header.blockAlign;
  const endBytes = header.dataOffset + lastFrame * header.blockAlign;
  const channels = header.channels;
  // Slices are whole frames, so no frame straddles a read boundary.
  const framesPerSlice = Math.max(1, Math.floor(READ_SLICE_BYTES / header.blockAlign));
  let byteCursor = startBytes;
  let frame = 0;
  while (byteCursor < endBytes && frame < frames) {
    const sliceEnd = Math.min(endBytes, byteCursor + framesPerSlice * header.blockAlign);
    const buffer = await file.slice(byteCursor, sliceEnd).arrayBuffer();
    const view = new DataView(buffer);
    const alignedBytes = Math.floor(buffer.byteLength / header.blockAlign);
    for (let i = 0; i < alignedBytes && frame < frames; i++, frame++) {
      let sum = 0;
      const base = i * header.blockAlign;
      for (let c = 0; c < channels; c++) {
        sum += sampleAt(view, base + c * header.frameBytes, header.formatTag, header.bitsPerSample);
      }
      out[frame] = sum / channels;
    }
    byteCursor = sliceEnd;
    if (onProgress) {
      onProgress(Math.min(1, (byteCursor - startBytes) / Math.max(1, endBytes - startBytes)));
    }
  }
  return { pcm: out, sampleRate: header.sampleRate, header };
}
