// Application wiring: record/load → waveform → playback → transcribe → export.
import { initDsp, getDspVersion, makeBakedMap, makeSkipBakedMap, timeStretchSkipSilence, silenceZones } from "./core/dsp.js";
import { decodeAudioBlob, audioContext } from "./audio/decode.js";
import { Recorder } from "./audio/record.js";
import { encode, encodeWav } from "./audio/encode.js";
import { appendChunk, createSession, deleteSession, listSessions, loadSession, replaceSnapshot, storageAvailable } from "./storage.js";
import { WaveformView } from "./ui/waveform.js";
import { Player } from "./playback.js";
import { transcribe, toSrt } from "./transcribe/whisper.js";
import { buildClips, exportSlice, downloadBlob } from "./export/clips.js";

const $ = (id) => document.getElementById(id);

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
};

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
  },
  onViewChange: (label) => {
    $("zoomLabel").textContent = label;
  },
});

const player = new Player({
  onPosition: (sample) => {
    state.cursorSample = sample;
    waveform.setPlayhead(sample);
    $("cursorTime").textContent = fmt(sample);
  },
  onEnd: () => {
    $("playBtn").disabled = false;
    $("stopPlayBtn").disabled = true;
  },
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

/** Name a new recording as `MMDDYYYY HHMM` (24-hour) from the current time. */
function recordingName(date = new Date()) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${mm}${dd}${yyyy} ${hh}${min}`;
}

const SPEED_MIN = 1.0;
const SPEED_MAX = 4.0;
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

function currentSpeed() {
  return speedValue;
}

/** Source seconds of silence kept on each side of a gap at `speed`. */
function skipKeepSourceSeconds(speed = speedValue) {
  return Math.max(SKIP_KEEP_S, SKIP_KEEP_FLOOR_S * speed);
}

function setSpeedUI(s, rebase = true) {
  speedValue = Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, s)) * 100) / 100;
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

/** Snapshot the current clip into IndexedDB so it survives a page close. */
async function persistAutosave() {
  if (!state.pcm || !storageAvailable()) return;
  if (!state.sessionId) state.sessionId = newSessionId();
  try {
    const blob = encodeWav(state.pcm, state.sampleRate);
    const buffer = await blob.arrayBuffer();
    await replaceSnapshot(
      state.sessionId,
      {
        name: state.sourceName || "recording",
        sampleRate: state.sampleRate,
        type: "audio/wav",
      },
      buffer
    );
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
    $(id).setAttribute("aria-disabled", enabled ? "false" : "true");
  }
}

function setSource(pcm, sampleRate, label, { autosave = true, saved = false, sessionId = null } = {}) {
  state.pcm = pcm;
  state.sampleRate = sampleRate;
  state.transcript = null;
  state.splits = [];
  state.sourceName = label || "recording";
  state.sessionId = sessionId || newSessionId();
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
  $("cursorTime").textContent = "—";
  $("playBtn").disabled = false;
  $("stopPlayBtn").disabled = true;
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

$("refreshDevices").addEventListener("click", async () => {
  if (!(await requestDeviceAccess())) {
    alert("Microphone permission is needed before the browser will list audio devices.");
    return;
  }
  await refreshDevices();
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

function transcriptWordsForClip(startSample) {
  const list = sortedTranscriptChunks();
  if (!list.length || !state.pcm) return "";
  const startSeconds = startSample / state.sampleRate;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].timestamp[0] < startSeconds) lo = mid + 1;
    else hi = mid;
  }
  const text = list
    .slice(lo, lo + 4)
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
  const labels = state.splits.map((s, i) => {
    const time = fmtShort(s);
    const num = String(i + 1).padStart(2, "0");
    return `${time}-${num}${transcriptWordsForClip(s)}`;
  });
  waveform.setSplitLabels(labels);
}

// ── Recording ────────────────────────────────────────────────────────────────
function setRecordingUi(active) {
  $("playBtn").disabled = active ? true : !state.pcm;
  $("stopPlayBtn").disabled = true;
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
  setRecordingUi(true);
  $("recordBtn").disabled = true; // guard against double-click while opening the mic
  // Persist chunks as they arrive so a crash mid-recording is recoverable.
  const sessionId = newSessionId();
  state.sessionId = sessionId;
  recorder.onChunk = (buffer, index) => {
    appendChunk(sessionId, index, buffer).catch(() => {});
  };
  try {
    await recorder.start((level) => {
      $("meterFill").style.width = Math.min(100, level * 140) + "%";
    }, state.inputDeviceId, $("voiceProc").checked);
    createSession(sessionId, {
      name: recordingName(),
      sampleRate: audioContext().sampleRate,
      type: "audio/webm",
      live: true,
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
    // The live chunks are already the recovery copy; no snapshot needed.
    setSource(decoded.pcm, decoded.sampleRate, recordingName(), {
      autosave: false,
      sessionId,
    });
  }
});

// ── Load file ─────────────────────────────────────────────────────────────────
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (transcribing) {
    e.target.value = "";
    return;
  }
  if (!confirmIfUnsaved()) {
    e.target.value = "";
    return;
  }
  try {
    await withBusy(`Loading ${file.name}…`, async () => {
      const d = await decodeAudioBlob(file);
      // The file is already on disk: no IndexedDB copy, and not "unsaved".
      setSource(d.pcm, d.sampleRate, file.name, { autosave: false, saved: true });
    });
  } catch (err) {
    alert("Could not decode file: " + err.message);
  }
  // Clear the input so choosing the same file again still fires a change event.
  e.target.value = "";
});

// ── Waveform tools ──────────────────────────────────────────────────────────
$("zoomIn").addEventListener("click", () => {
  waveform.viewLen *= 0.7;
  waveform._clampView();
  waveform.draw();
  $("zoomLabel").textContent = waveform._zoomLabel();
});
$("zoomOut").addEventListener("click", () => {
  waveform.viewLen *= 1.4;
  waveform._clampView();
  waveform.draw();
  $("zoomLabel").textContent = waveform._zoomLabel();
});
$("zoomAll").addEventListener("click", () => {
  waveform.resetZoom();
  $("zoomLabel").textContent = waveform._zoomLabel();
});
$("addSplit").addEventListener("click", () => {
  if (!state.pcm) return;
  waveform.addSplit(state.cursorSample);
});
$("clearSplits").addEventListener("click", () => waveform.clearSplits());

/** -1 dBFS peak level (10^(-1/20)). */
const NORM_PEAK = Math.pow(10, -1 / 20);

$("normBtn").addEventListener("click", async () => {
  if (!state.pcm || state.pcm.length === 0) return;
  let peak = 0;
  for (let i = 0; i < state.pcm.length; i++) {
    const a = Math.abs(state.pcm[i]);
    if (a > peak) peak = a;
  }
  if (!(peak > 0)) {
    $("saveStatus").textContent = "No signal to normalize";
    return;
  }
  const wasPlaying = player.playing;
  const beforeDb = 20 * Math.log10(peak);
  const out = new Float32Array(state.pcm.length);
  const gain = NORM_PEAK / peak;
  for (let i = 0; i < state.pcm.length; i++) out[i] = state.pcm[i] * gain;
  state.pcm = out;
  waveform.refreshData(out, state.sampleRate);
  player.setSource(out, state.sampleRate);
  silenceRunCache = null;
  clearRenderCache();
  applySkipSilence();
  markUnsaved();
  persistAutosave();
  if (wasPlaying) {
    await audioContext().resume();
    player.play(state.cursorSample, currentSpeed());
    $("playBtn").disabled = true;
    $("stopPlayBtn").disabled = false;
  }
  $("saveStatus").textContent = `Normalized: peak ${beforeDb.toFixed(2)} dB → −1.00 dB`;
});

// ── Playback ────────────────────────────────────────────────────────────────
async function togglePlay() {
  if (!state.pcm || transcribing) return;
  if (player.playing) {
    player.stop();
    $("playBtn").disabled = false;
    $("stopPlayBtn").disabled = true;
    return;
  }
  let from = Math.round(state.cursorSample);
  if (from >= state.pcm.length) from = 0;
  await audioContext().resume();
  player.play(from, currentSpeed());
  $("playBtn").disabled = true;
  $("stopPlayBtn").disabled = false;
}

$("playBtn").addEventListener("click", togglePlay);
$("stopPlayBtn").addEventListener("click", () => {
  player.stop();
  $("playBtn").disabled = false;
  $("stopPlayBtn").disabled = true;
});

// Spacebar toggles play/stop at the playhead.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
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
    drag = { x: e.clientX, start: speedValue, moved: false };
  });
  dial.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 3) drag.moved = true;
    dial.classList.add("dragging");
    // Mid-drag: no skip-map re-base, so the drag stays smooth.
    setSpeedUI(drag.start + dx * 0.005, false);
  });
  const endDrag = (cancelled) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    dial.classList.remove("dragging");
    // A cancelled pointer (touch scroll, capture loss) is not a click.
    if (!moved && !cancelled) setSpeedUI(speedValue + 0.25); // plain click
    else if (skipSilence) rebaseSkipSilence();
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
      setSpeedUI(speedValue + 0.25);
      refreshClipDurations();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      setSpeedUI(speedValue - 0.25);
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
      const out = encode(state.pcm, state.sampleRate, "wav");
      downloadBlob(out, `${(state.sourceName || "recording").replace(/\..+$/, "")}-backup.wav`);
      markSaved();
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
}

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
  // Transcribing is CPU-heavy (WASM/Whisper); never overlap it with playback.
  if (player.playing) {
    player.stop();
    $("playBtn").disabled = false;
    $("stopPlayBtn").disabled = true;
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
  try {
    const raw = await transcribe(scope.pcm, state.sampleRate, $("modelSel").value, {
      language: $("langSel").value || undefined,
      device: $("webgpuChk").checked ? "webgpu" : undefined,
      onStatus: (s) => ($("txStatus").textContent = prefixStatus(s)),
      onProgress: (p) => {
        // Model download/load occupies the first 60%.
        if (p && p.progress != null) {
          const loadFrac = p.progress > 1 ? p.progress / 100 : p.progress;
          txFrac(0.6 * loadFrac);
        }
      },
      onSegment: (segment) => {
        // `end` is the end of the completed sequential input window, so this is
        // real file-fraction progress rather than an estimate.
        const end = segment && typeof segment.end === "number" ? segment.end : 0;
        const frac = 0.6 + 0.4 * Math.min(1, end / duration);
        const pct = Math.min(100, Math.round(frac * 100));
        txFrac(frac);
        if (segment && typeof segment.end === "number") {
          $("txStatus").textContent = `Transcribing ${scope.label}… ${pct}% of ${scope.noun}`;
        }
      },
    });
    const fresh = offsetTranscriptTimestamps(raw, scope.offsetSeconds);
    state.transcript = mergeTranscript(state.transcript, fresh, scope);
    renderTranscript(state.transcript);
    updateSplitLabels();
    $("txStatus").textContent = state.transcript.timestamped ? "Done" : "Done (no timestamps — model lacked cross-attention data)";
    $("txActions").style.display = "flex";
  } catch (e) {
    $("txStatus").textContent = "Failed: " + e.message;
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
  };
}
function renderTranscript(result) {
  const el = $("transcript");
  el.innerHTML = "";
  const words = (result.chunks || []).filter((c) => c.timestamp);
  if (words.length === 0) {
    el.textContent = result.text || "(empty)";
    return;
  }
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const start = group[0].timestamp[0];
    const end = group[group.length - 1].timestamp[1] ?? group[group.length - 1].timestamp[0];
    const text = group.map((w) => w.text).join("").trim();
    const div = document.createElement("div");
    div.className = "seg";
    div.title = "Double-click to play from here";
    div.innerHTML = `<span class="t">${fmt(start * state.sampleRate)}</span><span class="x"></span>`;
    div.querySelector(".x").textContent = text;
    div.addEventListener("click", () => {
      const sample = Math.round(start * state.sampleRate);
      state.cursorSample = sample;
      waveform.setPlayhead(sample);
      $("cursorTime").textContent = fmt(sample);
      if (player.playing) player.play(sample, currentSpeed());
    });
    div.addEventListener("dblclick", async () => {
      if (!state.pcm) return;
      const sample = Math.round(start * state.sampleRate);
      state.cursorSample = sample;
      waveform.setPlayhead(sample);
      $("cursorTime").textContent = fmt(sample);
      await audioContext().resume();
      player.play(sample, currentSpeed());
      $("playBtn").disabled = true;
      $("stopPlayBtn").disabled = false;
    });
    el.appendChild(div);
    group = [];
  };
  for (const w of words) {
    group.push(w);
    const line = group.map((word) => word.text).join("").trim();
    if (line.length >= TARGET_TRANSCRIPT_CHARS || /[.!?]\s*$/.test(w.text)) flush();
  }
  flush();
}

$("downloadTx").addEventListener("click", () => {
  if (!state.transcript) return;
  downloadBlob(new Blob([state.transcript.text || ""], { type: "text/plain" }), "transcript.txt");
});
$("downloadSrt").addEventListener("click", () => {
  if (!state.transcript) return;
  downloadBlob(new Blob([toSrt(state.transcript.chunks)], { type: "text/plain" }), "transcript.srt");
});

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
    list.innerHTML = `<span class="muted">No splits — the whole file exports as one clip. Add splits in step 2.</span>`;
    return;
  }
  // Display baked clip lengths without rendering audio: one position map can map
  // every boundary, including a non-uniform class-aware plan or skipped silence.
  let mapper = null;
  try {
    mapper = makeExportMap();
    const clips = buildClips(state.splits, state.pcm.length);
    clips.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "clip";
      const start = mapper ? mapper.mapSample(c.start) : c.start;
      const end = mapper ? mapper.mapSample(c.end) : c.end;
      const dur = Math.max(0, end - start) / state.sampleRate;
      row.innerHTML = `<span class="n">${i + 1}</span>
        <input type="text" value="clip-${String(i + 1).padStart(2, "0")}">
        <span class="d">${dur.toFixed(2)}s</span>
        <button title="Export this clip">⬇</button>`;
      const nameField = row.querySelector("input");
      if (names[i] != null && names[i] !== "") nameField.value = names[i];
    row.querySelector("button").addEventListener("click", async () => {
        const name = nameField.value || `clip-${i + 1}`;
        const fmtSel = $("exportFormat").value;
        await withBusy(`Exporting ${name}…`, async () => {
          try {
            const range = mapClipForExport(c);
            if (range.end > range.start) {
              exportSlice(range.pcm, state.sampleRate, range.start, range.end, fmtSel, `${name}.${fmtSel}`);
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
      const base = (state.sourceName || "recording").replace(/\s+/g, " ");
      const suffix = skip ? "nosilence" : `${speedValue.toFixed(2)}x`;
      const name = baked || skip ? `${base}-${suffix}` : base;
      exportSlice(src.pcm, src.sampleRate, 0, src.pcm.length, fmtSel, `${name}.${fmtSel}`);
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
    const base = (state.sourceName || "recording").replace(/\.[^.]+$/, "").replace(/\s+/g, " ");
    let ranges;
    let mapper = null;
    try {
      // One render and one position map for every clip, not one of each per
      // clip, and honour the per-row name fields.
      const src = exportSource();
      mapper = makeExportMap();
      const clips = buildClips(state.splits, state.pcm.length);
      ranges = clips.map((clip, i) => ({
        name: (names[i] || `clip-${String(i + 1).padStart(2, "0")}`).trim(),
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
            `${base}-${range.name}.${fmtSel}`
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

// ── Boot ────────────────────────────────────────────────────────────────────
window.addEventListener("beforeunload", (e) => {
  // A recording in progress is only partly persisted, and closing mid-capture
  // would lose the live stream entirely.
  const recording = typeof recorder !== "undefined" && recorder.status() !== "idle";
  if (recording || (state.pcm && !state.saved)) {
    e.preventDefault();
    e.returnValue = "";
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

  // The WebGPU toggle is meaningless without a WebGPU adapter.
  if (!navigator.gpu) {
    const gpu = $("webgpuChk");
    if (gpu) {
      gpu.disabled = true;
      const label = gpu.closest("label");
      if (label) label.title = "WebGPU is not available in this browser";
    }
  }

  // Offer the most recent autosaved session instead of silently dropping it.
  // The banner stays until an explicit choice; the slot is not overwritten by a
  // later recording because every source gets its own session id.
  try {
    if (storageAvailable()) {
      const sessions = await listSessions();
      const rec = sessions[0];
      if (rec && !state.pcm) {
        const banner = $("recoverBanner");
        banner.style.display = "flex";
        $("recoverYes").onclick = async () => {
          banner.style.display = "none";
          try {
            await withBusy("Recovering session…", async () => {
              const loaded = await loadSession(rec.id);
              if (!loaded) throw new Error("session is empty");
              const d = await decodeAudioBlob(loaded.blob);
              setSource(d.pcm, d.sampleRate, loaded.meta.name || "Recovered recording", {
                autosave: false,
                sessionId: loaded.meta.id,
              });
            });
          } catch (err) {
            alert("Could not recover the previous session: " + err.message);
          }
        };
        $("recoverNo").onclick = async () => {
          banner.style.display = "none";
          await deleteSession(rec.id).catch(() => {});
        };
      }
    }
  } catch (e) {
    /* storage unreadable; ignore */
  }
})();
