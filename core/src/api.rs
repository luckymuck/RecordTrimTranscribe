//! JavaScript-facing API exposed through `wasm-bindgen`.
//!
//! Two entry points cover the client:
//!
//! * [`time_stretch`] — offline render of a whole clip at a chosen speed, using the
//!   faithful hybrid (TD-PSOLA for voiced material, WSOLA fallback, class-aware
//!   allocation when requested). Used for export and for "baked" playback.
//! * [`StreamStretcher`] — a causal, real-time engine for interactive speed control.

use wasm_bindgen::prelude::*;

use crate::classes::{profile_for, Class};
use crate::engines::{hybrid, psola};
use crate::rate;
use crate::timing::TimeMap;

fn to_f64(samples: &[f32]) -> Vec<f64> {
    samples.iter().map(|v| *v as f64).collect()
}

/// Ratio (`out/in`) for a requested speed-up (`speed >= 1` means faster).
fn ratio_for_speed(speed: f64) -> f64 {
    (1.0 / speed.max(1e-3)).clamp(1e-3, 1.0)
}

/// The rate a class is rendered at, mirroring `rate::plan_rates` exactly.
///
/// Skip-silence derives both the rendered audio and its position map from this
/// one function so the two cannot drift apart: a map built on a different rate
/// than the render silently shifts every clip boundary.
fn class_rate(cls: Class, ratio: f64) -> f64 {
    let profile = profile_for(cls);
    (ratio * profile.multiplier).clamp(profile.floor, 1.0)
}

/// Keep-list for a skip-silence render: every segment except silence runs longer
/// than `min_silence_s`, each as `(start, end, rate)`.
///
/// A long silence is not dropped outright. Its `keep_s` is split between its
/// start and its end, so the surviving pause brackets the words it separates and
/// a detector boundary that lands a hair early or late cannot clip them.
/// `keep_s` is measured in source time (the 1.00x timeline) and rendered at the
/// target `ratio`, so the pause shortens with the speed like everything else.
fn skip_keep_list(
    segments: &[crate::timing::Segment],
    sr: u32,
    ratio: f64,
    class_aware: bool,
    min_silence_s: f64,
    keep_s: f64,
) -> Vec<(i64, i64, f64)> {
    let half = ((keep_s * sr as f64).round() as i64) / 2;
    let mut keep = Vec::new();
    for seg in segments {
        let seconds = (seg.end - seg.start) as f64 / sr as f64;
        if seg.cls == Class::Silence && seconds > min_silence_s {
            let head_end = (seg.start + half).min(seg.end);
            if head_end > seg.start {
                keep.push((seg.start, head_end, ratio));
            }
            let tail_start = (seg.end - half).max(seg.start);
            if seg.end > tail_start {
                keep.push((tail_start, seg.end, ratio));
            }
            continue;
        }
        let rate = if class_aware {
            class_rate(seg.cls, ratio)
        } else {
            ratio
        };
        keep.push((seg.start, seg.end, rate));
    }
    keep
}

/// Render one kept span at a constant `rate` using the hybrid engine.
fn stretch_span(x: &[f64], rate: f64, sr: u32) -> Vec<f64> {
    let rate = rate.clamp(1e-3, 1.0);
    let tm = TimeMap::uniform(x.len() as i64, rate).expect("rate is in (0,1]");
    let rates = hybrid::uniform_rate_plan(x.len() as i64, rate);
    hybrid::render(x, &tm, &rates, sr)
}

/// Crate version, useful for cache-busting the WASM in the client.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Offline time-scale modification of a mono clip.
///
/// `class_aware` uses an energy-based silence/speech segmentation to allocate the
/// speed budget (silence compresses harder, speech is protected); otherwise a
/// uniform ratio is used. Pitch is preserved in both cases.
#[wasm_bindgen]
pub fn time_stretch(samples: &[f32], sample_rate: u32, speed: f64, class_aware: bool) -> Vec<f32> {
    let x = to_f64(samples);
    if x.len() < 2 {
        return samples.to_vec();
    }
    let ratio = ratio_for_speed(speed);

    let out = if class_aware {
        let segments = rate::align_by_energy(&x, sample_rate);
        let rates = rate::plan_rates(&segments, x.len() as i64, ratio, sample_rate);
        let tm = TimeMap::from_rates(&rates, x.len() as i64);
        hybrid::render(&x, &tm, &rates, sample_rate)
    } else {
        let tm = TimeMap::uniform(x.len() as i64, ratio).unwrap();
        let rates = hybrid::uniform_rate_plan(x.len() as i64, ratio);
        hybrid::render(&x, &tm, &rates, sample_rate)
    };

    out.iter().map(|v| *v as f32).collect()
}

/// Summary of an analysis pass, returned as a small JSON object.
#[wasm_bindgen]
pub fn analyze(samples: &[f32], sample_rate: u32) -> String {
    let x = to_f64(samples);
    let track = crate::pitch::track_f0(&x, sample_rate, None);
    let analysis = psola::analyse(&x, sample_rate, Some(&track), None);
    let voiced = track.voiced.iter().filter(|v| **v).count();
    let mut f0s: Vec<f64> = track
        .f0
        .iter()
        .zip(track.voiced.iter())
        .filter(|(_, v)| **v)
        .map(|(f, _)| *f)
        .collect();
    f0s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_f0 = if f0s.is_empty() { 0.0 } else { f0s[f0s.len() / 2] };
    let segments = rate::align_by_energy(&x, sample_rate);
    let speech = segments.iter().filter(|s| s.cls == Class::Speech).count();
    format!(
        "{{\"frames\":{},\"voicedFrames\":{},\"marks\":{},\"medianF0\":{:.3},\"segments\":{},\"speechSegments\":{}}}",
        track.f0.len(),
        voiced,
        analysis.marks.len(),
        median_f0,
        segments.len(),
        speech
    )
}

/// Silence runs longer than `min_silence_s`, as flat `[start, end, ...]` sample
/// positions. Each zone is trimmed by `keep_s` at its end.
///
/// Runs on the `f32` samples directly so enabling skip-silence on a long
/// recording never materialises a full-length `f64` copy.
#[wasm_bindgen]
pub fn silence_zones(
    samples: &[f32],
    sample_rate: u32,
    min_silence_s: f64,
    keep_s: f64,
) -> Vec<f64> {
    rate::silence_zones_f32(samples, sample_rate, min_silence_s, keep_s)
}

/// Offline render with silence longer than `min_silence_s` cut down to a `keep_s`
/// pause, then the rest stretched to `speed`.
///
/// Each kept segment is rendered on its own and concatenated. The joins land at
/// energy minima (that is what "silence" means), so they need no crossfade.
#[wasm_bindgen]
pub fn time_stretch_skip_silence(
    samples: &[f32],
    sample_rate: u32,
    speed: f64,
    class_aware: bool,
    min_silence_s: f64,
    keep_s: f64,
) -> Vec<f32> {
    let x = to_f64(samples);
    if x.len() < 2 {
        return samples.to_vec();
    }
    let ratio = ratio_for_speed(speed);
    let segments = rate::align_by_energy(&x, sample_rate);
    let keep = skip_keep_list(&segments, sample_rate, ratio, class_aware, min_silence_s, keep_s);

    let mut out: Vec<f32> = Vec::new();
    for (start, end, rate) in keep {
        let a = start.max(0) as usize;
        let b = (end.min(x.len() as i64)).max(a as i64) as usize;
        if b <= a {
            continue;
        }
        let rendered = stretch_span(&x[a..b], rate, sample_rate);
        out.extend(rendered.into_iter().map(|v| v as f32));
    }
    out
}

/// A reusable input-to-output position map for one baked render.
///
/// This makes speed-baked clip exports use the same map the audio render uses,
/// including the non-uniform class-aware plan.
#[wasm_bindgen]
pub struct BakedMap {
    map: TimeMap,
}

#[wasm_bindgen]
impl BakedMap {
    #[wasm_bindgen(constructor)]
    pub fn new(samples: &[f32], sample_rate: u32, speed: f64, class_aware: bool) -> BakedMap {
        let x = to_f64(samples);
        let ratio = ratio_for_speed(speed);
        let map = if class_aware {
            let segments = rate::align_by_energy(&x, sample_rate);
            let rates = rate::plan_rates(&segments, x.len() as i64, ratio, sample_rate);
            TimeMap::from_rates(&rates, x.len() as i64)
        } else {
            TimeMap::uniform(x.len() as i64, ratio).unwrap()
        };
        BakedMap { map }
    }

    /// Output sample position for the given input sample position.
    pub fn map_position(&self, position: f64) -> f64 {
        self.map.output_at(position)
    }
}

/// Input-to-output position map matching [`time_stretch_skip_silence`].
///
/// Held as `(src_start, src_end, out_start, out_len)` per kept segment. The
/// output is contiguous across kept segments, so a position inside a skipped gap
/// maps to the shared boundary between its neighbours. Rates come from the same
/// `class_rate` the render uses, so boundaries and audio cannot disagree.
#[wasm_bindgen]
pub struct SkipBakedMap {
    kept: Vec<(i64, i64, f64, f64)>,
    total: f64,
}

#[wasm_bindgen]
impl SkipBakedMap {
    #[wasm_bindgen(constructor)]
    pub fn new(
        samples: &[f32],
        sample_rate: u32,
        speed: f64,
        class_aware: bool,
        min_silence_s: f64,
        keep_s: f64,
    ) -> SkipBakedMap {
        let x = to_f64(samples);
        let ratio = ratio_for_speed(speed);
        let segments = rate::align_by_energy(&x, sample_rate);
        let keep = skip_keep_list(&segments, sample_rate, ratio, class_aware, min_silence_s, keep_s);

        let mut kept = Vec::with_capacity(keep.len());
        let mut out_pos = 0.0f64;
        for (start, end, rate) in keep {
            let src_len = (end - start).max(1);
            let out_len =
                TimeMap::uniform(src_len, rate.clamp(1e-3, 1.0)).unwrap().out_length() as f64;
            kept.push((start, end, out_pos, out_len));
            out_pos += out_len;
        }
        SkipBakedMap { kept, total: out_pos }
    }

    /// Output sample position for the given input sample position.
    pub fn map_position(&self, position: f64) -> f64 {
        for (src_start, src_end, out_start, out_len) in &self.kept {
            let src_start = *src_start as f64;
            let src_end = *src_end as f64;
            if position < src_start {
                // Inside a skipped gap (or before the first kept segment).
                return *out_start;
            }
            if position < src_end {
                let t = (position - src_start) / (src_end - src_start);
                return *out_start + t * *out_len;
            }
        }
        self.total
    }
}

/// Causal, real-time time-scale modification for interactive playback.
#[wasm_bindgen]
pub struct StreamStretcher {
    inner: crate::stream::StreamStretcher,
}

#[wasm_bindgen]
impl StreamStretcher {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: u32, speed: f64) -> StreamStretcher {
        StreamStretcher {
            inner: crate::stream::StreamStretcher::new(sample_rate, speed),
        }
    }

    pub fn set_speed(&mut self, speed: f64) {
        self.inner.set_speed(speed);
    }

    #[wasm_bindgen(getter)]
    pub fn speed(&self) -> f64 {
        self.inner.speed()
    }

    /// Append input samples (mono, at the constructor's sample rate).
    pub fn push(&mut self, samples: &[f32]) {
        self.inner.push(samples);
    }

    /// Take up to `max` rendered output samples.
    pub fn pull(&mut self, max: usize) -> Vec<f32> {
        self.inner.pull(max)
    }

    pub fn available_output(&self) -> usize {
        self.inner.available_output()
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }

    /// Jump the input cursor forward, discarding buffered input (skip a silence).
    pub fn skip_to(&mut self, input_pos: f64) {
        self.inner.skip_to(input_pos);
    }

    /// Signal that no more input will be pushed.
    pub fn finish(&mut self) {
        self.inner.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baked_map_matches_the_uniform_render_ratio() {
        let samples = vec![0.0f32; 16000];
        let map = BakedMap::new(&samples, 16000, 2.0, false);
        assert_eq!(map.map_position(0.0), 0.0);
        assert_eq!(map.map_position(8000.0), 4000.0);
        assert_eq!(map.map_position(16000.0), 8000.0);
    }
}
