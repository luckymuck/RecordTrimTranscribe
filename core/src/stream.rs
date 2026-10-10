//! Real-time streaming time-scale modification.
//!
//! FastTalk's offline pipeline is a global decision (pitch marks over the whole
//! signal). For interactive playback we need a causal engine with bounded latency
//! and instant speed changes. Instead of building a separate lossy streaming
//! overlap-add, this module renders the buffered audio in short blocks with the
//! very same hybrid engine used offline — TD-PSOLA on voiced material, WSOLA
//! fallback, copy-through closures (`engines::hybrid`). Each block re-renders a
//! small look-behind so window ramps and pitch marks are fully established at the
//! emit boundary, and each time-stretched seam is crossfaded.
//!
//! Only the analysis advance (how much input each emitted output block consumes)
//! depends on speed, so speed changes never disturb the output grid.

use std::collections::VecDeque;

use crate::engines::hybrid;
use crate::timing::TimeMap;

/// Input rendered as a look-behind/lead beyond each emitted block (seconds).
const TAIL_S: f64 = 0.10;
/// Input consumed per emitted block (seconds).
const SP_S: f64 = 0.40;
/// Startup fade applied at the very first block of a fresh engine (seconds).
/// Long enough to mask a click when playback begins in arbitrary audio.
const STARTUP_FADE_S: f64 = 0.02;
/// Startup fade applied after a `skip_to` (seconds). The jump deliberately lands
/// inside a quiet region, so a long fade is pointless and would swallow the
/// silence kept at the trailing edge of the gap. Just enough to avoid a step.
const SKIP_FADE_S: f64 = 0.002;

pub struct StreamStretcher {
    sr: u32,
    speed: f64,
    input: Vec<f32>,
    /// Absolute input index of `input[0]`.
    base: f64,
    /// Absolute input cursor at the start of the next principal block.
    xc: f64,
    ready: VecDeque<f32>,
    /// Last `fade` output samples of the previous block, held back so the next
    /// block can crossfade across the seam instead of stepping.
    pending: Vec<f32>,
    started: bool,
    /// Output samples to fade in at a cold start. Set to `STARTUP_FADE_S` for a
    /// fresh engine and to `SKIP_FADE_S` after a `skip_to`.
    resume_fade: usize,
    /// Set when the caller knows no more input will be pushed. This prevents a
    /// temporarily short input buffer from being mistaken for the end of audio.
    eof: bool,
}

impl StreamStretcher {
    pub fn new(sample_rate: u32, speed: f64) -> Self {
        let mut s = StreamStretcher {
            sr: sample_rate,
            speed: 1.0,
            input: Vec::new(),
            base: 0.0,
            xc: 0.0,
            ready: VecDeque::new(),
            pending: Vec::new(),
            started: false,
            resume_fade: (STARTUP_FADE_S * sample_rate as f64) as usize,
            eof: false,
        };
        s.set_speed(speed);
        s
    }

    /// Change the playback speed. Only the analysis advance changes; the output
    /// grid (driven by `xc`) is untouched, so there is no gap or overlap.
    /// The engine only compresses audio; slower-than-1x requests are limited to
    /// plain 1x playback.
    pub fn set_speed(&mut self, speed: f64) {
        self.speed = speed.clamp(1.0, 4.0);
    }

    pub fn speed(&self) -> f64 {
        self.speed
    }

    pub fn push(&mut self, samples: &[f32]) {
        self.input.extend_from_slice(samples);
        self.pump();
    }

    pub fn pull(&mut self, max: usize) -> Vec<f32> {
        self.pump();
        let n = max.min(self.ready.len());
        self.ready.drain(..n).collect()
    }

    pub fn available_output(&self) -> usize {
        self.ready.len()
    }

    pub fn reset(&mut self) {
        self.input.clear();
        self.base = 0.0;
        self.xc = 0.0;
        self.ready.clear();
        self.pending.clear();
        self.started = false;
        self.resume_fade = (STARTUP_FADE_S * self.sr as f64) as usize;
        self.eof = false;
    }

    /// Mark all input as pushed so the engine can finalize a held tail.
    pub fn finish(&mut self) {
        self.eof = true;
        self.pump();
    }

    /// Jump the input cursor forward to `input_pos`, discarding buffered input and
    /// any overlap-add carry.
    ///
    /// Used to skip a region (a long silence) during playback. The target is
    /// clamped to be monotonic so a stale or out-of-order call can never rewind
    /// the engine. The resume uses a very short fade rather than the full startup
    /// fade: the jump lands inside silence, and a long fade would attenuate the
    /// quiet speech kept at the trailing edge of the gap.
    pub fn skip_to(&mut self, input_pos: f64) {
        let target = input_pos.max(self.xc);
        self.input.clear();
        self.base = target;
        self.xc = target;
        self.ready.clear();
        self.pending.clear();
        self.started = false;
        self.resume_fade = (SKIP_FADE_S * self.sr as f64) as usize;
        self.eof = false;
    }

    /// Render at most a few blocks per call so latency stays bounded.
    fn pump(&mut self) {
        for _ in 0..6 {
            if !self.process_block() {
                break;
            }
        }
    }

    fn process_block(&mut self) -> bool {
        let sr = self.sr as f64;
        let tail = (TAIL_S * sr).ceil();
        let sp = (SP_S * sr).ceil();
        let ratio = (1.0 / self.speed).clamp(1e-3, 1.0);

        let in_len = self.base + self.input.len() as f64;
        if self.xc >= in_len {
            // Once the caller signals EOF, emit the final held-back tail instead of
            // leaving it in the engine.
            if self.eof && !self.pending.is_empty() {
                let n = self.pending.len();
                for (i, &v) in self.pending.iter().enumerate() {
                    let w = (n - i) as f32 / (n + 1) as f32;
                    self.ready.push_back(v * w);
                }
                self.pending.clear();
                return true;
            }
            return false;
        }

        let target_end = self.xc + sp + tail;
        let end = in_len.min(target_end); // input position to render up to
        let i0 = (self.xc - tail).max(0.0); // render so windows are warm at `xc`
        let i_end = end.ceil();

        let i0_u = ((i0 - self.base).floor() as i64).max(0) as usize;
        let i_end_u = ((i_end - self.base).ceil() as i64).min(self.input.len() as i64) as usize;
        if i_end_u <= i0_u {
            return false;
        }
        // The render buffer starts at `base + i0_u`, which equals `i0` only while
        // there is a full look-behind of history. After `skip_to` there is none, so
        // the emit window must be measured from the buffer that actually exists
        // rather than from the requested (and clipped) `i0`.
        let buf_start = self.base + i0_u as f64;

        let buf: Vec<f64> = self.input[i0_u..i_end_u].iter().map(|v| *v as f64).collect();
        // At 1.0x there is nothing to stretch: pass the input straight through so
        // playback is bit-for-bit the source (no DSP reconstruction, no click risk).
        let rendered: Vec<f64> = if (ratio - 1.0).abs() < 1e-9 {
            buf
        } else {
            let tm = TimeMap::uniform(buf.len() as i64, ratio).expect("ratio is in (0,1]");
            let rates = hybrid::uniform_rate_plan(buf.len() as i64, ratio);
            hybrid::render(&buf, &tm, &rates, self.sr)
        };

        let emit_end = end.min(self.xc + sp); // principal input region to emit
        let j0 = ((self.xc - buf_start) * ratio).round() as i64;
        let mut j_end = ((emit_end - buf_start) * ratio).round() as i64;
        j_end = j_end.min((rendered.len() as i64).max(j0));
        if j_end <= j0 {
            return false;
        }

        let emit_len = (j_end - j0) as usize;
        // `fade` is the inter-block crossfade length. `startup` is the cold-start
        // fade-in length, which is short after a `skip_to` so the recovered audio
        // is not swallowed.
        let fade = ((0.02 * sr) as usize).min(emit_len / 2).max(1);
        let startup = self.resume_fade.min(emit_len);
        let flush = self.eof && in_len < target_end;

        if self.rendered_is_passthrough(ratio) {
            // 1.0x: raw pass-through. Blocks are contiguous copies of the source,
            // so the only edge that can pop is the very start of playback.
            for (idx, j) in (j0..j_end).enumerate() {
                let w = if !self.started && idx < startup {
                    (idx + 1) as f32 / (startup + 1) as f32
                } else {
                    1.0
                };
                self.ready.push_back(rendered[j as usize] as f32 * w);
            }
            self.started = true;
            self.xc = emit_end;
            self.compact_input(tail, sr);
            return true;
        }

        // Time-stretched path: crossfade across every block seam so a small
        // reconstruction difference between neighbouring blocks never steps.
        if emit_len >= 2 * fade {
            if self.pending.is_empty() {
                // First stretched block: emit everything except the tail, which is
                // held back for the next block, with a cold-start fade-in.
                let stop = (j_end - fade as i64).max(j0);
                for (idx, j) in (j0..stop).enumerate() {
                    let w = if idx < startup {
                        (idx + 1) as f32 / (startup + 1) as f32
                    } else {
                        1.0
                    };
                    self.ready.push_back(rendered[j as usize] as f32 * w);
                }
                let s = stop as usize;
                let e = j_end as usize;
                self.pending = rendered[s..e].iter().map(|v| *v as f32).collect();
            } else {
                // Crossfade the previous block's held tail with this block's
                // re-rendered look-behind at the same output positions.
                let blend_len = fade.min(self.pending.len());
                for i in 0..blend_len {
                    let t = (i + 1) as f32 / (blend_len + 1) as f32;
                    let anew = rendered[(j0 - blend_len as i64 + i as i64).max(0) as usize] as f32;
                    self.ready.push_back(self.pending[i] * (1.0 - t) + anew * t);
                }
                let raw = (j_end - fade as i64).max(j0);
                for j in j0..raw {
                    self.ready.push_back(rendered[j as usize] as f32);
                }
                let s = raw as usize;
                let e = j_end as usize;
                self.pending = rendered[s..e].iter().map(|v| *v as f32).collect();
            }
        } else {
            for j in j0..j_end {
                self.ready.push_back(rendered[j as usize] as f32);
            }
            self.pending.clear();
        }

        if flush && !self.pending.is_empty() {
            let n = self.pending.len();
            for (i, &v) in self.pending.iter().enumerate() {
                let w = (n - i) as f32 / (n + 1) as f32; // fade the final tail out
                self.ready.push_back(v * w);
            }
            self.pending.clear();
        }

        self.xc = emit_end;
        self.compact_input(tail, sr);
        true
    }

    /// Drop input no future block can touch (the next block's i0 minus a margin).
    fn compact_input(&mut self, tail: f64, sr: f64) {
        let keep_from = self.xc - tail - 0.10 * sr;
        let drop = ((keep_from - self.base).floor().max(0.0)) as usize;
        if drop > 8192 {
            self.input.drain(..drop);
            self.base += drop as f64;
        }
    }

    /// True when this block passed the input straight through at 1.0x.
    fn rendered_is_passthrough(&self, ratio: f64) -> bool {
        (ratio - 1.0).abs() < 1e-9
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steady_tone(f0: f64, seconds: f64, sr: u32) -> Vec<f32> {
        let n = (seconds * sr as f64) as usize;
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * f0 * i as f64 / sr as f64).sin() as f32)
            .collect()
    }

    fn dominant_frequency(slice: &[f32], sr: u32) -> f64 {
        let n = slice.len().min(8192);
        let x: Vec<f64> = slice[..n].iter().map(|v| *v as f64).collect();
        let mean = x.iter().sum::<f64>() / n as f64;
        let centered: Vec<f64> = x.iter().map(|v| v - mean).collect();
        let mut size = 1usize;
        while size < 2 * n {
            size <<= 1;
        }
        let ac = crate::filters::autocorr(&centered, size, (sr as usize / 60).min(n - 1));
        let lo = (sr as f64 / 400.0) as usize;
        let mut best = lo.max(1);
        for lag in lo.max(1)..(sr as usize / 60).min(n - 1) {
            if ac[lag] > ac[best] {
                best = lag;
            }
        }
        sr as f64 / best as f64
    }

    fn cents(a: f64, b: f64) -> f64 {
        1200.0 * (b / a).log2()
    }

    #[test]
    fn slow_speeds_are_limited_to_plain_playback() {
        let mut s = StreamStretcher::new(16000, 0.5);
        assert_eq!(s.speed(), 1.0);
        s.set_speed(0.75);
        assert_eq!(s.speed(), 1.0);
    }

    #[test]
    fn streaming_scales_length_with_speed() {
        let sr = 16000;
        let x = steady_tone(140.0, 2.0, sr);
        let mut s = StreamStretcher::new(sr, 2.0);
        s.push(&x);
        s.finish();
        let out = s.pull(x.len());
        let expected = x.len() / 2;
        assert!(
            (out.len() as f64 - expected as f64).abs() < 0.06 * expected as f64,
            "got {} expected {}",
            out.len(),
            expected
        );
        assert!(out.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn streaming_preserves_pitch_on_a_tone() {
        // The blockwise render goes through the PSOLA path, so a tone must hold
        // pitch tightly (unlike WSOLA, which detunes it).
        let sr = 16000;
        let x = steady_tone(140.0, 3.0, sr);
        let mut s = StreamStretcher::new(sr, 2.0);
        s.push(&x);
        s.finish();
        let out = s.pull(x.len());
        let before = 140.0;
        let after = dominant_frequency(&out, sr);
        assert!(
            cents(before, after).abs() < 15.0,
            "drifted {before:.0} -> {after:.0} Hz ({} cents)",
            cents(before, after)
        );
    }

    #[test]
    fn streaming_ratio_one_is_identity() {
        let sr = 16000;
        let x = steady_tone(140.0, 0.9, sr);
        let mut s = StreamStretcher::new(sr, 1.0);
        s.push(&x);
        s.finish();
        let out = s.pull(x.len());
        assert!(
            (out.len() as i64 - x.len() as i64).abs() < 64,
            "{} vs {}",
            out.len(),
            x.len()
        );
        let lo = 2048usize.min(out.len()); // beyond the startup fade
        let hi = out.len().min(x.len()).saturating_sub(512);
        let mut worst = 0.0f64;
        for i in lo.max(1)..hi {
            worst = worst.max((out[i] as f64 - x[i] as f64).abs());
        }
        assert!(worst < 1e-6, "worst diff {worst}");
    }

    #[test]
    fn streaming_speed_change_does_not_gap_or_stall() {
        let sr = 16000;
        let x = steady_tone(140.0, 3.0, sr);
        let mut s = StreamStretcher::new(sr, 1.0);
        let mut out: Vec<f32> = Vec::new();

        s.push(&x[..sr as usize]);
        out.extend(s.pull(sr as usize));

        s.set_speed(2.0);
        s.push(&x[sr as usize..]);
        s.finish();
        let mut guard = 0;
        loop {
            let got = s.pull(4096);
            if got.is_empty() {
                guard += 1;
                if guard > 3 {
                    break;
                }
            } else {
                out.extend(got);
            }
        }

        assert!(out.iter().all(|v| v.is_finite()));
        assert!(
            (out.len() as f64 - 2.0 * sr as f64).abs() < 0.3 * sr as f64,
            "length {}",
            out.len()
        );
        let mut run = 0usize;
        let mut worst = 0usize;
        for &v in &out {
            if v.abs() < 1e-4 {
                run += 1;
                worst = worst.max(run);
            } else {
                run = 0;
            }
        }
        assert!(worst < 2000, "silent gap of {worst} samples");
    }

    #[test]
    fn streaming_handles_chunked_input() {
        let sr = 16000;
        let x = steady_tone(140.0, 2.0, sr);
        let mut s = StreamStretcher::new(sr, 1.5);
        let mut collected: Vec<f32> = Vec::new();
        for chunk in x.chunks(777) {
            s.push(chunk);
            collected.extend(s.pull(4096));
        }
        s.finish();
        collected.extend(s.pull(1_000_000));
        let expected = x.len() as f64 / 1.5;
        assert!(
            (collected.len() as f64 - expected).abs() < 0.1 * expected,
            "got {} expected {}",
            collected.len(),
            expected
        );
        let f = dominant_frequency(&collected, sr);
        assert!((f - 140.0).abs() < 15.0, "frequency drifted to {f}");
    }
}