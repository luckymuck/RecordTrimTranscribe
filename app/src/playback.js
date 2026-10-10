// Playback controller.
//
// Primary path is real-time streaming time-stretch via the WASM `StreamStretcher`:
// output is rendered in short chunks and scheduled back-to-back on the AudioContext
// with a small look-ahead, so the speed slider takes effect during playback. The
// offline `timeStretch` (faithful hybrid engine) is exposed as `bake` for export.
//
// Skip-silence is applied in the *input feed*, not by restarting the engine. The
// stretcher is handed the kept regions of the source with the gap interiors
// removed, so it renders one continuous stream and never resumes mid-signal --
// no restart, no overlap, no doubled audio. The playhead maps kept positions back
// to source positions so the cursor still jumps over the removed gaps.

import { audioContext } from "./audio/decode.js";
import { StreamStretcher, timeStretch } from "./core/dsp.js";

const LOOKAHEAD = 1.5; // seconds of output to keep scheduled ahead
const OUT_CHUNK = 0.2; // seconds of output per rendered buffer
// Never start a buffer closer than this to "now". If the main thread stalls
// long enough to let the graph drain, the schedule is pushed forward to here so
// the backlog is dropped cleanly. Starting a buffer in the past makes it begin
// immediately, which would overlap every queued buffer on top of each other.
const MIN_LEAD = 0.05;

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
    // Source-domain read cursor for feeding the engine (kept samples only).
    this.srcRead = 0;
    this.scheduleTime = 0;
    // `timeStart`/`srcStart` are in *kept* samples: the engine consumes the kept
    // stream, so output time maps linearly onto kept position.
    this.srcStart = 0;
    this.timeStart = 0;
    this.activeSpeed = 1;
    this.requestedSpeed = 1;
    this.finished = false;
    this.gaps = []; // sorted, non-overlapping {start, end} in source samples
    this._feed = new Float32Array(0);
    this._joinRamp = 240; // samples used to ease a closed gap (5 ms at 48 kHz)
  }

  setSource(pcm, sampleRate) {
    this.stop();
    this.pcm = pcm;
    this.sr = sampleRate;
    this._joinRamp = Math.max(1, Math.round(0.005 * sampleRate));
  }

  /**
   * Gap interiors to remove from the feed, as `{start, end}` in input samples.
   * Sorted defensively so the mapping can assume order.
   */
  setSkipMap(zones) {
    this.gaps = Array.isArray(zones)
      ? zones
          .filter((z) => z && z.end > z.start)
          .map((z) => ({ start: z.start, end: z.end }))
          .sort((a, b) => a.start - b.start)
      : [];
  }

  /** Number of kept samples before source position `p`. */
  sourceToKept(p) {
    let removed = 0;
    for (const g of this.gaps) {
      if (p <= g.start) break;
      removed += Math.min(p, g.end) - g.start;
    }
    return p - removed;
  }

  /** Source position corresponding to kept position `k`. */
  keptToSource(k) {
    let consumed = 0;
    let prev = 0;
    for (const g of this.gaps) {
      const kept = g.start - prev;
      if (k < consumed + kept) return prev + (k - consumed);
      consumed += kept;
      prev = g.end;
    }
    return prev + (k - consumed);
  }

  play(fromSample, speed) {
    if (!this.pcm) return;
    this.stop();
    this.requestedSpeed = speed;
    this.activeSpeed = speed;
    this.stretcher = new StreamStretcher(this.sr, speed);
    const from = Math.max(0, Math.floor(fromSample));
    this.srcRead = from;
    this.srcStart = this.sourceToKept(from);
    this.finished = false;
    this.scheduleTime = this.ctx.currentTime + 0.08;
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
      const played = this.srcStart + elapsed * this.sr * this.activeSpeed;
      this.stretcher.set_speed(speed);
      this.srcStart = played;
      this.timeStart = now;
      this.activeSpeed = speed;
    }
  }

  /** Gap containing `p`, or null. `gaps` is sorted. */
  _gapContaining(p) {
    let lo = 0;
    let hi = this.gaps.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.gaps[mid].start <= p) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return null;
    const g = this.gaps[found];
    return p < g.end ? g : null;
  }

  /** Start of the first gap strictly after `p`, or `inputEnd`. */
  _nextGapStart(p, inputEnd) {
    let lo = 0;
    let hi = this.gaps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.gaps[mid].start > p) hi = mid;
      else lo = mid + 1;
    }
    return lo < this.gaps.length ? this.gaps[lo].start : inputEnd;
  }

  /**
   * Read up to `want` kept samples from `srcRead`, dropping gap interiors.
   * Copies into a scratch buffer because the result is never contiguous. The
   * step where a gap is closed is ramped over a few ms so it is not a click.
   */
  _readKept(want) {
    const inputEnd = this.pcm.length;
    if (this._feed.length < want) this._feed = new Float32Array(want);
    const buf = this._feed;
    const xf = this._joinRamp;
    let n = 0;
    while (n < want && this.srcRead < inputEnd) {
      const gap = this._gapContaining(this.srcRead);
      if (gap) {
        // Close the gap, easing from the last sample before it into the tail.
        const prev = n > 0 ? buf[n - 1] : 0;
        this.srcRead = gap.end;
        const take = Math.min(want - n, inputEnd - this.srcRead, xf);
        for (let i = 0; i < take; i++) {
          const sample = this.pcm[this.srcRead + i];
          const t = (i + 1) / (take + 1);
          buf[n + i] = prev + (sample - prev) * t;
        }
        n += take;
        this.srcRead += take;
        continue;
      }
      const stop = this._nextGapStart(this.srcRead, inputEnd);
      const take = Math.min(want - n, stop - this.srcRead);
      buf.set(this.pcm.subarray(this.srcRead, this.srcRead + take), n);
      n += take;
      this.srcRead += take;
    }
    return buf.subarray(0, n);
  }

  _renderNextChunk() {
    const outSamples = Math.floor(OUT_CHUNK * this.sr);
    const out = new Float32Array(outSamples);
    let filled = 0;
    let guard = 0;
    const inputEnd = this.pcm.length;
    while (filled < outSamples && guard < 500) {
      guard++;
      if (this.srcRead >= inputEnd) {
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
      const want = Math.ceil(outSamples * this.requestedSpeed) + 8192;
      const chunk = this._readKept(want);
      if (chunk.length === 0) break;
      this.stretcher.push(chunk);
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
    if (this.scheduleTime < now + MIN_LEAD) {
      this.scheduleTime = now + MIN_LEAD;
    }
    const horizon = now + LOOKAHEAD;
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

  /** Source-domain playhead position at audio time `now`. */
  _position(now) {
    const elapsed = Math.max(0, now - this.timeStart);
    const kept = this.srcStart + elapsed * this.sr * this.activeSpeed;
    return Math.min(this.pcm.length, this.keptToSource(kept));
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
