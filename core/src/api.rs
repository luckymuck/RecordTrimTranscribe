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
use crate::enhance;
use crate::rate;
use crate::timing::TimeMap;

fn to_f64(samples: &[f32]) -> Vec<f64> {
    samples.iter().map(|v| *v as f64).collect()
}

fn to_f32(samples: Vec<f64>) -> Vec<f32> {
    samples.into_iter().map(|v| v as f32).collect()
}

/// Ratio (`out/in`) for a requested speed-up (`speed >= 1` means faster).
fn ratio_for_speed(speed: f64) -> f64 {
    (1.0 / speed.max(1e-3)).clamp(1e-3, 1.0)
}

/// The rate a class is rendered at for a global scale `k`, mirroring
/// `rate::plan_rates` exactly.
///
/// Skip-silence derives both the rendered audio and its position map from this
/// one function so the two cannot drift apart: a map built on a different rate
/// than the render silently shifts every clip boundary.
fn class_rate(cls: Class, scale: f64) -> f64 {
    let profile = profile_for(cls);
    (scale * profile.multiplier).clamp(profile.floor, 1.0)
}

/// Solve the global rate scale so a class-aware plan renders `ratio` overall.
///
/// `class_rate` floors each class (speech at 0.45), so feeding it the plain
/// target ratio cannot reach the dial at high speed -- speech caps at about
/// 2.2x no matter what. A single global scale `k` is solved so the summed output
/// matches the target, and every class rate is then derived from that `k`.
fn solve_scale(
    segments: &[crate::timing::Segment],
    in_length: i64,
    ratio: f64,
    sr: u32,
) -> f64 {
    let target = (in_length as f64 * ratio).max(1.0);
    let total = |k: f64| -> f64 {
        rate::plan_rates(segments, in_length, k, sr)
            .iter()
            .map(|r| r.out_duration() as f64)
            .sum()
    };
    let (mut lo, mut hi) = (1e-4f64, 1.0f64);
    let mut guard = 0;
    while total(hi) < target && guard < 64 {
        hi *= 2.0;
        guard += 1;
    }
    for _ in 0..48 {
        let mid = 0.5 * (lo + hi);
        if total(mid) > target {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    hi
}

/// Join pieces with a short overlap crossfade. Without it the splice between the
/// kept head and the kept tail of a gap is a step, heard as a click.
const SKIP_CROSSFADE_S: f64 = 0.005;

/// Overlap-crossfade length in render output samples.
fn crossfade_samples(sr: u32) -> usize {
    (SKIP_CROSSFADE_S * sr as f64) as usize
}

/// Append `rendered` to `out`, crossfading its first `xf` samples with the tail
/// of `out` already there. Returns how many samples were absorbed by the
/// crossfade, so the caller's position map can track the shortened output.
fn append_crossfaded(out: &mut Vec<f32>, rendered: &[f64], xf: usize) -> usize {
    if rendered.is_empty() {
        return 0;
    }
    let overlap = xf.min(out.len()).min(rendered.len());
    let tail = out.len() - overlap;
    for i in 0..overlap {
        let t = (i + 1) as f32 / (overlap + 1) as f32;
        let prev = out[tail + i];
        out[tail + i] = prev * (1.0 - t) + rendered[i] as f32 * t;
    }
    out.extend(rendered[overlap..].iter().map(|v| *v as f32));
    overlap
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
    scale: f64,
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
            // The kept pause is rendered at the plain target ratio, so its
            // length follows the speed dial exactly (the 0.1 s floor is applied
            // in the client). It is a pause, not speech to be compressed.
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
            class_rate(seg.cls, scale)
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
    let tm = TimeMap::uniform(x.len() as i64, rate).unwrap_or_else(|_| TimeMap::identity(x.len() as i64));
    let rates = hybrid::uniform_rate_plan(x.len() as i64, rate);
    hybrid::render(x, &tm, &rates, sr)
}

/// Offline render block size (seconds). Rendering a whole file at once keeps
/// roughly eight to ten full-length `f64` arrays resident, which exceeds WASM
/// memory well before an hour of audio. Blocks keep only a window alive.
const RENDER_BLOCK_S: f64 = 30.0;
/// Input overlap between blocks (seconds). The seam is crossfaded across the
/// whole overlap, since the later block reproduces it with more right context.
const RENDER_OVERLAP_S: f64 = 0.5;

/// The `rates` restricted to `[a, b)`, rebased to zero.
fn slice_rates(rates: &[crate::timing::SegmentRate], a: i64, b: i64) -> Vec<crate::timing::SegmentRate> {
    let mut local = Vec::new();
    for r in rates {
        let start = r.start.max(a);
        let end = r.end.min(b);
        if end <= start {
            continue;
        }
        local.push(crate::timing::SegmentRate {
            start: start - a,
            end: end - a,
            rate: r.rate,
            mode: r.mode,
            cls: r.cls,
            label: r.label.clone(),
            head: r.head,
        });
    }
    local
}

/// Crossfade `rendered` onto `out` over `xf` samples (f64 variant).
fn append_crossfaded_f64(out: &mut Vec<f64>, rendered: &[f64], xf: usize) {
    if rendered.is_empty() {
        return;
    }
    let overlap = xf.min(out.len()).min(rendered.len());
    let tail = out.len() - overlap;
    for i in 0..overlap {
        let t = (i + 1) as f64 / (overlap + 1) as f64;
        out[tail + i] = out[tail + i] * (1.0 - t) + rendered[i] * t;
    }
    out.extend_from_slice(&rendered[overlap..]);
}

/// Render `x` with `rates` in blocks, crossfading each seam.
fn render_blocks(x: &[f64], rates: &[crate::timing::SegmentRate], sr: u32) -> Vec<f64> {
    let len = x.len() as i64;
    let block = (RENDER_BLOCK_S * sr as f64) as i64;
    if len <= block {
        let tm = TimeMap::from_rates(rates, len);
        return hybrid::render(x, &tm, rates, sr);
    }
    let overlap = ((RENDER_OVERLAP_S * sr as f64) as i64).max(1);
    let mut out: Vec<f64> = Vec::new();
    let mut a = 0i64;
    while a < len {
        let b = (a + block).min(len);
        let local = slice_rates(rates, a, b);
        let tm = TimeMap::from_rates(&local, b - a);
        let rendered = hybrid::render(&x[a as usize..b as usize], &tm, &local, sr);
        let xf = if out.is_empty() {
            0
        } else {
            ((overlap as f64) * tm.ratio()).round() as usize
        };
        append_crossfaded_f64(&mut out, &rendered, xf);
        if b >= len {
            break;
        }
        a = b - overlap;
    }
    out
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
        let scale = solve_scale(&segments, x.len() as i64, ratio, sample_rate);
        let rates = rate::plan_rates(&segments, x.len() as i64, scale, sample_rate);
        render_blocks(&x, &rates, sample_rate)
    } else {
        let rates = hybrid::uniform_rate_plan(x.len() as i64, ratio);
        render_blocks(&x, &rates, sample_rate)
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
/// positions. Boundaries are the raw detected silence edges; the caller insets
/// them by the speed-dependent keep.
///
/// Runs on the `f32` samples directly so enabling skip-silence on a long
/// recording never materialises a full-length `f64` copy.
#[wasm_bindgen]
pub fn silence_zones(samples: &[f32], sample_rate: u32, min_silence_s: f64) -> Vec<f64> {
    rate::silence_zones_f32(samples, sample_rate, min_silence_s)
}

/// Rumble/hum high-pass, applied to the source before stretching (S-5).
#[wasm_bindgen]
pub fn highpass(samples: &[f32], sample_rate: u32, cutoff_hz: f64) -> Vec<f32> {
    to_f32(enhance::highpass(&to_f64(samples), sample_rate, cutoff_hz))
}

/// Consonant boost: a high-shelf above `corner_hz` plus light high-band
/// compression (S-4). `amount` (0..1) scales the compression.
#[wasm_bindgen]
pub fn consonant_boost(
    samples: &[f32],
    sample_rate: u32,
    corner_hz: f64,
    gain_db: f64,
    amount: f64,
) -> Vec<f32> {
    to_f32(enhance::consonant_boost(
        &to_f64(samples),
        sample_rate,
        corner_hz,
        gain_db,
        amount,
    ))
}

/// Soft limiter to `ceiling_db` (S-13).
#[wasm_bindgen]
pub fn soft_limiter(samples: &[f32], sample_rate: u32, ceiling_db: f64) -> Vec<f32> {
    to_f32(enhance::soft_limiter(&to_f64(samples), sample_rate, ceiling_db))
}

/// Offline render with silence longer than `min_silence_s` cut down to a `keep_s`
/// pause, then the rest stretched to `speed`.
///
/// Each kept segment is rendered on its own and concatenated. The joins land at
/// energy minima (that is what "silence" means), so no long crossfade is needed;
/// a short one (5 ms) is applied anyway so the seam cannot step.
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
    let scale = if class_aware {
        solve_scale(&segments, x.len() as i64, ratio, sample_rate)
    } else {
        ratio
    };
    let keep = skip_keep_list(
        &segments,
        sample_rate,
        scale,
        ratio,
        class_aware,
        min_silence_s,
        keep_s,
    );

    let mut out: Vec<f32> = Vec::new();
    let xf = crossfade_samples(sample_rate);
    for (start, end, rate) in keep {
        let a = start.max(0) as usize;
        let b = (end.min(x.len() as i64)).max(a as i64) as usize;
        if b <= a {
            continue;
        }
        let rendered = stretch_span(&x[a..b], rate, sample_rate);
        append_crossfaded(&mut out, &rendered, xf);
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
        let ratio = ratio_for_speed(speed);
        let n = samples.len() as i64;
        let map = if class_aware {
            // Only the segments are needed here, so segment the f32 samples
            // directly rather than copying the whole recording to f64 (DS-5).
            let segments = rate::align_by_energy_f32(samples, sample_rate);
            let scale = solve_scale(&segments, n, ratio, sample_rate);
            let rates = rate::plan_rates(&segments, n, scale, sample_rate);
            TimeMap::from_rates(&rates, n)
        } else {
            TimeMap::uniform(n, ratio).unwrap_or_else(|_| TimeMap::identity(n))
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
        let ratio = ratio_for_speed(speed);
        let n = samples.len() as i64;
        // Only the segments are needed here (DS-5).
        let segments = rate::align_by_energy_f32(samples, sample_rate);
        let scale = if class_aware {
            solve_scale(&segments, n, ratio, sample_rate)
        } else {
            ratio
        };
        let keep = skip_keep_list(
            &segments,
            sample_rate,
            scale,
            ratio,
            class_aware,
            min_silence_s,
            keep_s,
        );

        let mut kept = Vec::with_capacity(keep.len());
        let mut out_pos = 0.0f64;
        let xf = crossfade_samples(sample_rate);
        let mut first = true;
        for (start, end, rate) in keep {
            let src_len = (end - start).max(1);
            let out_len =
                TimeMap::uniform(src_len, rate.clamp(1e-3, 1.0)).unwrap_or_else(|_| TimeMap::identity(src_len)).out_length() as f64;
            // The render overlap-crossfades each join, absorbing up to `xf`
            // samples of this piece into the previous one's tail.
            let overlap = if first {
                0.0
            } else {
                (xf as f64).min(out_pos).min(out_len)
            };
            out_pos -= overlap;
            kept.push((start, end, out_pos, out_len));
            out_pos += out_len;
            first = false;
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
