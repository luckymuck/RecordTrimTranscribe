// Microphone recording via MediaRecorder, with a level meter.
// Supports pause/resume: chunks collected before a pause and after a resume are
// merged into one continuous file when stopped.
import { audioContext, decodeAudioBlob } from "./decode.js";

export class Recorder {
  constructor() {
    this.mediaRecorder = null;
    this.chunks = [];
    this.stream = null;
    this.analyser = null;
    this.rafId = null;
    this.onLevel = null;
    this.startTime = 0;
    this.paused = false;
    this.pauseStart = 0;
    this.pausedTotalMs = 0;
  }

  async start(onLevel, deviceId) {
    this.onLevel = onLevel;
    this.chunks = [];
    this.paused = false;
    this.pausedTotalMs = 0;
    const audioConstraints = { echoCancellation: true, noiseSuppression: true };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });

    const ctx = audioContext();
    const src = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);

    this.mediaRecorder = new MediaRecorder(this.stream);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start(250);
    this.startTime = performance.now();
    this._pollLevel();
  }

  /** Current session state: "idle" | "recording" | "paused". */
  status() {
    if (!this.mediaRecorder) return "idle";
    const state = this.mediaRecorder.state;
    if (state === "paused") return "paused";
    if (state === "recording") return this.paused ? "paused" : "recording";
    return "idle";
  }

  pause() {
    if (
      !this.paused &&
      this.mediaRecorder &&
      this.mediaRecorder.state === "recording"
    ) {
      this.mediaRecorder.pause();
      this.paused = true;
      this.pauseStart = performance.now();
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }
  }

  resume() {
    if (this.paused && this.mediaRecorder && this.mediaRecorder.state === "paused") {
      this.mediaRecorder.resume();
      this.pausedTotalMs += performance.now() - this.pauseStart;
      this.paused = false;
      this._pollLevel();
    }
  }

  _pollLevel() {
    if (!this.analyser) return;
    const buf = new Uint8Array(this.analyser.fftSize);
    const tick = () => {
      this.analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
      }
      if (this.onLevel) this.onLevel(peak);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Stop and return decoded mono PCM (all segments merged). */
  async stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (!this.mediaRecorder) return null;
    const done = new Promise((resolve) => {
      this.mediaRecorder.onstop = resolve;
    });
    this.mediaRecorder.stop();
    await done;
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
    this.paused = false;
    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
    this.mediaRecorder = null;
    return decodeAudioBlob(blob);
  }

  /** Recording time excluding pauses. */
  get elapsedMs() {
    if (this.paused) {
      return this.pauseStart - this.startTime - this.pausedTotalMs;
    }
    return performance.now() - this.startTime - this.pausedTotalMs;
  }
}