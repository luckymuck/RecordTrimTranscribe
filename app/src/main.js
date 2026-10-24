// Application wiring: record/load → waveform → playback → transcribe → export.
import { initDsp, getDspVersion, makeBakedMap, makeSkipBakedMap, timeStretchSkipSilence, silenceZones, softLimiter, levelVoices, highpassFilter } from "./core/dsp.js";
import { decodeAudioBlob, audioContext } from "./audio/decode.js";
import { Recorder } from "./audio/record.js";
import { encodeAsync, encodeWav } from "./audio/encode.js";
import { readWavTranscript, withoutTranscript } from "./audio/wav.js";
import { appendChunk, closeStorage, createSession, deleteSession, listSessions, loadSession, pruneSessions, replaceSnapshot, requestPersistentStorage, storageAvailable, storageEstimate } from "./storage.js";
import { WaveformView } from "./ui/waveform.js";
import { Player } from "./playback.js";
import { transcribe, cancelTranscription } from "./transcribe/whisper.js";
import { toSrt, toTranscriptJson, toTxt, toVtt } from "./transcript/format.js";
import { isTranscriptName, parseTranscriptText } from "./transcript/parse.js";
import { findLineIndex, followScrollTop, missingWordMarkers, speechRegions } from "./transcript/view.js";
import { exportSlice, downloadBlob } from "./export/clips.js";
import { buildClips, splitLabels } from "./export/boundaries.js";
import {
  backupName,
  clipExportName,
  clipName,
  exportBaseName,
  recordingName,
  transcriptName,
  wholeExportName,
} from "./util/filenames.js";
import { CLICK_PX, SPEED_MAX, SPEED_MIN, clampSpeed, speedAfterDrag, speedFromDrag, stepSpeed } from "./ui/speed.js";
import { zoomAnchor, zoomAround } from "./ui/view.js";
import { describeAge, describeSeconds } from "./util/describe.js";
import { peakOf } from "./audio/normalize.js";
import { cleanUp, cleanupActive, cleanupOptions, cleanupRanges, cleanupSummary, LIMIT_CEILING_DB, RUMBLE_CUTOFF_HZ, LEVEL_MAX_BOOST_DB, LEVEL_WINDOW_S } from "./audio/enhance.js";

const $ = (id) => document.getElementById(id);

/** True inside the Tauri desktop shell, where the models ship with the app. */
function isDesktopApp() {
  return location.hostname === "tauri.localhost" || location.protocol === "tauri:";
}

const state = {
  pcm: null,
  sampleRate: 48000,
  splits: [],
  transcript: null,
  cursorSample: 0,
  inputDeviceId: null,
  outputDeviceId: null,
  sourceName: "",
  saved: true,
  // IndexedDB session this source autosaves into. A fresh id per source means a
  // new recording never overwrites an unrecovered one.
  sessionId: null,
  // The pristine source, as Int16: every clean-up renders from this, so runs
  // never stack, undo is a re-render, and transcription can use the original
  // rather than the cleaned audio. Int16 is half an f32 copy and its -96 dBFS
  // quantization sits far below any recording's own noise floor.
  original: null,
  // The clean-up currently applied to the working copy, as
  // `{ options, scope }`, or null. `scope` is "full", "clips" (each clip on its
  // own) or a clip index as a string.
  cleanup: null,
  // A recording's pristine audio is already persisted chunk by chunk, so its
  // autosave must not replace those chunks with a snapshot of an edit.
  keepChunks: false,
};

/** A pristine Int16 copy of `pcm`. */
function toInt16(pcm) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.round(pcm[i] * 32767);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** A fresh f32 copy of the pristine source. */
function pristinePcm() {
  if (!state.original) return null;
  const out = new Float32Array(state.original.length);
  for (let i = 0; i < out.length; i++) out[i] = state.original[i] / 32767;
  return out;
}

// The last committed split list, so a split edit can be recorded in the history
// as one undoable step (and a drag, which fires many times, as a single one).
let lastSplits = [];
// When the current recording started, so its name reflects the start time.
let recStartDate = new Date();

/** A short unique id for an autosave session. */
function newSessionId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

const recorder = new Recorder();
let recTimer = null;
let transcribing = false;

// ── Busy overlay ──────────────────────────────────────────────────────────────
// Shown while a file is decoded or an export is rendered. The spinner animates
// with a transform, so it keeps turning even while the main thread is blocked.
function showBusy(text) {
  const textEl = $("busyText");
  if (textEl) textEl.textContent = text || "Working…";
  const el = $("busy");
  if (el) el.classList.add("on");
}

function hideBusy() {
  const el = $("busy");
  if (el) el.classList.remove("on");
}

/** Resolve once the browser has painted, so the overlay is visible before work. */
function nextPaint() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    // rAF does not fire in a hidden tab, so fall back to a timer.
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 60);
  });
}

/** Run `work` with the overlay up, giving the browser a frame to show it first. */
async function withBusy(text, work) {
  showBusy(text);
  await nextPaint();
  try {
    return await work();
  } finally {
    hideBusy();
  }
}

const waveform = new WaveformView({
  main: $("mainwave"),
  overview: $("overview"),
  playhead: $("playhead"),
  onSeek: (sample) => {
    state.cursorSample = sample;
    waveform.setPlayhead(sample);
    $("cursorTime").textContent = fmt(sample);
    if (player.playing) player.play(sample, currentSpeed());
  },
  onSplitsChange: (splits, dragging) => {
    state.splits = splits.slice();
    $("splitInfo").textContent = `${splits.length} splits`;
    if (!dragging) {
      // A settled change is one undoable edit. Mid-drag calls leave the
      // baseline alone, so dragging a split undoes as a single step.
      const changed =
        splits.length !== lastSplits.length || splits.some((v, i) => v !== lastSplits[i]);
      if (changed) {
        pushHistory({ kind: "splits", before: lastSplits.slice(), after: splits.slice() });
        lastSplits = splits.slice();
      }
    }
    if (dragging) {
      // Mid-drag: labels only. Rebuilding the clip list (a whole-file export
      // map when baked) and the transcript scopes on every pointermove is what
      // made dragging heavy.
      updateSplitLabels();
      return;
    }
    renderClipList();
    updateSplitLabels();
    renderTranscriptScopes();
    renderCleanupScopes();
  },
  onViewChange: () => {},
});

/** One transport button: play while stopped, stop while playing. */
function setPlayButton(playing) {
  const btn = $("playBtn");
  if (!btn) return;
  btn.textContent = playing ? "■" : "▶";
  btn.title = playing ? "Stop (Space)" : "Play (Space)";
  btn.setAttribute("aria-label", playing ? "Stop" : "Play");
  btn.disabled = !state.pcm;
}

const player = new Player({
  onPosition: (sample) => {
    state.cursorSample = sample;
    waveform.setPlayhead(sample);
    $("cursorTime").textContent = fmt(sample);
    followTranscriptTo(sample / state.sampleRate);
  },
  onEnd: () => setPlayButton(false),
});

function fmt(sample) {
  if (!state.pcm) return "—";
  return fmtSeconds(sample / state.sampleRate);
}

function fmtSeconds(s) {
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(Math.floor(s % 60)).padStart(2, "0");
  const cs = String(Math.floor((s % 1) * 100)).padStart(2, "0");
  return `${mm}:${ss}.${cs}`;
}

let speedValue = 1.0;

// Silence longer than this is skipped, both in playback and in a speed-baked
// export. A short pause is left in its place so the next word stays easy to
// pick up. That pause is source time at 1.00x; it shortens with the speed.
const SKIP_MIN_S = 0.25;
// Kept pause in source seconds at 1.00x; it shortens with the speed until it
// reaches SKIP_KEEP_FLOOR_S of output, then stops shrinking so adjacent words
// cannot fuse.
const SKIP_KEEP_S = 0.2;
const SKIP_KEEP_FLOOR_S = 0.1;
let skipSilence = false;
// Raw detected silence runs, speed-independent. The speed-dependent inset is
// applied when the gap map is built, so changing speed never re-scans.
let silenceRunCache = null;

// Approximate one-time download size per model, shown before the first
// transcription so the fetch is never a surprise (TX-13).
const MODEL_SIZES = {
  "onnx-community/whisper-tiny_timestamped": "40 MB",
  "onnx-community/whisper-base_timestamped": "75 MB",
  "onnx-community/whisper-small_timestamped": "250 MB",
};
let modelNoteShown = false;

/** Human-readable free storage, or "" when the browser will not say. */
async function freeStorageText() {
  const est = await storageEstimate();
  if (!est) return "";
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  return `${mb(Math.max(0, est.quota - est.usage))} free of ${mb(est.quota)}`;
}

function currentSpeed() {
  return speedValue;
}

/** Source seconds of silence kept on each side of a gap at `speed`. */
function skipKeepSourceSeconds(speed = speedValue) {
  return Math.max(SKIP_KEEP_S, SKIP_KEEP_FLOOR_S * speed);
}

function setSpeedUI(s, rebase = true) {
  speedValue = clampSpeed(s);
  $("speed").textContent = speedValue.toFixed(2) + "×";
  $("speed").setAttribute("aria-valuenow", speedValue.toFixed(2));
  player.setSpeed(speedValue);
  // The kept pause scales with speed, so the gap map changes too. During a dial
  // drag this is deferred to pointerup to keep the drag smooth.
  if (rebase && skipSilence) rebaseSkipSilence();
}

/** Re-apply the skip map and restart at the playhead so the cursor stays put. */
function rebaseSkipSilence() {
  const wasPlaying = player.playing;
  const pos = state.cursorSample;
  applySkipSilence();
  if (wasPlaying) player.play(pos, currentSpeed());
}

/** Raw silence runs `[{start, end}]`, computed once per loaded recording. */
function getSilenceRuns() {
  if (!state.pcm) return [];
  if (!silenceRunCache) {
    silenceRunCache = silenceZones(state.pcm, state.sampleRate, SKIP_MIN_S);
  }
  return silenceRunCache;
}

/** Gap interiors to skip at the current speed, in input samples. */
function getSilenceZones() {
  const runs = getSilenceRuns();
  if (!runs.length) return [];
  const half = (skipKeepSourceSeconds() * state.sampleRate) / 2;
  const zones = [];
  for (const run of runs) {
    const start = Math.round(run.start + half);
    const end = Math.round(run.end - half);
    if (end > start) zones.push({ start, end });
  }
  return zones;
}

/** Apply the current skip-silence setting to the live player. */
function applySkipSilence() {
  player.setSkipMap(skipSilence ? getSilenceZones() : []);
}

function setSkipSilence(on) {
  skipSilence = on;
  const box = $("skipSilence");
  if (box) box.setAttribute("aria-pressed", on ? "true" : "false");
  if (on && state.pcm) {
    $("saveStatus").textContent = "Finding silence…";
    // Let the status paint before the (synchronous) energy scan runs.
    setTimeout(() => {
      try {
        rebaseSkipSilence();
        const zones = getSilenceZones().length;
        $("saveStatus").textContent = zones
          ? `Skipping ${zones} silence gap${zones === 1 ? "" : "s"} over ${SKIP_MIN_S}s`
          : `No silence longer than ${SKIP_MIN_S}s found`;
      } catch (err) {
        skipSilence = false;
        if (box) box.setAttribute("aria-pressed", "false");
        applySkipSilence();
        $("saveStatus").textContent = `Skip silence failed: ${err.message}`;
      }
      refreshClipDurations();
    }, 0);
  } else {
    rebaseSkipSilence();
    refreshClipDurations();
  }
}

// ── Data-loss safety ──────────────────────────────────────────────────────────
function fmtShort(sample) {
  if (!state.pcm) return "0:00";
  const s = sample / state.sampleRate;
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(Math.floor(s % 60)).padStart(2, "0");
  return `${mm}:${ss}`;
}

function markSaved() {
  state.saved = true;
  $("saveStatus").textContent = "saved ✓";
  // An explicit save clears this source's recovery slot, so the banner stops
  // reappearing on every launch.
  if (state.sessionId) {
    const id = state.sessionId;
    deleteSession(id).catch(() => {});
  }
}

function markUnsaved() {
  state.saved = false;
  $("saveStatus").textContent = "unsaved ⚠";
}

/**
 * Persist the source into IndexedDB so it survives a page close.
 *
 * A recording's pristine audio is already stored chunk by chunk as it arrives,
 * so only its metadata is updated: replacing those chunks with a WAV snapshot of
 * a cleaned edit used to destroy the original capture. Anything else stores the
 * pristine source, not the render, so a recovery can reproduce any clean-up.
 */
let autosaveSnapshotDone = false;

async function persistAutosave() {
  if (!state.pcm || !storageAvailable()) return;
  if (!state.sessionId) state.sessionId = newSessionId();
  try {
    const meta = {
      name: state.sourceName || "recording",
      sampleRate: state.sampleRate,
      seconds: state.pcm ? state.pcm.length / state.sampleRate : 0,
      cleanup: state.cleanup || null,
    };
    if (state.keepChunks) {
      // A live recording's chunks are the pristine capture, so only the metadata
      // is written; replacing them with a WAV snapshot of an edit destroyed it.
      // `live` reflects whether capture is actually running, so a finished
      // recording does not come back labelled "interrupted".
      const live = recorder.status() !== "idle";
      await createSession(state.sessionId, { ...meta, type: "audio/webm", live });
      return;
    }
    if (autosaveSnapshotDone) {
      // The pristine source has not changed, so only the metadata (the clean-up
      // options) needs writing. Re-encoding the WAV on every edit cost 346 MB of
      // work per swap on a one-hour recording.
      await createSession(state.sessionId, { ...meta, type: "audio/wav" });
      return;
    }
    const blob = encodeWav(pristinePcm() || state.pcm, state.sampleRate);
    const buffer = await blob.arrayBuffer();
    await replaceSnapshot(state.sessionId, { ...meta, type: "audio/wav" }, buffer);
    autosaveSnapshotDone = true;
  } catch (e) {
    // Storage unavailable or full: say so rather than claiming protection.
    $("saveStatus").textContent = "unsaved ⚠ (autosave failed)";
  }
}

/** Ask before an action that would replace an unsaved clip. */
function confirmIfUnsaved() {
  if (state.pcm && !state.saved) {
    return window.confirm(
      "You have an unsaved recording. Export a backup first if you need it.\n\nContinue and replace it?"
    );
  }
  return true;
}

function enableCards(enabled) {
  for (const id of ["waveCard", "txCard", "exportCard"]) {
    const card = $(id);
    card.setAttribute("aria-disabled", enabled ? "false" : "true");
    // UI-2: aria-disabled alone left the controls focusable and tabbable.
    // `inert` removes them from the tab order and from hit testing.
    card.inert = !enabled;
  }
}

function setSource(pcm, sampleRate, label, { autosave = true, saved = false, sessionId = null, keepChunks = false } = {}) {
  state.pcm = pcm;
  state.sampleRate = sampleRate;
  state.transcript = null;
  state.splits = [];
  lastSplits = [];
  state.sourceName = label || "recording";
  state.sessionId = sessionId || newSessionId();
  // The pristine copy every clean-up renders from, and the options applied to
  // the working copy (none, for a fresh source).
  state.original = toInt16(pcm);
  state.cleanup = null;
  state.keepChunks = keepChunks;
  autosaveSnapshotDone = false;
  // A new source invalidates the edit history.
  clearHistory();
  // Play should start at the beginning of the new source, not wherever the
  // previous one was left.
  state.cursorSample = 0;
  waveform.setData(pcm, sampleRate);
  player.setSource(pcm, sampleRate);
  silenceRunCache = null;
  clearRenderCache();
  applySkipSilence();
  $("fileMeta").textContent = `${label} · ${(pcm.length / sampleRate).toFixed(1)}s @ ${sampleRate} Hz`;
  enableCards(true);
  if (saved) markSaved();
  else markUnsaved();
  // A file already on disk needs no IndexedDB copy; a finished recording is
  // already persisted chunk-by-chunk, so it needs no snapshot either.
  if (autosave) persistAutosave();
  renderClipList();
  updateSplitLabels();
  $("transcript").innerHTML = "";
  $("txActions").style.display = "none";
  setImportedTranscript("");
  $("cursorTime").textContent = "—";
  setPlayButton(false);
}

// ── Devices ───────────────────────────────────────────────────────────────────
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => refreshDevices());
}

function deviceLabel(d, fallback) {
  return d.label || fallback;
}

function fillSelect(el, list, current, kindLabel) {
  el.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Default";
  el.appendChild(def);
  let counter = 0;
  for (const d of list) {
    // Before microphone permission, device IDs may be empty. Those entries
    // cannot be selected meaningfully, so only offer addressable devices.
    if (!d.deviceId) continue;
    counter += 1;
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = deviceLabel(d, `${kindLabel} ${counter}`);
    el.appendChild(o);
  }
  if (current && [...el.options].some((option) => option.value === current)) {
    el.value = current;
  } else if (el === $("devInput")) {
    state.inputDeviceId = null;
  } else {
    state.outputDeviceId = null;
  }
}

async function refreshDevices() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devs = await navigator.mediaDevices.enumerateDevices();
    fillSelect(
      $("devInput"),
      devs.filter((d) => d.kind === "audioinput"),
      state.inputDeviceId,
      "Microphone"
    );
    fillSelect(
      $("devOutput"),
      devs.filter((d) => d.kind === "audiooutput"),
      state.outputDeviceId,
      "Speaker"
    );
  } catch (e) {
    /* enumerateDevices can fail before mic permission; ignore */
  }
}

/**
 * Browsers hide device labels—and sometimes IDs—until microphone permission is
 * granted. Refreshing alone cannot reveal them: obtain a short-lived permission
 * first, then relist.
 */
async function requestDeviceAccess() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch (e) {
    return false;
  }
}

$("deviceBtn").addEventListener("click", async () => {
  const row = $("deviceRow");
  const open = row.hidden;
  row.hidden = !open;
  const btn = $("deviceBtn");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.setAttribute("aria-pressed", open ? "true" : "false");
  if (!open) return;
  // Device names and ids stay hidden until the page has microphone permission,
  // so opening the panel is what asks for it.
  $("deviceStatus").textContent = "Checking devices…";
  if (!(await requestDeviceAccess())) {
    $("deviceStatus").textContent = "Microphone permission is needed before device names are shown.";
    return;
  }
  await refreshDevices();
  $("deviceStatus").textContent = "";
});
$("devInput").addEventListener("change", (e) => {
  state.inputDeviceId = e.target.value || null;
});
$("devOutput").addEventListener("change", async (e) => {
  const id = e.target.value;
  state.outputDeviceId = id || null;
  if (!id) return;
  const ctx = audioContext();
  if (ctx.setSinkId) {
    try {
      await ctx.setSinkId(id);
    } catch (err) {
      alert("Could not set output device: " + err.message);
    }
  } else {
    alert("This browser does not support changing the output device.");
  }
});

// ── Split labels (time + number + optional transcript words) ────────────────
// The transcript chunks are sorted once and reused; sorting the whole list for
// every split on every redraw was the other half of the drag cost.
let sortedChunksCache = { src: null, list: [] };

function sortedTranscriptChunks() {
  const tx = state.transcript;
  if (!tx || !tx.chunks) return [];
  if (sortedChunksCache.src === tx.chunks) return sortedChunksCache.list;
  const list = tx.chunks
    .filter((c) => Array.isArray(c.timestamp))
    .sort((a, b) => a.timestamp[0] - b.timestamp[0]);
  sortedChunksCache = { src: tx.chunks, list };
  return list;
}

/** First few transcribed words of the clip starting at `startSample` (TX-9). */
function transcriptWordsForClip(startSample, endSample) {
  const list = sortedTranscriptChunks();
  if (!list.length || !state.pcm) return "";
  const startSeconds = startSample / state.sampleRate;
  const endSeconds = (endSample == null ? state.pcm.length : endSample) / state.sampleRate;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].timestamp[0] < startSeconds) lo = mid + 1;
    else hi = mid;
  }
  // Bounded to the clip at both ends: a split in an untranscribed region used to
  // pick up whatever words came next from anywhere later in the file.
  const text = list
    .slice(lo)
    .filter((w) => w.timestamp[0] >= startSeconds && w.timestamp[0] < endSeconds)
    .slice(0, 4)
    .map((w) => w.text.trim())
    .join(" ")
    .trim();
  return text ? "-" + text : "";
}

function updateSplitLabels() {
  if (!state.pcm) {
    waveform.setSplitLabels([]);
    return;
  }
  // Number only the splits that become clip boundaries, so the labels on the
  // waveform are exactly the clip numbers in the export list (WF-2). Each label
  // is bounded to its own clip (TX-9).
  const valid = splitLabels(state.splits, state.pcm.length);
  const labels = valid.map(({ sample, label }, i) => {
    const end = i + 1 < valid.length ? valid[i + 1].sample : state.pcm.length;
    return `${fmtShort(sample)}-${label}${transcriptWordsForClip(sample, end)}`;
  });
  waveform.setSplitLabels(labels);
}

// ── Recording ────────────────────────────────────────────────────────────────
function setRecordingUi(active) {
  setPlayButton(false);
  // While capturing, the transport is unavailable.
  if (active) $("playBtn").disabled = true;
  $("fileInput").disabled = active;
  $("loadLabel").classList.toggle("is-disabled", active);
  // Avoid transcribing old audio while the mic is capturing.
  $("transcribeBtn").disabled = active;
}

$("recordBtn").addEventListener("click", async () => {
  if (transcribing) return;
  const status = recorder.status();

  if (status === "recording") {
    // Pause: same file, keep the mic and recorder alive.
    recorder.pause();
    $("recordBtn").textContent = "▶ Resume";
    $("recordBtn").classList.add("paused");
    $("meterFill").style.width = "0%";
    return;
  }
  if (status === "paused") {
    recorder.resume();
    $("recordBtn").textContent = "⏸ Pause";
    $("recordBtn").classList.remove("paused");
    return;
  }

  // idling: start a new recording.
  if (!confirmIfUnsaved()) return;
  // Avoid playing old audio, decoding replacements, or competing CPU load.
  if (player.playing) player.stop();
  // REC-8: ask for persistent storage and check there is room, so a long
  // recording is not evicted and does not fill the quota mid-capture.
  requestPersistentStorage().catch(() => {});
  if (storageAvailable()) {
    const est = await storageEstimate();
    if (est && est.quota - est.usage < 100 * 1024 * 1024) {
      const ok = confirm(
        `Only ${Math.round((est.quota - est.usage) / 1048576)} MB of browser storage is free. ` +
          `A long recording may not be recoverable if it runs out. Continue?`
      );
      if (!ok) return;
    }
  }
  setRecordingUi(true);
  $("recordBtn").disabled = true; // guard against double-click while opening the mic
  // Persist chunks as they arrive so a crash mid-recording is recoverable.
  const sessionId = newSessionId();
  state.sessionId = sessionId;
  // The recording is named for when it started, not when it stopped.
  recStartDate = new Date();
  recorder.onChunk = (buffer, index) => {
    appendChunk(sessionId, index, buffer).catch(() => {});
  };
  try {
    await recorder.start((level) => {
      $("meterFill").style.width = Math.min(100, level * 140) + "%";
    }, state.inputDeviceId, $("voiceProc").checked);
    createSession(sessionId, {
      name: recordingName(recStartDate),
      sampleRate: audioContext().sampleRate,
      type: "audio/webm",
      live: true,
      startedAt: Date.now(),
    }).catch(() => {});
    refreshDevices(); // device labels are exposed once we have mic permission
    $("recordBtn").disabled = false;
    $("recordBtn").textContent = "⏸ Pause";
    $("recordBtn").classList.add("recording");
    $("stopRecBtn").disabled = false;
    recTimer = setInterval(() => {
      $("recTime").textContent = fmtSeconds(recorder.elapsedMs / 1000);
    }, 200);
  } catch (e) {
    $("recordBtn").disabled = false;
    setRecordingUi(false);
    alert("Microphone error: " + e.message);
  }
});

$("stopRecBtn").addEventListener("click", async () => {
  clearInterval(recTimer);
  $("recordBtn").textContent = "● Record";
  $("recordBtn").classList.remove("recording", "paused");
  $("stopRecBtn").disabled = true;
  $("meterFill").style.width = "0%";
  const sessionId = state.sessionId;
  recorder.onChunk = null;
  let decoded = null;
  try {
    decoded = await withBusy("Finishing recording…", () => recorder.stop());
  } catch (err) {
    setRecordingUi(false);
    alert("Could not finish the recording: " + err.message);
    return;
  }
  setRecordingUi(false);
  if (decoded) {
    // The live chunks are already the recovery copy; no snapshot needed, and
    // they must not be replaced by one: they are the pristine capture.
    setSource(decoded.pcm, decoded.sampleRate, recordingName(recStartDate), {
      autosave: false,
      sessionId,
      keepChunks: true,
    });
  }
});

// ── Load file ─────────────────────────────────────────────────────────────────
/**
 * The transcript a WAV backup carries, with the WAV to decode instead.
 *
 * Only WAV is checked: re-reading the bytes of every file would double the I/O
 * for the common case of an MP3 or M4A, which cannot carry the chunk anyway.
 */
async function embeddedTranscript(file) {
  if (!/\.wav$/i.test(file.name || "") && file.type !== "audio/wav") return null;
  try {
    const buffer = await file.arrayBuffer();
    const text = readWavTranscript(buffer);
    if (!text) return null;
    // Decode without the chunk, so the browser's decoder sees exactly the bytes
    // an ordinary WAV would have.
    const audio = new Blob([withoutTranscript(buffer)], { type: file.type || "audio/wav" });
    return { parsed: parseTranscriptText(text, `${file.name}.json`), audio };
  } catch (e) {
    return null;
  }
}

/** Decode `file` and make it the source. Returns false when it was refused. */
async function loadAudioFile(file) {
  if (transcribing) return false;
  // REC-10: decoding expands the whole file to 32-bit float (an hour of stereo
  // is about 1.4 GB before the mono mixdown). Warn before a big one, and give a
  // clear message if it fails rather than a bare browser error.
  if (file.size > 100 * 1024 * 1024) {
    const ok = confirm(
      `This file is ${(file.size / 1048576).toFixed(0)} MB. Decoding expands it to 32-bit float in memory ` +
        `(several times the file size), and a very long file can fail. Continue?`
    );
    if (!ok) return false;
  }
  const carried = await embeddedTranscript(file);
  try {
    await withBusy(`Loading ${file.name}…`, async () => {
      const d = await decodeAudioBlob(carried ? carried.audio : file);
      // The file is already on disk: no IndexedDB copy, and not "unsaved".
      setSource(d.pcm, d.sampleRate, file.name, { autosave: false, saved: true });
      if (carried) applyImportedTranscript(carried.parsed, `${file.name} (embedded)`);
    });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    alert(`Could not decode file: ${detail}\n\nVery long files can run out of memory while decoding.`);
    return false;
  }
  return true;
}

/** True when it is an audio or video file the decoder can try. */
function looksLikeAudio(file) {
  if (file.type) return /^(audio|video)\//.test(file.type);
  return /\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac|mp4|mov|aiff?|wma)$/i.test(file.name || "");
}

$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  // Clear the input first, so choosing the same file again still fires a change.
  e.target.value = "";
  if (!file) return;
  if (!confirmIfUnsaved()) return;
  await loadAudioFile(file);
});

// ── Drag and drop a file onto the page ───────────────────────────────────────
// dragenter/dragleave fire for every element the pointer crosses, so the overlay
// is tracked with a depth counter rather than a boolean.
let dragDepth = 0;

function dragHasFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  return !!types && [...types].includes("Files");
}

function setDropOverlay(on) {
  const overlay = $("dropOverlay");
  if (overlay) overlay.hidden = !on;
}

window.addEventListener("dragenter", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  setDropOverlay(true);
});

window.addEventListener("dragover", (e) => {
  if (!dragHasFiles(e)) return;
  // Without this the browser navigates to the dropped file.
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (e) => {
  if (!dragHasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDropOverlay(false);
});

window.addEventListener("drop", async (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDropOverlay(false);
  const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
  if (!files.length) return;
  // A transcript can be dropped on its own, or together with its audio. The two
  // are paired by base name, so dropping both files is enough to reload a
  // session without re-transcribing.
  const transcripts = files.filter((f) => isTranscriptName(f.name));
  const audio = files.find((f) => !isTranscriptName(f.name) && looksLikeAudio(f));
  if (!audio && transcripts.length) {
    if (!state.pcm) {
      $("txStatus").textContent = "Load the audio first, so the transcript can be matched to it";
      return;
    }
    for (const file of transcripts) {
      if (!(await loadTranscriptFile(file))) break;
    }
    return;
  }
  if (!audio) {
    alert(`"${files[0].name}" is not an audio file.`);
    return;
  }
  if (recorder.status() !== "idle") {
    alert("Stop the recording before loading a file.");
    return;
  }
  if (state.pcm) {
    // Anything already loaded or recorded would be replaced, so ask first --
    // whether or not it has been exported.
    const unsaved = state.saved ? "" : " It has not been exported, so save a backup first if you need it.";
    if (!confirm(`"${state.sourceName}" is already loaded. Replace it with "${audio.name}"?${unsaved}`)) {
      return;
    }
  }
  const loaded = await loadAudioFile(audio);
  if (!loaded) return;
  // Prefer a transcript that shares the audio's name; otherwise take the first.
  const base = exportBaseName(audio.name).toLowerCase();
  const match =
    transcripts.find((f) => exportBaseName(f.name).toLowerCase() === base) || transcripts[0];
  if (match) await loadTranscriptFile(match);
});

// ── Waveform tools ──────────────────────────────────────────────────────────
/** Zoom keeping the playhead (or the view centre) fixed (WF-14). */
function zoomBy(factor) {
  const anchor = zoomAnchor(waveform.viewStart, waveform.viewLen, state.cursorSample);
  const view = zoomAround(waveform.viewStart, waveform.viewLen, factor, anchor);
  waveform.viewStart = view.viewStart;
  waveform.viewLen = view.viewLen;
  waveform._clampView();
  waveform.draw();
}
$("zoomIn").addEventListener("click", () => zoomBy(0.7));
$("zoomOut").addEventListener("click", () => zoomBy(1.4));
$("zoomAll").addEventListener("click", () => waveform.resetZoom());
$("addSplit").addEventListener("click", () => {
  if (!state.pcm) return;
  waveform.addSplit(state.cursorSample);
});
$("clearSplits").addEventListener("click", () => waveform.clearSplits());

// ── Keyboard control of the waveform (UI-2) ─────────────────────────────────
// The canvases are focusable; arrows nudge the cursor (Shift = ten steps),
// Home/End jump to the ends, Enter (or [) adds a split at the cursor and ]
// removes the nearest one.
{
  // One step is 1% of the visible range, so it stays useful at every zoom.
  const stepSamples = () => Math.max(1, Math.round((waveform.viewLen || 1) / 100));
  const moveCursor = (sample) => {
    if (!state.pcm) return;
    const next = Math.max(0, Math.min(state.pcm.length, Math.round(sample)));
    state.cursorSample = next;
    waveform.setPlayhead(next);
    $("cursorTime").textContent = fmt(next);
  };
  const onKey = (e) => {
    if (!state.pcm) return;
    const big = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveCursor(state.cursorSample - stepSamples() * big);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      moveCursor(state.cursorSample + stepSamples() * big);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveCursor(0);
    } else if (e.key === "End") {
      e.preventDefault();
      moveCursor(state.pcm.length);
    } else if (e.key === "Enter" || e.key === "[") {
      // Split where the cursor is. `addSplit` rejects positions at the very
      // start/end and duplicates, so pressing Enter twice is harmless.
      e.preventDefault();
      waveform.addSplit(state.cursorSample);
    } else if (e.key === "]") {
      e.preventDefault();
      // Remove the split nearest the cursor, if one is close enough.
      const tolerance = Math.max(stepSamples(), Math.round(state.pcm.length / 200));
      let best = -1;
      let bestDist = Infinity;
      state.splits.forEach((s, i) => {
        const d = Math.abs(s - state.cursorSample);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      if (best >= 0 && bestDist <= tolerance) waveform.removeSplit(best);
    }
  };
  for (const id of ["mainwave", "overview"]) $(id).addEventListener("keydown", onKey);
}

// ── Normalize and clean up ──────────────────────────────────────────────────
// Edits go into a history so Ctrl+Z / Ctrl+Y can walk back and forward. Splits
// store their lists; a clean-up stores the options that produced it, because
// every run is rendered from the pristine source. That is what stops repeated
// clean-ups from stacking, and it makes undo cheap for the common case: undoing
// the only clean-up restores the pristine copy rather than re-rendering.
const HISTORY_MAX = 20;
const history = { undo: [], redo: [] };
let historyBusy = false;

function clearHistory() {
  history.undo.length = 0;
  history.redo.length = 0;
}

function pushHistory(entry) {
  history.undo.push(entry);
  if (history.undo.length > HISTORY_MAX) history.undo.shift();
  history.redo.length = 0;
}

/** Restore a split list from the history and refresh everything showing it. */
function applySplits(splits, message) {
  // Set the baseline first, so the change `setSplits` reports is not recorded
  // as a new edit.
  lastSplits = splits.slice();
  waveform.setSplits(splits);
  $("saveStatus").textContent = message;
}

/**
 * Render the pristine source through the clean-up chain, or hand back a fresh
 * copy of it when `cleanup` is null (no clean-up).
 *
 * `cleanup.scope` decides what "the recording" means for the stages: the whole
 * file at once, or each clip on its own. Per clip, every stage measures and acts
 * on that clip alone -- normalize over clip 1, then clip 2, and so on -- which is
 * what a clip exported on its own needs.
 */
async function renderCleanup(cleanup) {
  const source = pristinePcm();
  if (!source) return null;
  if (!cleanup) return { pcm: source, steps: [] };
  const ranges = cleanupScopeRanges(cleanup.scope, source.length);
  if (ranges.length === 1) {
    // `source` was allocated for this render, so the chain can work on it directly.
    const { pcm, steps } = await cleanUp(
      source,
      state.sampleRate,
      cleanup.options,
      (f) => {
        $("busyText").textContent = `Denoising… ${Math.round(f * 100)}%`;
      },
      { copy: false }
    );
    return { pcm, steps };
  }
  const out = new Float32Array(source.length);
  let steps = [];
  for (const [index, range] of ranges.entries()) {
    const part = source.slice(range.start, range.end);
    const rendered = await cleanUp(
      part,
      state.sampleRate,
      cleanup.options,
      (f) => {
        $("busyText").textContent =
          `Cleaning clip ${index + 1} of ${ranges.length}… ${Math.round(f * 100)}%`;
      },
      { copy: false }
    );
    out.set(rendered.pcm, range.start);
    if (rendered.steps.length) steps = rendered.steps;
  }
  return { pcm: out, steps, perClip: ranges.length };
}

/** Sample ranges a clean-up scope covers, from the current splits. */
function cleanupScopeRanges(scope, length) {
  return cleanupRanges(scope, state.pcm ? buildClips(state.splits, length) : [], length);
}

/** The scope label for a message. */
function cleanupScopeLabel(scope) {
  if (scope === "clips") return "each clip";
  const index = Number.parseInt(scope, 10);
  return Number.isInteger(index) ? `clip ${index + 1}` : "the whole file";
}

/** Apply a clean-up (or none) to the working copy. */
async function applyCleanup(cleanup, message) {
  const rendered = await renderCleanup(cleanup);
  if (!rendered) return;
  state.cleanup = cleanup;
  await swapSource(rendered.pcm, message);
}

/** Step back one edit. Entries leave the stack only after a successful undo. */
async function undoEdit() {
  if (historyBusy) return false;
  const entry = history.undo[history.undo.length - 1];
  if (!entry) return false;
  historyBusy = true;
  try {
    if (entry.kind === "splits") {
      applySplits(entry.before, "Split edit undone");
    } else if (entry.kind === "cleanup") {
      await withBusy("Undoing clean up…", () => applyCleanup(entry.before, "Clean up undone"));
    } else {
      throw new Error(`unknown history entry: ${entry.kind}`);
    }
    history.undo.pop();
    history.redo.push(entry);
    return true;
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    $("saveStatus").textContent = `Undo failed: ${detail}`;
    return false;
  } finally {
    historyBusy = false;
  }
}

/** Step forward one edit. Entries leave the stack only after a successful redo. */
async function redoEdit() {
  if (historyBusy) return false;
  const entry = history.redo[history.redo.length - 1];
  if (!entry) return false;
  historyBusy = true;
  try {
    if (entry.kind === "splits") {
      applySplits(entry.after, "Split edit redone");
    } else if (entry.kind === "cleanup") {
      await withBusy("Redoing clean up…", () => applyCleanup(entry.after, "Clean up redone"));
    } else {
      throw new Error(`unknown history entry: ${entry.kind}`);
    }
    history.redo.pop();
    history.undo.push(entry);
    return true;
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    $("saveStatus").textContent = `Redo failed: ${detail}`;
    return false;
  } finally {
    historyBusy = false;
  }
}

/** Swap in new PCM for the current source and re-settle everything downstream. */
async function swapSource(newPcm, message) {
  const wasPlaying = player.playing;
  state.pcm = newPcm;
  waveform.refreshData(newPcm, state.sampleRate);
  player.setSource(newPcm, state.sampleRate);
  silenceRunCache = null;
  clearRenderCache();
  applySkipSilence();
  markUnsaved();
  persistAutosave();
  if (wasPlaying) {
    await audioContext().resume();
    player.play(state.cursorSample, currentSpeed());
    setPlayButton(true);
  }
  $("saveStatus").textContent = message;
}

// Ctrl+Z / Ctrl+Y (and Cmd on macOS) walk the edit history.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const t = e.target;
  if (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
  const key = (e.key || "").toLowerCase();
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    undoEdit();
  } else if (key === "y" || (key === "z" && e.shiftKey)) {
    e.preventDefault();
    redoEdit();
  }
});

/** The clean-up options as selected in the UI. */
function currentCleanupOptions() {
  return cleanupOptions({
    rumble: $("cleanRumble").checked,
    denoise: $("cleanDenoise").checked,
    level: $("cleanLevel").checked,
    consonant: $("cleanConsonant").checked,
    consonantDb: Number($("cleanConsonantDb").value),
    normalize: $("cleanNormalize").checked,
    normalizeMode: $("normMode").value,
    loudness: $("cleanLoudness").checked,
  });
}

/** Show or hide the clean-up options panel. */
function showCleanOptions(open) {
  const block = $("cleanOptions");
  if (!block) return;
  block.hidden = !open;
  const btn = $("cleanUpBtn");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  // Same visual language as the skip-silence toggle: green while the panel is open.
  btn.setAttribute("aria-pressed", open ? "true" : "false");
  if (open) {
    // Preload RNNoise so the first run does not pause on the download, and
    // disable the toggle with a reason if it cannot load at all.
    import("./audio/denoise.js")
      .then((m) => m.loadDenoise())
      .catch((err) => {
        const box = $("cleanDenoise");
        box.checked = false;
        box.disabled = true;
        const label = box.closest("label");
        if (label) label.title = `Denoise unavailable: ${err.message}`;
      });
  }
}

// The clean-up button opens the options; the panel's own button runs them.
$("cleanUpBtn").addEventListener("click", () => {
  if ($("cleanOptions").hidden) renderCleanupScopes();
  showCleanOptions($("cleanOptions").hidden);
});
$("cleanClose").addEventListener("click", () => showCleanOptions(false));

/**
 * The clean-up scope select: only offered when the recording has splits, and
 * always reset to "full" when there are none, so a stale clip choice cannot
 * silently apply to the wrong range.
 */
function renderCleanupScopes() {
  const sel = $("cleanScope");
  const previous = sel.value;
  sel.innerHTML = "";
  const add = (value, text) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    sel.appendChild(option);
  };
  add("full", "full file");
  const clips = state.pcm ? buildClips(state.splits, state.pcm.length) : [];
  $("cleanScopeLabel").hidden = clips.length === 0;
  if (!clips.length) {
    sel.value = "full";
    return;
  }
  add("clips", "each clip");
  clips.forEach((clip, i) => {
    add(String(i), `clip ${String(i + 1).padStart(2, "0")} (${fmtShort(clip.start)}-${fmtShort(clip.end)})`);
  });
  sel.value = [...sel.options].some((option) => option.value === previous) ? previous : "full";
}

/** The selected clean-up scope. */
function cleanupScopeValue() {
  const sel = $("cleanScope");
  if (!sel || $("cleanScopeLabel").hidden) return "full";
  return sel.value || "full";
}

$("cleanConsonantDb").addEventListener("input", () => {
  $("cleanConsonantVal").textContent = `${$("cleanConsonantDb").value} dB`;
});

$("cleanRun").addEventListener("click", async () => {
  if (!state.pcm || state.pcm.length === 0) {
    $("saveStatus").textContent = "Load or record something first";
    return;
  }
  if (historyBusy) {
    $("saveStatus").textContent = "Finish the current edit first";
    return;
  }
  const opts = currentCleanupOptions();
  if (!cleanupActive(opts)) {
    $("saveStatus").textContent = cleanupSummary([]);
    return;
  }
  const scope = cleanupScopeValue();
  historyBusy = true;
  try {
    await withBusy("Cleaning up…", async () => {
      // Always rendered from the pristine source, so running clean-up again
      // replaces the previous result instead of stacking on top of it.
      const rendered = await renderCleanup({ options: opts, scope });
      if (!rendered) return;
      pushHistory({
        kind: "cleanup",
        before: state.cleanup,
        after: { options: opts, scope },
      });
      state.cleanup = { options: opts, scope };
      const scopeNote = scope === "full" ? "" : ` (${cleanupScopeLabel(scope)})`;
      await swapSource(rendered.pcm, cleanupSummary(rendered.steps) + scopeNote);
      // Done: put the options away.
      showCleanOptions(false);
    });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    $("saveStatus").textContent = `Clean up failed: ${detail}`;
  } finally {
    historyBusy = false;
  }
});

// ── Playback ────────────────────────────────────────────────────────────────
async function togglePlay() {
  if (!state.pcm || transcribing) return;
  if (player.playing) {
    player.stop();
    setPlayButton(false);
    return;
  }
  let from = Math.round(state.cursorSample);
  if (from >= state.pcm.length) from = 0;
  await audioContext().resume();
  player.play(from, currentSpeed());
  setPlayButton(true);
}

$("playBtn").addEventListener("click", togglePlay);

// Spacebar toggles play/stop at the playhead.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  // Holding the key repeats the event; toggling on every repeat made playback
  // stutter on and off (REC-9).
  if (e.repeat) return;
  const t = e.target;
  if (t && ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t.tagName)) return;
  e.preventDefault();
  togglePlay();
});
// Speed dial: drag left/right to change speed, click adds 0.25×, double-click resets.
{
  const dial = $("speed");
  let drag = null;
  dial.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dial.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, start: speedValue, dx: 0, moved: false };
  });
  dial.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.dx = e.clientX - drag.x;
    if (Math.abs(drag.dx) > CLICK_PX) drag.moved = true;
    dial.classList.add("dragging");
    // Mid-drag: no skip-map re-base, so the drag stays smooth.
    setSpeedUI(speedFromDrag(drag.start, drag.dx), false);
  });
  const endDrag = (cancelled) => {
    if (!drag) return;
    const { start, dx } = drag;
    drag = null;
    dial.classList.remove("dragging");
    // A cancelled pointer (touch scroll, capture loss) is not a click, so it
    // must not step the speed -- just re-settle the skip map.
    if (cancelled) {
      if (skipSilence) rebaseSkipSilence();
    } else {
      // A drag under CLICK_PX steps from the speed the drag started at, snapped
      // to a quarter, instead of from a 1-2 px wobble (which gave 1.26x).
      setSpeedUI(speedAfterDrag(start, dx));
    }
    refreshClipDurations();
  };
  dial.addEventListener("pointerup", () => endDrag(false));
  dial.addEventListener("pointercancel", () => endDrag(true));
  dial.addEventListener("dblclick", (e) => {
    e.preventDefault();
    setSpeedUI(1.0);
    refreshClipDurations();
  });
  dial.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      setSpeedUI(stepSpeed(speedValue, 1));
      refreshClipDurations();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      setSpeedUI(stepSpeed(speedValue, -1));
      refreshClipDurations();
    } else if (e.key === "Home" || e.key === "0") {
      e.preventDefault();
      setSpeedUI(1.0);
      refreshClipDurations();
    }
  });
}

$("saveBackup").addEventListener("click", async () => {
  if (!state.pcm) {
    alert("Nothing to save yet.");
    return;
  }
  await withBusy("Saving backup…", async () => {
    try {
      // The transcript rides along in a LIST/INFO chunk, so one file reloads
      // audio and transcript together and needs no re-transcribing. Players and
      // decoders ignore the chunk, so this is still an ordinary WAV.
      const transcript = state.transcript
        ? toTranscriptJson(state.transcript, {
            source: state.sourceName,
            sampleRate: state.sampleRate,
            duration: state.pcm.length / state.sampleRate,
          })
        : "";
      const out = encodeWav(state.pcm, state.sampleRate, { transcript });
      downloadBlob(out, backupName(state.sourceName));
      markSaved();
      $("saveStatus").textContent = transcript ? "saved ✓ (with transcript)" : "saved ✓";
    } catch (err) {
      $("saveStatus").textContent = `Backup failed: ${err.message}`;
    }
  });
});

// While Whisper is running, lock source-changing controls so playback and
// recording cannot compete for CPU or alter the audio under transcription.
function setTranscribeUi(active) {
  $("recordBtn").disabled = active;
  $("fileInput").disabled = active;
  $("loadLabel").classList.toggle("is-disabled", active);
  $("transcribeScope").disabled = active;
  $("modelSel").disabled = active;
  $("cancelTx").style.display = active ? "" : "none";
}

$("cancelTx").addEventListener("click", () => {
  cancelTranscription();
  $("txStatus").textContent = "Cancelling…";
});

/** Shift a clip transcript from clip-relative seconds back to whole-file seconds. */
function offsetTranscriptTimestamps(result, offsetSeconds) {
  if (!result || !Array.isArray(result.chunks) || !Number.isFinite(offsetSeconds) || offsetSeconds === 0) {
    return result;
  }
  return {
    ...result,
    chunks: result.chunks.map((chunk) => {
      if (!Array.isArray(chunk.timestamp)) return chunk;
      const [start, end] = chunk.timestamp;
      return {
        ...chunk,
        timestamp: [
          typeof start === "number" ? start + offsetSeconds : start,
          typeof end === "number" ? end + offsetSeconds : end,
        ],
      };
    }),
  };
}

/**
 * Merge a clip-scope result into the existing transcript instead of replacing
 * it, so the TXT/SRT downloads keep the rest of the file. Only the chunks
 * inside the transcribed range are replaced.
 */
function mergeTranscript(existing, fresh, scope) {
  const start = scope && scope.offsetSeconds;
  if (
    !existing ||
    !existing.chunks ||
    !fresh ||
    !fresh.chunks ||
    !Number.isFinite(start) ||
    start === 0
  ) {
    return fresh;
  }
  const end = start + scope.pcm.length / state.sampleRate;
  const kept = existing.chunks.filter((c) => {
    if (!Array.isArray(c.timestamp)) return true;
    return c.timestamp[0] < start || c.timestamp[0] >= end;
  });
  const chunks = kept.concat(fresh.chunks).sort((a, b) => a.timestamp[0] - b.timestamp[0]);
  return { text: chunks.map((c) => c.text || "").join(""), chunks, timestamped: true };
}

// ── Transcription ─────────────────────────────────────────────────────────────
$("transcribeBtn").addEventListener("click", async () => {
  if (!state.pcm) return;
  // Warn before the first model download: it is 40-250 MB and the web app
  // otherwise gives no hint that anything is fetched (TX-13). The desktop build
  // ships the models, so there is nothing to warn about there.
  if (!modelNoteShown && !isDesktopApp()) {
    modelNoteShown = true;
    const size = MODEL_SIZES[$("modelSel").value] || "tens to hundreds of megabytes";
    const free = await freeStorageText();
    const ok = confirm(
      `The transcription model is about ${size} and is downloaded once from the ` +
        `Hugging Face Hub, then cached by the browser. Nothing is uploaded.` +
        `${free ? ` Free storage: ${free}.` : ""}\n\nContinue?`
    );
    if (!ok) return;
  }
  // Transcribing is CPU-heavy (WASM/Whisper); never overlap it with playback.
  if (player.playing) {
    player.stop();
    setPlayButton(false);
  }
  const btn = $("transcribeBtn");
  const scope = transcriptionScope();
  transcribing = true;
  btn.disabled = true;
  setTranscribeUi(true);
  $("txStatus").textContent = "Working…";
  const txFrac = (frac) => {
    $("txProgress").style.width = Math.max(0, Math.min(100, Math.round(frac * 100))) + "%";
  };
  const duration = scope.pcm.length / state.sampleRate;
  const prefixStatus = (status) =>
    status.startsWith("Transcribing") ? status.replace(/^Transcribing/, `Transcribing ${scope.label}`) : status;
  // Two phases, each running 0-100%: downloading the model, then transcribing.
  // A single bar split between the two read as an instant jump to 60% whenever
  // the model was already cached, and then crawled.
  const loadFiles = new Map();
  let loadFrac = 0;
  const onLoadProgress = (p) => {
    if (!p) return;
    const file = p.file || p.name || "model";
    if (typeof p.loaded === "number" && typeof p.total === "number" && p.total > 0) {
      loadFiles.set(file, { loaded: p.loaded, total: p.total });
    } else if (typeof p.progress === "number") {
      const f = p.progress > 1 ? p.progress / 100 : p.progress;
      loadFiles.set(file, { loaded: Math.min(1, f), total: 1 });
    } else {
      return;
    }
    let loaded = 0;
    let total = 0;
    for (const v of loadFiles.values()) {
      loaded += v.loaded;
      total += v.total;
    }
    if (total <= 0) return;
    loadFrac = Math.max(loadFrac, Math.min(1, loaded / total));
    txFrac(loadFrac);
    $("txStatus").textContent = `Downloading model… ${Math.round(loadFrac * 100)}%`;
  };
  txFrac(0);
  resetTranscriptView();
  try {
    $("txStatus").textContent = "Preparing audio…";
    const input = transcriptionInput(scope);
    const raw = await transcribe(input, state.sampleRate, $("modelSel").value, {
      language: $("langSel").value || undefined,
      onStatus: (s) => {
        // The pipeline announces the switch, so the bar restarts for the new phase.
        if (s.startsWith("Transcribing")) txFrac(0);
        $("txStatus").textContent = prefixStatus(s);
      },
      onProgress: onLoadProgress,
      onSegment: (segment) => {
        // `end` is the end of the completed sequential input window, so this is
        // real file-fraction progress rather than an estimate.
        const end = segment && typeof segment.end === "number" ? segment.end : 0;
        const frac = Math.min(1, end / duration);
        const pct = Math.min(100, Math.round(frac * 100));
        txFrac(frac);
        if (segment && typeof segment.end === "number") {
          $("txStatus").textContent = `Transcribing ${scope.label}… ${pct}% of ${scope.noun}`;
        }
        if (segment && segment.chunks && segment.chunks.length) {
          appendTranscriptChunks(segment.chunks, scope.offsetSeconds);
        }
      },
    });
    const fresh = offsetTranscriptTimestamps(raw, scope.offsetSeconds);
    state.transcript = mergeTranscript(state.transcript, fresh, scope);
    // This transcript is from this session now, whatever was imported before.
    setImportedTranscript("");
    renderTranscript(state.transcript);
    updateSplitLabels();
    $("txActions").style.display = "flex";
    if (raw.stalled) {
      const pct = Math.round(100 * Math.min(1, (raw.completedSeconds || 0) / duration));
      $("txStatus").textContent = `Partial transcript (stopped at ${pct}% — inference stalled). Re-run to finish.`;
    } else {
      $("txStatus").textContent = state.transcript.timestamped
        ? "Done"
        : "Done (no timestamps — model lacked cross-attention data)";
    }
  } catch (e) {
    $("txStatus").textContent =
      e && e.cancelled ? "Cancelled" : "Failed: " + e.message;
  } finally {
    transcribing = false;
    btn.disabled = false;
    setTranscribeUi(false);
    setTimeout(() => ($("txProgress").style.width = "0%"), 800);
  }
});

// Target text length for displayed transcript lines. Words accumulate until the
// visible line reaches roughly this many characters; punctuation still ends a
// line immediately.
const TARGET_TRANSCRIPT_CHARS = 84;

function renderTranscriptScopes() {
  const sel = $("transcribeScope");
  const previous = sel.value;
  sel.innerHTML = "";
  const full = document.createElement("option");
  full.value = "full";
  full.textContent = "Full file";
  sel.appendChild(full);
  if (state.pcm) {
    buildClips(state.splits, state.pcm.length).forEach((clip, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = `Clip ${String(i + 1).padStart(2, "0")} (${fmtShort(clip.start)}–${fmtShort(clip.end)})`;
      sel.appendChild(option);
    });
  }
  sel.value = [...sel.options].some((option) => option.value === previous) ? previous : "full";
}

function transcriptionScope() {
  const selection = $("transcribeScope").value;
  const clips = state.pcm ? buildClips(state.splits, state.pcm.length) : [];
  const index = Number.parseInt(selection, 10);
  const clip = Number.isInteger(index) ? clips[index] : null;
  if (!clip || clip.end <= clip.start) {
    $("transcribeScope").value = "full"; 
    return {
      label: "file",
      noun: "file",
      offsetSeconds: 0,
      pcm: state.pcm,
    };
  }
  return {
    label: `clip ${String(index + 1).padStart(2, "0")}`,
    noun: "clip",
    offsetSeconds: clip.start / state.sampleRate,
    pcm: state.pcm.subarray(clip.start, clip.end),
    startSample: clip.start,
  };
}

/**
 * The audio handed to Whisper.
 *
 * The pristine source by default: denoising and the consonant shelf are tuned
 * for listening, and can remove detail the model uses, while Whisper is trained
 * on noisy audio and prefers it unshaped. A rumble high-pass and the leveler
 * stay, because a consistent level genuinely helps the model and a gain cannot
 * move a timestamp. The cleaned render is available behind the checkbox.
 */
function transcriptionInput(scope) {
  const out = new Float32Array(scope.pcm.length);
  const useCleaned = $("txCleaned").checked && state.cleanup;
  if (!state.original || useCleaned) {
    out.set(scope.pcm);
  } else {
    const start = scope.startSample || 0;
    for (let i = 0; i < out.length; i++) out[i] = state.original[start + i] / 32767;
  }
  // In place: the stages mutate this buffer only.
  highpassFilter(out, state.sampleRate, RUMBLE_CUTOFF_HZ);
  levelVoices(out, state.sampleRate, LEVEL_MAX_BOOST_DB, LEVEL_WINDOW_S);
  return out;
}
// ── Transcript view ─────────────────────────────────────────────────────────
// Follow-along state: the rendered lines, their start times for the lookup, the
// highlighted line, and whether following is on.
let transcriptLines = [];
let transcriptStarts = [];
let transcriptActive = -1;
let followAudio = true;

/** Group word chunks into transcript lines, one per ~84 characters or sentence. */
function groupWords(words, offsetSeconds) {
  const lines = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const start = group[0].timestamp[0] + offsetSeconds;
    const last = group[group.length - 1];
    const end = (last.timestamp[1] ?? last.timestamp[0]) + offsetSeconds;
    const text = group.map((w) => w.text).join("").trim();
    if (text) lines.push({ start, end, text });
    group = [];
  };
  for (const w of words) {
    group.push(w);
    const line = group.map((word) => word.text).join("").trim();
    if (line.length >= TARGET_TRANSCRIPT_CHARS || /[.!?]\s*$/.test(w.text)) flush();
  }
  flush();
  return lines;
}

/** One transcript line, wired to seek on click. */
function transcriptLineEl(item) {
  const div = document.createElement("div");
  div.className = item.missing ? "seg missing" : "seg";
  div.dataset.start = String(item.start);
  div.title = item.missing
    ? "Speech here produced no words — possibly unintelligible"
    : "Double-click to play from here";
  div.innerHTML = `<span class="t">${fmt(item.start * state.sampleRate)}</span><span class="x"></span>`;
  div.querySelector(".x").textContent = item.missing ? "**" : item.text;
  const seek = (start) => {
    const sample = Math.round(start * state.sampleRate);
    state.cursorSample = sample;
    waveform.setPlayhead(sample);
    $("cursorTime").textContent = fmt(sample);
  };
  div.addEventListener("click", () => {
    seek(item.start);
    if (player.playing) player.play(state.cursorSample, currentSpeed());
  });
  div.addEventListener("dblclick", async () => {
    // Double-click must not start playback while Whisper is running (TX-12).
    if (!state.pcm || transcribing) return;
    seek(item.start);
    await audioContext().resume();
    player.play(state.cursorSample, currentSpeed());
    setPlayButton(true);
  });
  return div;
}

function addTranscriptLine(item) {
  const el = $("transcript");
  const div = transcriptLineEl(item);
  el.appendChild(div);
  transcriptLines.push({ el: div, start: item.start, end: item.end });
  transcriptStarts.push(item.start);
}

function resetTranscriptView() {
  $("transcript").innerHTML = "";
  transcriptLines = [];
  transcriptStarts = [];
  transcriptActive = -1;
}

function clearTranscriptHighlight() {
  if (transcriptActive >= 0 && transcriptLines[transcriptActive]) {
    transcriptLines[transcriptActive].el.classList.remove("active");
  }
  transcriptActive = -1;
}

/** Scroll so `index` sits four lines down, leaving room for what is coming. */
function scrollTranscriptToLine(index, behaviour = "smooth") {
  const line = transcriptLines[index];
  const box = $("transcript");
  if (!line || !box) return;
  const lineHeight = line.el.offsetHeight || 22;
  box.scrollTo({
    top: followScrollTop(line.el.offsetTop - box.offsetTop, lineHeight, 4),
    behavior: behaviour,
  });
}

/** Highlight the line being played, four lines from the top (follow audio). */
function followTranscriptTo(seconds) {
  if (!followAudio || !transcriptLines.length) return;
  const index = findLineIndex(transcriptStarts, seconds);
  if (index === transcriptActive) return;
  clearTranscriptHighlight();
  if (index < 0) return;
  transcriptActive = index;
  transcriptLines[index].el.classList.add("active");
  scrollTranscriptToLine(index);
}

function setFollowAudio(on) {
  followAudio = on;
  const btn = $("followTx");
  if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
  if (!on) clearTranscriptHighlight();
}

/** Append the chunks a transcription window just produced, as it goes. */
function appendTranscriptChunks(chunks, offsetSeconds) {
  const words = (chunks || []).filter((c) => Array.isArray(c.timestamp));
  if (!words.length) return;
  for (const item of groupWords(words, offsetSeconds)) addTranscriptLine(item);
  // Keep the newest line four lines down, the same as during playback.
  const last = transcriptLines.length - 1;
  if (last < 0) return;
  clearTranscriptHighlight();
  transcriptActive = last;
  transcriptLines[last].el.classList.add("active");
  scrollTranscriptToLine(last);
}

function renderTranscript(result) {
  resetTranscriptView();
  const words = (result.chunks || []).filter((c) => c.timestamp);
  if (words.length === 0) {
    $("transcript").textContent = result.text || "(empty)";
    updateTranscriptActions();
    return;
  }
  const items = groupWords(words, 0);
  // Mark speech that produced no words at all with ** (see missingWordMarkers).
  const from = items.length ? items[0].start : 0;
  const to = items.length ? items[items.length - 1].end : 0;
  if (state.pcm && to > from) {
    const zones = silenceZones(state.pcm, state.sampleRate, 0.3).map((s) => s / state.sampleRate);
    const regions = speechRegions(zones, state.pcm.length / state.sampleRate);
    const spans = words.map((w) => [w.timestamp[0], w.timestamp[1] ?? w.timestamp[0]]);
    for (const t of missingWordMarkers(regions, spans, from, to)) {
      items.push({ start: t, end: t, text: "**", missing: true });
    }
    items.sort((a, b) => a.start - b.start);
  }
  for (const item of items) addTranscriptLine(item);
  updateTranscriptActions();
}

/** Enable the transcript downloads that have something to write (TX-11). */
function updateTranscriptActions() {
  const t = state.transcript;
  const hasWords = !!(t && t.chunks && t.chunks.length);
  const set = (id, on) => {
    const el = $(id);
    if (el) el.disabled = !on;
  };
  set("downloadTx", !!t);
  set("downloadSrt", hasWords);
  set("downloadVtt", hasWords);
  set("downloadJson", !!t);
}

/**
 * Name a transcript export after the source, so `<base>.srt` sits beside
 * `<base>.mp3`. Timestamps always refer to the unbaked source, so the speed and
 * silence suffixes an audio export may carry are deliberately not applied: a
 * transcript labelled `-2.00x` would claim timings it does not have.
 */
function transcriptFilename(kind) {
  return transcriptName(state.sourceName, kind);
}

function transcriptDownload(kind) {
  const t = state.transcript;
  if (!t) return;
  const body =
    kind === "srt"
      ? toSrt(t.chunks)
      : kind === "vtt"
        ? toVtt(t.chunks)
        : kind === "json"
          ? toTranscriptJson(t, {
              source: state.sourceName,
              sampleRate: state.sampleRate,
              duration: state.pcm ? state.pcm.length / state.sampleRate : 0,
            })
          : toTxt(t);
  if (!body) {
    $("txStatus").textContent = "Nothing timestamped to export";
    return;
  }
  const type = kind === "vtt" ? "text/vtt" : kind === "json" ? "application/json" : "text/plain";
  downloadBlob(new Blob([body], { type }), transcriptFilename(kind));
}

$("downloadTx").addEventListener("click", () => transcriptDownload("txt"));
$("downloadSrt").addEventListener("click", () => transcriptDownload("srt"));
$("downloadVtt").addEventListener("click", () => transcriptDownload("vtt"));
$("downloadJson").addEventListener("click", () => transcriptDownload("json"));

/** Show, or clear, the marker for a transcript that was loaded from a file. */
function setImportedTranscript(name) {
  const badge = $("txImported");
  if (!badge) return;
  badge.hidden = !name;
  badge.textContent = name ? `imported: ${name}` : "";
  badge.title = name ? `Loaded from ${name}, not transcribed in this session` : "";
}

/**
 * Adopt a transcript parsed from a file. Warns when it does not look like it
 * belongs to the loaded audio: the wrong sidecar is easy to pick.
 */
function applyImportedTranscript(parsed, name) {
  const duration = state.pcm ? state.pcm.length / state.sampleRate : 0;
  const stated = parsed.meta && parsed.meta.duration;
  const lastCue = parsed.chunks && parsed.chunks.length
    ? parsed.chunks[parsed.chunks.length - 1].timestamp[1]
    : null;
  const claimed = Number.isFinite(stated) ? stated : lastCue;
  if (claimed && duration && Math.abs(claimed - duration) > Math.max(2, duration * 0.02)) {
    const ok = confirm(
      `"${name}" runs to ${claimed.toFixed(1)}s but the loaded audio is ${duration.toFixed(1)}s. ` +
        `Load it anyway?`
    );
    if (!ok) return false;
  }
  state.transcript = { text: parsed.text, chunks: parsed.chunks, timestamped: parsed.timestamped };
  renderTranscript(state.transcript);
  setImportedTranscript(name);
  $("txActions").style.display = "flex";
  $("txStatus").textContent = parsed.timestamped
    ? `Loaded ${parsed.chunks.length} cue${parsed.chunks.length === 1 ? "" : "s"} from ${name}`
    : `Loaded text from ${name} (no timings)`;
  return true;
}

/** Read and adopt a transcript file. */
async function loadTranscriptFile(file) {
  try {
    const parsed = parseTranscriptText(await file.text(), file.name);
    return applyImportedTranscript(parsed, file.name);
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    alert(`Could not read "${file.name}" as a transcript: ${detail}`);
    return false;
  }
}

$("txInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!state.pcm) {
    $("txStatus").textContent = "Load the audio first, so the transcript can be matched to it";
    return;
  }
  await loadTranscriptFile(file);
});

$("followTx").addEventListener("click", () =>
  setFollowAudio($("followTx").getAttribute("aria-pressed") !== "true")
);

// ── Export ────────────────────────────────────────────────────────────────────
function currentClipNames() {
  return Array.from(document.querySelectorAll("#clipList .clip input")).map((el) => el.value);
}

function refreshClipDurations() {
  if (state.pcm && state.splits.length > 0) renderClipList();
}

function renderClipList() {
  const list = $("clipList");
  const names = currentClipNames();
  list.innerHTML = "";
  if (!state.pcm || state.splits.length === 0) {
    // Nothing to clip: shade the clips export rather than explaining why.
    $("exportClips").disabled = true;
    $("exportClips").title = "Add a split in step 2 first";
    return;
  }
  // Display baked clip lengths without rendering audio: one position map can map
  // every boundary, including a non-uniform class-aware plan or skipped silence.
  let mapper = null;
  try {
    mapper = makeExportMap();
  } catch (err) {
    // Building the map used to throw straight through onSplitsChange, which
    // broke adding splits entirely (EX-7). Show why and disable the exports.
    list.innerHTML = `<span class="muted">Clip lengths unavailable — ${err.message}. Uncheck speed-baked to export.</span>`;
    for (const id of ["exportAll", "exportClips"]) {
      $(id).disabled = true;
      $(id).title = `Unavailable: ${err.message}`;
    }
    return;
  }
  for (const id of ["exportAll", "exportClips"]) {
    $(id).disabled = false;
    $(id).title = "";
  }
  try {
    const clips = buildClips(state.splits, state.pcm.length);
    clips.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "clip";
      const start = mapper ? mapper.mapSample(c.start) : c.start;
      const end = mapper ? mapper.mapSample(c.end) : c.end;
      const dur = Math.max(0, end - start) / state.sampleRate;
      row.innerHTML = `<span class="n">${i + 1}</span>
        <input type="text">
        <span class="d">${dur.toFixed(2)}s</span>
        <button title="Export this clip">⬇</button>`;
      const nameField = row.querySelector("input");
      nameField.value =
        names[i] != null && names[i] !== ""
          ? names[i]
          : clipName(state.sourceName, i, c.start, state.sampleRate);
    row.querySelector("button").addEventListener("click", async () => {
        const name = nameField.value || clipName(state.sourceName, i, c.start, state.sampleRate);
        const fmtSel = $("exportFormat").value;
        await withBusy(`Exporting ${name}…`, async () => {
          try {
            const range = mapClipForExport(c);
            if (range.end > range.start) {
              exportSlice(range.pcm, state.sampleRate, range.start, range.end, fmtSel, clipExportName(name, fmtSel));
              $("exportStatus").textContent = `Exported ${name}.${fmtSel}`;
            } else {
              $("exportStatus").textContent = "Clip is empty after baking — nothing to export";
            }
          } catch (err) {
            $("exportStatus").textContent = `Export failed: ${err.message}`;
          }
        });
      });
      list.appendChild(row);
    });
  } finally {
    if (mapper) mapper.dispose();
  }
}

/** True when the export path uses the DSP render rather than source PCM. */
function useBakedExport() {
  return $("speedBaked").checked && Math.abs(speedValue - 1.0) >= 1e-9;
}

/** True when the export should drop long silences (requires speed-baked). */
function useSkipExport() {
  return skipSilence && $("speedBaked").checked;
}

/** Position map for the active export mode, or null when no render is used. */
function makeExportMap() {
  if (!state.pcm) return null;
  if (useSkipExport()) {
    return makeSkipBakedMap(
      state.pcm,
      state.sampleRate,
      speedValue,
      $("classAware").checked,
      SKIP_MIN_S,
      skipKeepSourceSeconds(speedValue)
    );
  }
  if (useBakedExport()) {
    return makeBakedMap(state.pcm, state.sampleRate, speedValue, $("classAware").checked);
  }
  return null;
}

// The baked render is expensive, so cache it per export setting. Clip exports
// then slice an already-rendered buffer instead of re-baking the whole file per
// clip (which is slow and can outlast the click's user activation).
let renderCache = { key: "", src: null };

function renderKey() {
  return [
    state.pcm ? state.pcm.length : 0,
    speedValue.toFixed(3),
    $("classAware").checked ? 1 : 0,
    skipSilence ? 1 : 0,
    $("speedBaked").checked ? 1 : 0,
  ].join("|");
}

function clearRenderCache() {
  renderCache = { key: "", src: null };
}

/** Render source PCM for export, using the same DSP bake as playback exports. */
function exportSource() {
  if (!state.pcm) return null;
  const key = renderKey();
  if (renderCache.key === key && renderCache.src) return renderCache.src;

  let src;
  if (useSkipExport()) {
    src = {
      pcm: timeStretchSkipSilence(
        state.pcm,
        state.sampleRate,
        speedValue,
        $("classAware").checked,
        SKIP_MIN_S,
        skipKeepSourceSeconds(speedValue)
      ),
      sampleRate: state.sampleRate,
    };
  } else if (!useBakedExport()) {
    src = { pcm: state.pcm, sampleRate: state.sampleRate };
  } else {
    src = {
      pcm: player.bake(speedValue, $("classAware").checked),
      sampleRate: state.sampleRate,
    };
  }
  // S-13: a stretched render can overshoot, so limit it before the encoder,
  // where a clamp would otherwise distort the peaks. A plain export is limited
  // too, but only when it actually runs over the ceiling -- the clean-up chain
  // already limits what it raised, and re-limiting would touch the source.
  const ceiling = Math.pow(10, LIMIT_CEILING_DB / 20);
  if (useBakedExport() || useSkipExport()) {
    src = { pcm: softLimiter(src.pcm, src.sampleRate, LIMIT_CEILING_DB), sampleRate: src.sampleRate };
  } else if (peakOf(src.pcm) > ceiling) {
    src = {
      pcm: softLimiter(Float32Array.from(src.pcm), src.sampleRate, LIMIT_CEILING_DB),
      sampleRate: src.sampleRate,
    };
  }
  renderCache = { key, src };
  return src;
}

/**
 * Map one source-domain clip into baked-render positions. The mapping uses the
 * class-aware time map when selected, rather than assuming a uniform ratio.
 */
function mapClipForExport(clip) {
  const mapper = makeExportMap();
  if (!mapper) {
    return { pcm: state.pcm, start: clip.start, end: clip.end };
  }
  try {
    const src = exportSource();
    return {
      pcm: src.pcm,
      start: mapper.mapSample(clip.start),
      end: mapper.mapSample(clip.end),
    };
  } finally {
    mapper.dispose();
  }
}

// Keep displayed clip lengths in output time when baked-export inputs change.
$("speedBaked").addEventListener("change", refreshClipDurations);
$("classAware").addEventListener("change", refreshClipDurations);
$("skipSilence").addEventListener("click", () => setSkipSilence(!skipSilence));

$("exportAll").addEventListener("click", async () => {
  if (!state.pcm) return;
  const fmtSel = $("exportFormat").value;
  await withBusy("Exporting…", async () => {
    try {
      const src = exportSource();
      if (src.pcm.length === 0) {
        $("exportStatus").textContent = "Nothing to export — no speech found";
        return;
      }
      const baked = useBakedExport();
      const skip = useSkipExport();
      // Keep the speed in the name even when silence is skipped too (EX-5).
      const name = wholeExportName(state.sourceName, { baked, skip, speed: speedValue, format: fmtSel });
      // Async encode: MP3 of a long file used to freeze the page for minutes.
      const blob = await encodeAsync(src.pcm, src.sampleRate, fmtSel, (f) => {
        $("exportStatus").textContent = `Encoding ${Math.round(f * 100)}%…`;
      });
      downloadBlob(blob, name);
      // Only an unprocessed WAV actually preserves the recording; a baked,
      // silence-stripped or MP3 export does not.
      if (!baked && !skip && fmtSel === "wav") markSaved();
      $("exportStatus").textContent = skip
        ? `Exported whole file, silence removed, baked at ${speedValue.toFixed(2)}×`
        : baked
          ? `Exported whole file, speed-baked at ${speedValue.toFixed(2)}×`
          : "Exported whole file";
    } catch (err) {
      $("exportStatus").textContent = `Export failed: ${err.message}`;
    }
  });
});

$("exportClips").addEventListener("click", async () => {
  if (!state.pcm) return;
  const fmtSel = $("exportFormat").value;
  await withBusy("Exporting clips…", async () => {
    const names = currentClipNames();
    let ranges;
    let mapper = null;
    try {
      // One render and one position map for every clip, not one of each per
      // clip, and honour the per-row name fields.
      const src = exportSource();
      mapper = makeExportMap();
      const clips = buildClips(state.splits, state.pcm.length);
      ranges = clips.map((clip, i) => ({
        name: (names[i] || clipName(state.sourceName, i, clip.start, state.sampleRate)).trim(),
        pcm: src.pcm,
        start: mapper ? mapper.mapSample(clip.start) : clip.start,
        end: mapper ? mapper.mapSample(clip.end) : clip.end,
      }));
    } catch (err) {
      $("exportStatus").textContent = `Export failed: ${err.message}`;
      return;
    } finally {
      if (mapper) mapper.dispose();
    }
    // Download inside this click's user activation. Staggering with setTimeout
    // loses the activation and the browser then blocks the downloads.
    let count = 0;
    ranges.forEach((range) => {
      try {
        if (range.end > range.start) {
          exportSlice(
            range.pcm,
            state.sampleRate,
            range.start,
            range.end,
            fmtSel,
            clipExportName(range.name, fmtSel)
          );
          count++;
        }
      } catch (err) {
        $("exportStatus").textContent = `Export failed: ${err.message}`;
      }
    });
    $("exportStatus").textContent = `Exported ${count} clip${count === 1 ? "" : "s"}`;
  });
});

// ── Transcript focus ────────────────────────────────────────────────────────
// The transcript takes the page, while the waveform and transport stay so
// playback and follow-along still work. Reset on load rather than remembered.
function setTranscriptFocus(on) {
  document.body.classList.toggle("tx-focus", on);
  const btn = $("txFocus");
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "exit focus" : "focus";
  }
  // Re-anchor once the new geometry has been laid out.
  requestAnimationFrame(() => {
    if (followAudio && transcriptActive >= 0) scrollTranscriptToLine(transcriptActive, "auto");
  });
}

$("txFocus").addEventListener("click", () =>
  setTranscriptFocus(!document.body.classList.contains("tx-focus"))
);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.body.classList.contains("tx-focus")) {
    e.preventDefault();
    setTranscriptFocus(false);
  }
});

// Dragging the transcript's resize handle changes its height; keep the followed
// line where the reader expects it.
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => {
    if (followAudio && transcriptActive >= 0) scrollTranscriptToLine(transcriptActive, "auto");
  }).observe($("transcript"));
}

// ── Boot ────────────────────────────────────────────────────────────────────
window.addEventListener("beforeunload", (e) => {
  closeStorage();
  // A recording in progress is only partly persisted, and closing mid-capture
  // would lose the live stream entirely.
  const recording = typeof recorder !== "undefined" && recorder.status() !== "idle";
  if (recording || (state.pcm && !state.saved)) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ── Recovery ────────────────────────────────────────────────────────────────
// Everything autosaved on this device is listed with its name, so the work is
// identifiable before it is loaded or thrown away. Each tab writes under its own
// session id, so two tabs never touch one record; recovering a session moves it
// to this tab's id, which is what makes that true after a recovery too.
const RECOVER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let recoverSessions = [];

/** A session's duration: recorded, or approximated for an interrupted capture. */
function recoverSeconds(meta) {
  const seconds = Number(meta.seconds);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const started = Number(meta.startedAt);
  const saved = Number(meta.savedAt);
  if (meta.live && Number.isFinite(started) && Number.isFinite(saved) && saved > started) {
    return (saved - started) / 1000;
  }
  return 0;
}

function recoverLabel(meta) {
  const name = String(meta.name || "").trim();
  if (name) return name;
  return meta.live ? "recording (unnamed)" : "untitled audio";
}

function closeRecoverPanel() {
  $("recoverPanel").hidden = true;
}

function renderRecoverPanel() {
  const list = $("recoverList");
  list.innerHTML = "";
  if (!recoverSessions.length) {
    closeRecoverPanel();
    return;
  }
  for (const meta of recoverSessions) {
    const li = document.createElement("li");
    li.className = "recover-item";

    const info = document.createElement("div");
    info.className = "recover-meta";
    const name = document.createElement("span");
    name.className = "recover-name";
    name.textContent = recoverLabel(meta);
    name.title = recoverLabel(meta);
    const detail = document.createElement("span");
    detail.className = "muted";
    const bits = [`saved ${describeAge(meta.savedAt)}`];
    const seconds = recoverSeconds(meta);
    if (seconds > 0) bits.push(describeSeconds(seconds));
    if (meta.live) bits.push("interrupted recording");
    detail.textContent = bits.join(" · ");
    info.append(name, detail);

    const load = document.createElement("button");
    load.className = "btn sm primary";
    load.textContent = "Load";
    load.onclick = () => recoverSession(meta);

    const discard = document.createElement("button");
    discard.className = "btn sm";
    discard.textContent = "Discard";
    discard.onclick = async () => {
      load.disabled = discard.disabled = true;
      try {
        await deleteSession(meta.id);
      } catch (e) {
        /* removing a record that is already gone is not a failure */
      }
      recoverSessions = recoverSessions.filter((m) => m.id !== meta.id);
      renderRecoverPanel();
    };

    li.append(info, load, discard);
    list.appendChild(li);
  }
  $("recoverPanel").hidden = false;
}

/** Load a recoverable session into this tab, under a fresh id. */
async function recoverSession(meta) {
  closeRecoverPanel();
  try {
    await withBusy("Recovering session…", async () => {
      const loaded = await loadSession(meta.id);
      if (!loaded) {
        throw new Error("it is no longer available, which usually means another tab has it");
      }
      const buffer = await loaded.blob.arrayBuffer();
      const id = newSessionId();
      // Store the copy under this tab's id *before* dropping the original: a
      // crash mid-recovery cannot lose it, and a second tab recovering the same
      // session simply makes its own copy instead of interleaving writes.
      await replaceSnapshot(
        id,
        { ...loaded.meta, id, live: false, seconds: recoverSeconds(loaded.meta) },
        buffer
      );
      await deleteSession(meta.id).catch(() => {});
      const d = await decodeAudioBlob(new Blob([buffer], { type: loaded.meta.type || "audio/webm" }));
      setSource(d.pcm, d.sampleRate, loaded.meta.name || "Recovered recording", {
        autosave: false,
        sessionId: id,
        keepChunks: loaded.meta.type === "audio/webm",
      });
      autosaveSnapshotDone = true;
      // The stored audio is the pristine source, so a clean-up that was applied
      // when it was saved is reproduced rather than stored. Older sessions
      // stored bare options; those mean the whole file.
      const stored = loaded.meta.cleanup;
      const cleanup = stored
        ? stored.options
          ? stored
          : { options: stored, scope: "full" }
        : null;
      if (cleanup) {
        const rendered = await renderCleanup(cleanup);
        if (rendered) {
          state.cleanup = cleanup;
          await swapSource(rendered.pcm, "Recovered with clean up");
        }
      }
    });
  } catch (err) {
    alert("Could not recover the session: " + (err && err.message ? err.message : String(err)));
    // Put the list back, so another session can still be chosen.
    renderRecoverPanel();
  }
}

$("recoverKeep").addEventListener("click", closeRecoverPanel);
$("recoverDiscardAll").addEventListener("click", async () => {
  const count = recoverSessions.length;
  if (!count) return;
  if (!confirm(`Discard all ${count} saved session${count === 1 ? "" : "s"}? This cannot be undone.`)) {
    return;
  }
  for (const meta of recoverSessions) {
    await deleteSession(meta.id).catch(() => {});
  }
  recoverSessions = [];
  renderRecoverPanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("recoverPanel").hidden) {
    e.preventDefault();
    closeRecoverPanel();
  }
});

(async () => {
  enableCards(false);
  try {
    await initDsp();
    $("dspStatus").textContent = `DSP: WASM v${getDspVersion()} ready`;
  } catch (e) {
    $("dspStatus").textContent = "DSP: failed to load — " + e.message;
  }
  renderClipList();
  $("cursorTime").textContent = "—";
  refreshDevices();

  // Offer everything autosaved on this device instead of silently dropping it.
  // Sessions older than a week are swept first, so the list stays short.
  try {
    if (storageAvailable()) {
      await pruneSessions(RECOVER_MAX_AGE_MS).catch(() => 0);
      if (!state.pcm) {
        // A record with no chunks is a session that never captured anything.
        const sessions = (await listSessions()).filter((m) => m.chunks !== 0);
        recoverSessions = sessions;
        if (sessions.length) renderRecoverPanel();
      }
    }
  } catch (e) {
    /* storage unreadable; ignore */
  }
})();
