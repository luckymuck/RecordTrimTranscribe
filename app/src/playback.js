// Playback controller.
//
// Primary path is real-time streaming time-stretch via the WASM `StreamStretcher`:
// output is rendered in short chunks and scheduled back-to-back on the AudioContext
// with a small look-ahead, so the speed slider takes effect during playback. The
// offline `timeStretch` (faithful hybrid engine) is exposed as `bake` for export.

import { audioContext } from "./audio/decode.js";
import { StreamStretcher, timeStretch } from "./core/dsp.js";

const LOOKAHEAD = 1.5; // seconds of output to keep scheduled ahead
const OUT_CHUNK = 0.2; // seconds of output per rendered buffer
// Never start a buffer closer than this to "now". If the main thread stalls
// long enough to let the graph drain, the schedule is pushed forward to here so
// the backlog is dropped cleanly. Starting a buffer in the past makes it begin
// immediately, which would overlap every queued buffer on top of each other.
const MIN_LEAD = 0.05;
// A skip-silence jump resumes almost immediately. The cut already happened at
// "now", so any lead here is heard as a silent gap: use just enough to keep the
// buffer from being scheduled in the past.
const RESUME_LEAD = 0.005;

export class Player {
  constructor({ onPosition, onEnd } = {}) {
    this.ctx = audioContext();
    this.onPosition = onPosition || (() => {});
    this.onEnd = onEnd || (() => {});
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);

    this.pcm = null;
    this.sr = 48000;
    this.playing = false;
    this.sources = [];
    this.timer = null;
    this.stretcher = null;
    this.srcCursor = 0;
    this.scheduleTime = 0;
    this.srcStart = 0;
    this.timeStart = 0;
    this.activeSpeed = 1;
    this.requestedSpeed = 1;
    this.finished = false;
    this.skipMap = [];
    this.skipIdx = 0;
  }

  setSource(pcm, sampleRate) {
    this.stop();
    this.pcm = pcm;
    this.sr = sampleRate;
  }

  /**
   * Zones to jump over during playback, as `{start, end}` in input samples.
   * Sorted defensively so the binary search can assume order.
   */
  setSkipMap(zones) {
    this.skipMap = Array.isArray(zones)
      ? zones
          .filter((z) => z && z.end > z.start)
          .map((z) => ({ start: z.start, end: z.end }))
          .sort((a, b) => a.start - b.start)
      : [];
    this.skipIdx = 0;
  }

  play(fromSample, speed) {
    if (!this.pcm) return;
    this.stop();
    this.requestedSpeed = speed;
    this.activeSpeed = speed;
    this.stretcher = new StreamStretcher(this.sr, speed);
    this.srcCursor = Math.max(0, Math.floor(fromSample));
    this.finished = false;
    this.scheduleTime = this.ctx.currentTime + 0.08;
    this.srcStart = this.srcCursor;
    this.timeStart = this.scheduleTime;
    this.playing = true;
    this._tick();
    this.timer = setInterval(() => this._tick(), 50);
  }

  setSpeed(speed) {
    this.requestedSpeed = speed;
    if (this.playing && this.stretcher) {
      const now = this.ctx.currentTime;
      const elapsed = Math.max(0, now - this.timeStart);
      const played = Math.min(
        this.pcm.length,
        this.srcStart + elapsed * this.sr * this.activeSpeed
      );
      this.stretcher.set_speed(speed);
      this.srcStart = played;
      this.timeStart = now;
      this.activeSpeed = speed;
    }
  }

  _renderNextChunk() {
    const outSamples = Math.floor(OUT_CHUNK * this.sr);
    const out = new Float32Array(outSamples);
    let filled = 0;
    let guard = 0;
    const inputEnd = this.pcm.length;
    while (filled < outSamples && guard < 500) {
      guard++;
      if (this.srcCursor >= inputEnd) {
        // The engine finalizes a held seam only when signaled, so tell it once
        // that the whole source has been pushed.
        this.stretcher.finish();
        this.finished = true;
        const got = this.stretcher.pull(outSamples - filled);
        if (got.length === 0) break;
        out.set(got, filled);
        filled += got.length;
        continue;
      }
      const pushN = Math.min(
        inputEnd - this.srcCursor,
        Math.ceil(outSamples * this.requestedSpeed) + 8192
      );
      this.stretcher.push(this.pcm.subarray(this.srcCursor, this.srcCursor + pushN));
      this.srcCursor += pushN;
      const got = this.stretcher.pull(outSamples - filled);
      out.set(got, filled);
      filled += got.length;
      if (got.length === 0) break;
    }
    return filled > 0 ? out.subarray(0, filled) : null;
  }

  _tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;

    // Skip silence before scheduling, so this same tick re-renders from the end
    // of the zone and the graph never actually plays the gap.
    let resumed = false;
    if (this.skipMap.length) {
      const zone = this._skipZoneAt(this._position(now));
      if (zone) {
        this._skipTo(zone.end);
        resumed = true;
      }
    }

    const t = this.ctx.currentTime;
    // A jump resumes almost immediately so it is not heard as a pause; a stalled
    // queue, by contrast, is dropped cleanly with the full lead.
    const lead = resumed ? RESUME_LEAD : MIN_LEAD;
    if (this.scheduleTime < t + lead) {
      this.scheduleTime = t + lead;
    }
    if (resumed) {
      // Anchor the playhead to when the resumed audio actually starts, otherwise
      // it runs the lead ahead of what is heard.
      this.timeStart = this.scheduleTime;
    }

    const horizon = t + LOOKAHEAD;
    let guard = 0;
    while (this.scheduleTime < horizon && guard < 50) {
      guard++;
      const chunk = this._renderNextChunk();
      if (!chunk) {
        this._scheduleEnd();
        return;
      }
      const buf = this.ctx.createBuffer(1, chunk.length, this.sr);
      buf.copyToChannel(chunk, 0);
      const node = this.ctx.createBufferSource();
      node.buffer = buf;
      node.connect(this.gain);
      node.onended = () => {
        try {
          node.disconnect();
        } catch (e) {}
        const index = this.sources.indexOf(node);
        if (index >= 0) this.sources.splice(index, 1);
      };
      node.start(this.scheduleTime);
      this.sources.push(node);
      this.scheduleTime += chunk.length / this.sr;
    }
    this.onPosition(this._position(this.ctx.currentTime));
  }

  /** Input-domain playhead position at audio time `now`. */
  _position(now) {
    const elapsed = Math.max(0, now - this.timeStart);
    return Math.min(
      this.pcm.length,
      this.srcStart + elapsed * this.sr * this.activeSpeed
    );
  }

  /** The zone containing `pos`, or null. Zones are sorted by start. */
  _skipZoneAt(pos) {
    const zones = this.skipMap;
    let lo = 0;
    let hi = zones.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (zones[mid].start <= pos) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return null;
    const zone = zones[found];
    return pos < zone.end ? zone : null;
  }

  /**
   * Jump the playhead to `sample`, dropping the scheduled audio and the engine's
   * input cursor. The cut lands inside a silence zone, so it is inaudible.
   *
   * `scheduleTime` is zeroed rather than set here: the caller picks the resume
   * lead (a jump wants a very short one) and anchors `timeStart` to it, so the
   * two must be decided together.
   */
  _skipTo(sample) {
    for (const n of this.sources) {
      try {
        n.stop();
      } catch (e) {}
      try {
        n.disconnect();
      } catch (e) {}
    }
    this.sources = [];
    if (this.stretcher) this.stretcher.skip_to(sample);
    this.srcCursor = sample;
    this.srcStart = sample;
    this.scheduleTime = 0;
    this.finished = false;
  }

  _scheduleEnd() {
    if (!this.playing) return;
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const remaining = Math.max(0, (this.scheduleTime - this.ctx.currentTime) * 1000);
    setTimeout(() => {
      this.onPosition(this.pcm.length);
      this.onEnd();
    }, remaining + 30);
  }

  stop() {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const n of this.sources) {
      try {
        n.stop();
      } catch (e) {}
      try {
        n.disconnect();
      } catch (e) {}
    }
    this.sources = [];
    this.stretcher = null;
  }

  /** Offline render of the whole clip at `speed` (faithful hybrid engine). */
  bake(speed, classAware) {
    if (!this.pcm) return null;
    return timeStretch(this.pcm, this.sr, speed, classAware);
  }
}
