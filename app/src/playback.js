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

const LOOKAHEAD = 0.5; // seconds of output to keep scheduled ahead
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
    // Deferred "playback ended" timer, and a token so a stale one cannot fire
    // after the user has started playback again.
    this.endTimer = null;
    this.generation = 0;
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
    // Last kept sample read, used as the ramp start when a read begins exactly
    // at a gap (PB-11).
    this._lastKept = 0;
    this.gaps = []; // sorted, non-overlapping {start, end} in source samples
    this.removedBefore = new Float64Array(0);
    this.keptBefore = new Float64Array(0);
    this._feed = new Float32Array(0);
    this._joinRamp = 240; // samples used to ease a closed gap (5 ms at 48 kHz)
    // Output-time -> kept-position map, one entry per scheduled chunk. The
    // playhead is read from this instead of wall-clock * speed, so a speed
    // change cannot leave it ahead of or behind the audio actually heard.
    this.posLog = [];
    this.keptConsumed = 0;
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
    // Round to whole samples. `silence_zones` returns f64 positions: at odd
    // rates (11025 Hz) `keep / 2` is fractional, and the fractional tail would
    // drift the feed by a sample per gap.
    this.gaps = Array.isArray(zones)
      ? zones
          .map((z) => (z ? { start: Math.round(z.start), end: Math.round(z.end) } : null))
          .filter((z) => z && z.end > z.start)
          .sort((a, b) => a.start - b.start)
      : [];
    // Cumulative lengths so the position maps are binary searches rather than
    // a scan of every gap on every 50 ms tick.
    const n = this.gaps.length;
    this.removedBefore = new Float64Array(n);
    this.keptBefore = new Float64Array(n);
    let removed = 0;
    for (let i = 0; i < n; i++) {
      this.removedBefore[i] = removed;
      this.keptBefore[i] = this.gaps[i].start - removed;
      removed += this.gaps[i].end - this.gaps[i].start;
    }
  }

  /** Number of kept samples before source position `p`. */
  sourceToKept(p) {
    const gaps = this.gaps;
    let lo = 0;
    let hi = gaps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gaps[mid].start <= p) lo = mid + 1;
      else hi = mid;
    }
    const i = lo - 1;
    if (i < 0) return p;
    const g = gaps[i];
    return p - (this.removedBefore[i] + Math.min(p, g.end) - g.start);
  }

  /** Source position corresponding to kept position `k`. */
  keptToSource(k) {
    const gaps = this.gaps;
    let lo = 0;
    let hi = gaps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keptBefore[mid] > k) hi = mid;
      else lo = mid + 1;
    }
    const i = lo; // first gap whose kept position is past k
    if (i >= gaps.length) {
      const last = gaps.length - 1;
      return last < 0 ? k : gaps[last].end + (k - this.keptBefore[last]);
    }
    if (i === 0) return k;
    const prev = gaps[i - 1].end;
    const segStart = this.keptBefore[i] - (gaps[i].start - prev);
    return k >= segStart ? prev + (k - segStart) : gaps[i - 1].end;
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
    this._lastKept = 0;
    this.posLog = [];
    this.keptConsumed = this.srcStart;
    this.scheduleTime = this.ctx.currentTime + 0.08;
    this.timeStart = this.scheduleTime;
    this.playing = true;
    this._tick();
    this.timer = setInterval(() => this._tick(), 50);
  }

  /**
   * Change the playback speed. The playhead is not re-based here: it comes from
   * the render log, which already knows what was rendered at which speed.
   */
  setSpeed(speed) {
    this.requestedSpeed = speed;
    this.activeSpeed = speed;
    if (this.playing && this.stretcher) {
      this.stretcher.set_speed(speed);
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
        // If this read starts exactly at the gap there is no preceding sample in
        // the buffer, so fall back to the last sample read before it rather than
        // 0, which would be a step in the middle of what should be silence
        // (PB-11).
        const prev = n > 0 ? buf[n - 1] : this._lastKept;
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
      this._lastKept = buf[n - 1];
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
      const have = this.stretcher.available_output();
      const needed = outSamples - filled;
      if (have < needed && this.srcRead < inputEnd) {
        // Push only what is needed (plus a small margin). Pushing a fixed
        // surplus every chunk used to pile rendered audio up in the engine,
        // which delayed speed changes by the whole backlog.
        const want = Math.ceil((needed - have) * this.requestedSpeed) + 2048;
        const chunk = this._readKept(want);
        if (chunk.length === 0) break;
        this.stretcher.push(chunk);
      } else if (this.srcRead >= inputEnd) {
        // The engine finalizes a held seam only when signaled, so tell it once
        // that the whole source has been pushed.
        this.stretcher.finish();
      }
      const got = this.stretcher.pull(needed);
      if (got.length > 0) {
        out.set(got, filled);
        filled += got.length;
      } else if (this.srcRead >= inputEnd || have >= needed) {
        break;
      }
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
      // Rendering is synchronous and the first chunk is a full 0.2 s, which at
      // 4x takes about as long as MIN_LEAD. If the grid has fallen behind the
      // audio clock, re-anchor it instead of starting a buffer in the past: a
      // late `start(when)` plays immediately and overlaps the next buffer.
      const afterRender = this.ctx.currentTime;
      if (this.scheduleTime < afterRender + MIN_LEAD) {
        this.scheduleTime = afterRender + MIN_LEAD;
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
      // Record what this chunk is and where it lands, at the speed it was
      // rendered with.
      const k0 = this.keptConsumed;
      const k1 = k0 + chunk.length * this.activeSpeed;
      this.posLog.push({
        t0: this.scheduleTime,
        k0,
        t1: this.scheduleTime + chunk.length / this.sr,
        k1,
      });
      this.keptConsumed = k1;
      this.scheduleTime += chunk.length / this.sr;
    }
    // Drop log entries well behind the playhead.
    while (this.posLog.length > 1 && this.posLog[0].t1 < now - 2) {
      this.posLog.shift();
    }
    this.onPosition(this._position(this.ctx.currentTime));
  }

  /** Source-domain playhead position at audio time `now`, from the render log. */
  _position(now) {
    const log = this.posLog;
    if (!log || log.length === 0) {
      return Math.min(this.pcm.length, this.keptToSource(this.srcStart));
    }
    let lo = 0;
    let hi = log.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (log[mid].t0 <= now) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    let kept;
    if (found < 0) {
      kept = log[0].k0;
    } else {
      const e = log[found];
      if (now >= e.t1) {
        kept = found === log.length - 1 ? e.k1 : log[found + 1].k0;
      } else {
        kept = e.k0 + ((now - e.t0) / (e.t1 - e.t0)) * (e.k1 - e.k0);
      }
    }
    return Math.min(this.pcm.length, this.keptToSource(kept));
  }

  _scheduleEnd() {
    if (!this.playing) return;
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const generation = this.generation;
    const remaining = Math.max(0, (this.scheduleTime - this.ctx.currentTime) * 1000);
    this._clearEndTimer();
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      // Playback may have been restarted since; a stale timer must not reset
      // the transport under a running session.
      if (generation !== this.generation) return;
      this.onPosition(this.pcm.length);
      this.onEnd();
    }, remaining + 30);
  }

  _clearEndTimer() {
    if (this.endTimer !== null) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
  }

  stop() {
    this.playing = false;
    this.generation += 1;
    this._clearEndTimer();
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
    // Release the WASM object eagerly instead of waiting for the finalizer.
    if (this.stretcher) {
      try {
        this.stretcher.free();
      } catch (e) {}
    }
    this.stretcher = null;
    this.posLog = [];
  }

  /** Offline render of the whole clip at `speed` (faithful hybrid engine). */
  bake(speed, classAware) {
    if (!this.pcm) return null;
    return timeStretch(this.pcm, this.sr, speed, classAware);
  }
}
