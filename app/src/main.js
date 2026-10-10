// Application wiring: record/load → waveform → playback → transcribe → export.
import { initDsp, getDspVersion, makeBakedMap, makeSkipBakedMap, timeStretchSkipSilence, silenceZones } from "./core/dsp.js";
import { decodeAudioBlob, audioContext } from "./audio/decode.js";
import { Recorder } from "./audio/record.js";
import { encode, encodeWav } from "./audio/encode.js";
import { saveAutosave, loadAutosave, clearAutosave, storageAvailable } from "./storage.js";
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
};

const recorder = new Recorder();
let recTimer = null;
let transcribing = false;

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
  onSplitsChange: (splits) => {
    state.splits = splits.slice();
    $("splitInfo").textContent = `${splits.length} splits`;
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
const SKIP_KEEP_S = 0.2;
let skipSilence = false;
let silenceZoneCache = null;

function currentSpeed() {
  return speedValue;
}

function setSpeedUI(s) {
  speedValue = Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, s)) * 100) / 100;
  $("speed").textContent = speedValue.toFixed(2) + "×";
  $("speed").setAttribute("aria-valuenow", speedValue.toFixed(2));
  player.setSpeed(speedValue);
}

/** Silence zones in input samples, computed once per loaded recording. */
function getSilenceZones() {
  if (!state.pcm) return [];
  if (!silenceZoneCache) {
    silenceZoneCache = silenceZones(state.pcm, state.sampleRate, SKIP_MIN_S, SKIP_KEEP_S);
  }
  return silenceZoneCache;
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
        applySkipSilence();
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
    applySkipSilence();
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
}

function markUnsaved() {
  state.saved = false;
  $("saveStatus").textContent = "unsaved ⚠";
}

/** Keep a copy of the current clip in IndexedDB so it survives a page close. */
async function persistAutosave() {
  if (!state.pcm) return;
  try {
    const blob = encodeWav(state.pcm, state.sampleRate);
    await saveAutosave({
      name: state.sourceName || "recording",
      sampleRate: state.sampleRate,
      blob,
      savedAt: Date.now(),
    });
  } catch (e) {
    /* storage unavailable or full; non-fatal */
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

function setSource(pcm, sampleRate, label) {
  state.pcm = pcm;
  state.sampleRate = sampleRate;
  state.transcript = null;
  state.splits = [];
  state.sourceName = label || "recording";
  waveform.setData(pcm, sampleRate);
  player.setSource(pcm, sampleRate);
  silenceZoneCache = null;
  applySkipSilence();
  $("fileMeta").textContent = `${label} · ${(pcm.length / sampleRate).toFixed(1)}s @ ${sampleRate} Hz`;
  enableCards(true);
  markUnsaved();
  persistAutosave();
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
function transcriptWordsForClip(startSample) {
  const tx = state.transcript;
  if (!tx || !tx.chunks || !state.pcm) return "";
  const sorted = tx.chunks
    .filter((c) => Array.isArray(c.timestamp) && c.timestamp[0] * state.sampleRate >= startSample)
    .sort((a, b) => a.timestamp[0] - b.timestamp[0])
    .slice(0, 4)
    .map((w) => w.text.trim());
  const text = sorted.join(" ").trim();
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
  try {
    await recorder.start((level) => {
      $("meterFill").style.width = Math.min(100, level * 140) + "%";
    }, state.inputDeviceId);
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
  let decoded = null;
  try {
    decoded = await recorder.stop();
  } catch (err) {
    setRecordingUi(false);
    alert("Could not finish the recording: " + err.message);
    return;
  }
  setRecordingUi(false);
  if (decoded) setSource(decoded.pcm, decoded.sampleRate, recordingName());
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
    const d = await decodeAudioBlob(file);
    setSource(d.pcm, d.sampleRate, file.name);
  } catch (err) {
    alert("Could not decode file: " + err.message);
  }
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
  silenceZoneCache = null;
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
    setSpeedUI(drag.start + dx * 0.005);
  });
  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    dial.classList.remove("dragging");
    if (!moved) setSpeedUI(speedValue + 0.25); // plain click
    refreshClipDurations();
  };
  dial.addEventListener("pointerup", endDrag);
  dial.addEventListener("pointercancel", endDrag);
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

$("saveBackup").addEventListener("click", () => {
  if (!state.pcm) {
    alert("Nothing to save yet.");
    return;
  }
  try {
    const out = encode(state.pcm, state.sampleRate, "wav");
    downloadBlob(out, `${(state.sourceName || "recording").replace(/\..+$/, "")}-backup.wav`);
    markSaved();
  } catch (err) {
    $("saveStatus").textContent = `Backup failed: ${err.message}`;
  }
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
    state.transcript = offsetTranscriptTimestamps(raw, scope.offsetSeconds);
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
    row.querySelector("button").addEventListener("click", () => {
        const name = nameField.value || `clip-${i + 1}`;
        const fmtSel = $("exportFormat").value;
        try {
          const range = mapClipForExport(c);
          if (range.end > range.start) {
            exportSlice(range.pcm, state.sampleRate, range.start, range.end, fmtSel, `${name}.${fmtSel}`);
          }
        } catch (err) {
          $("exportStatus").textContent = `Export failed: ${err.message}`;
        }
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
      SKIP_KEEP_S
    );
  }
  if (useBakedExport()) {
    return makeBakedMap(state.pcm, state.sampleRate, speedValue, $("classAware").checked);
  }
  return null;
}

/** Render source PCM for export, using the same DSP bake as playback exports. */
function exportSource() {
  if (!state.pcm) return null;
  if (useSkipExport()) {
    return {
      pcm: timeStretchSkipSilence(
        state.pcm,
        state.sampleRate,
        speedValue,
        $("classAware").checked,
        SKIP_MIN_S,
        SKIP_KEEP_S
      ),
      sampleRate: state.sampleRate,
    };
  }
  if (!useBakedExport()) {
    return { pcm: state.pcm, sampleRate: state.sampleRate };
  }
  return {
    pcm: player.bake(speedValue, $("classAware").checked),
    sampleRate: state.sampleRate,
  };
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

$("exportAll").addEventListener("click", () => {
  if (!state.pcm) return;
  const fmtSel = $("exportFormat").value;
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
    markSaved();
    $("exportStatus").textContent = skip
      ? `Exported whole file, silence removed, baked at ${speedValue.toFixed(2)}×`
      : baked
        ? `Exported whole file, speed-baked at ${speedValue.toFixed(2)}×`
        : "Exported whole file";
  } catch (err) {
    $("exportStatus").textContent = `Export failed: ${err.message}`;
  }
});

$("exportClips").addEventListener("click", () => {
  if (!state.pcm) return;
  const fmtSel = $("exportFormat").value;
  let ranges;
  try {
    const clips = buildClips(state.splits, state.pcm.length);
    ranges = clips.map((clip) => mapClipForExport(clip));
  } catch (err) {
    $("exportStatus").textContent = `Export failed: ${err.message}`;
    return;
  }
  ranges.forEach((range, i) => {
    setTimeout(() => {
      try {
        if (range.end > range.start) {
          exportSlice(range.pcm, state.sampleRate, range.start, range.end, fmtSel, `clip-${String(i + 1).padStart(2, "0")}.${fmtSel}`);
        }
      } catch (err) {
        $("exportStatus").textContent = `Export failed: ${err.message}`;
      }
    }, i * 250);
  });
  $("exportStatus").textContent = `Exporting ${ranges.length} clip(s)…`;
});

// ── Boot ────────────────────────────────────────────────────────────────────
window.addEventListener("beforeunload", (e) => {
  if (state.pcm && !state.saved) {
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

  // Offer the previous session's autosaved clip instead of silently dropping it.
  try {
    if (storageAvailable()) {
      const rec = await loadAutosave();
      if (rec && rec.blob && !state.pcm) {
        const banner = $("recoverBanner");
        banner.style.display = "flex";
        $("recoverYes").onclick = async () => {
          banner.style.display = "none";
          try {
            const d = await decodeAudioBlob(rec.blob);
            setSource(d.pcm, d.sampleRate, rec.name || "Recovered recording");
          } catch (err) {
            alert("Could not recover the previous session: " + err.message);
          }
          clearAutosave().catch(() => {});
        };
        $("recoverNo").onclick = async () => {
          banner.style.display = "none";
          await clearAutosave().catch(() => {});
        };
      }
    }
  } catch (e) {
    /* storage unreadable; ignore */
  }
})();
