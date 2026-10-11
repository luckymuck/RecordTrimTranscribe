// Session autosave in IndexedDB so work survives an accidental close.
//
// A session is a meta record plus an ordered list of audio chunks. A live
// recording appends chunks as they arrive, so a crash mid-recording loses at
// most the last chunk; a snapshot (a processed edit) replaces the chunks with a
// single WAV. Keys are prefixed so one session's chunks can be ranged-loaded in
// order, and so several sessions can coexist instead of overwriting each other.

const DB_NAME = "rts-session";
const STORE = "session";
const META_PREFIX = "meta:";
const CHUNK_PREFIX = "chunk:";
const RANGE_END = "\uffff";

// One shared connection: opening a fresh one per call leaked a connection per
// operation, and none were ever closed (REC-8).
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = (e) => {
      if (!e.target.result.objectStoreNames.contains(STORE)) {
        e.target.result.createObjectStore(STORE);
      }
    };
    rq.onsuccess = (e) => {
      const db = e.target.result;
      // Another tab upgrading the schema needs this connection out of the way.
      db.onversionchange = () => {
        try {
          db.close();
        } catch (err) {}
        dbPromise = null;
      };
      resolve(db);
    };
    rq.onerror = (e) => {
      dbPromise = null;
      reject(e.target.error || new Error("IndexedDB open failed"));
    };
    rq.onblocked = () => {
      dbPromise = null;
      reject(new Error("IndexedDB open blocked"));
    };
  });
  return dbPromise;
}

/** Close the shared connection (called on unload). */
export function closeStorage() {
  const p = dbPromise;
  dbPromise = null;
  if (!p) return;
  p.then((db) => {
    try {
      db.close();
    } catch (e) {}
  }).catch(() => {});
}

/**
 * Ask the browser to make this origin's storage persistent, so a long recording
 * is not evicted under pressure. Best effort; returns whether it is persistent.
 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch (e) {
    return false;
  }
}

/** `{ usage, quota }` in bytes, or null when the browser will not say. */
export async function storageEstimate() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return quota > 0 ? { usage, quota } : null;
  } catch (e) {
    return null;
  }
}

function write(db, work) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    try {
      work(t.objectStore(STORE));
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error || new Error("IndexedDB write failed"));
    t.onabort = () => reject(t.error || new Error("IndexedDB write aborted"));
  });
}

function read(db, work) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readonly");
    const rq = work(t.objectStore(STORE));
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
    t.onabort = () => reject(t.error || new Error("IndexedDB read aborted"));
  });
}

const metaKey = (id) => META_PREFIX + id;
const chunkKey = (id, index) => `${CHUNK_PREFIX}${id}:${String(index).padStart(8, "0")}`;
const chunkRange = (id) =>
  IDBKeyRange.bound(`${CHUNK_PREFIX}${id}:`, `${CHUNK_PREFIX}${id}:${RANGE_END}`);
const metaRange = () => IDBKeyRange.bound(META_PREFIX, META_PREFIX + RANGE_END);

/** Whether the browser can persist (basically always true in a secure context). */
export function storageAvailable() {
  return !!window.indexedDB && !!window.isSecureContext;
}

/** Create or update a session's metadata record. */
export async function createSession(id, meta) {
  const db = await openDB();
  await write(db, (s) => s.put({ ...meta, id, savedAt: Date.now() }, metaKey(id)));
}

/** Append one captured chunk. `arrayBuffer` avoids the Safari Blob pitfall. */
export async function appendChunk(id, index, arrayBuffer) {
  const db = await openDB();
  await write(db, (s) => {
    s.put(arrayBuffer, chunkKey(id, index));
    s.put({ id, savedAt: Date.now() }, metaKey(id));
  });
}

/** Replace a session's audio with a single snapshot (a processed edit). */
export async function replaceSnapshot(id, meta, arrayBuffer) {
  const db = await openDB();
  await write(db, (s) => {
    s.delete(chunkRange(id));
    s.put(arrayBuffer, chunkKey(id, 0));
    s.put({ ...meta, id, savedAt: Date.now() }, metaKey(id));
  });
}

/** All session metadata, newest first. */
export async function listSessions() {
  const db = await openDB();
  const metas = await read(db, (s) => s.getAll(metaRange()));
  return (metas || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/** Load one session as `{ meta, blob }`, or null. */
export async function loadSession(id) {
  const db = await openDB();
  const meta = await read(db, (s) => s.get(metaKey(id)));
  if (!meta) return null;
  const chunks = await read(db, (s) => s.getAll(chunkRange(id)));
  if (!chunks || chunks.length === 0) return null;
  const blob = new Blob(chunks, { type: meta.type || "audio/webm" });
  return { meta, blob };
}

export async function deleteSession(id) {
  const db = await openDB();
  await write(db, (s) => {
    s.delete(metaKey(id));
    s.delete(chunkRange(id));
  });
}
