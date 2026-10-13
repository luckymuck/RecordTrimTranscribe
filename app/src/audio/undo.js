// Exact undo snapshots for destructive clean-up runs.
//
// A long clean-up cannot keep a second full Float32 buffer on the JS heap.
// The before-state is copied once into a chunked Blob, which lives only as long
// as its history entry. Restoring materializes one buffer only if undo is
// actually pressed, so short recordings keep their fast in-memory path and long
// recordings stop losing their history at an arbitrary length.

/** Four megabytes of Float32 samples per Blob part. */
export const UNDO_SNAPSHOT_CHUNK_SAMPLES = 1048576;

/**
 * Copy exact Float32 samples into a chunked Blob. Chunking avoids one giant
 * allocation while assembling the snapshot, and progress is reported per part.
 */
export async function snapshotPcm(pcm, { chunkSamples = UNDO_SNAPSHOT_CHUNK_SAMPLES, onProgress } = {}) {
  if (!(pcm instanceof Float32Array)) throw new Error("undo snapshots store Float32 PCM");
  const size = Math.max(1, Math.floor(Number(chunkSamples) || 0));
  const parts = [];
  for (let start = 0; start < pcm.length; start += size) {
    const end = Math.min(start + size, pcm.length);
    parts.push(pcm.slice(start, end).buffer);
    if (onProgress) onProgress(end / pcm.length);
    if (parts.length % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

/** Restore an exact Float32 buffer from a snapshot Blob. */
export async function restorePcmSnapshot(blob, length) {
  if (!(blob instanceof Blob)) throw new Error("undo snapshot must be a Blob");
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`undo snapshot length must be a non-negative integer, got ${length}`);
  }
  const buffer = await blob.arrayBuffer();
  if (buffer.byteLength !== length * 4) {
    throw new Error(`undo snapshot has ${buffer.byteLength} bytes, expected ${length * 4}`);
  }
  return new Float32Array(buffer);
}
