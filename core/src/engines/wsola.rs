//! Waveform-similarity overlap-add with an arbitrary time map.
//!
//! Ported from `fasttalk/engines/wsola.py` (Verhelst & Roelands 2003 / Driedger &
//! Muller DAFx-14). Used for unvoiced material, where there is no periodicity to
//! preserve and overlap-add is adequate.

use crate::filters::{hann, resize_linear, uniform_filter1d_nearest};
use crate::timing::{MapWalker, TimeMap};

const EPS: f64 = 1e-12;

#[derive(Clone, Copy, Debug)]
pub struct WsolaParams {
    pub frame_ms: f64,
    pub search_ms: f64,
    pub corr_step: usize,
    pub template_ms: f64,
    pub tie_break: f64,
}

impl Default for WsolaParams {
    fn default() -> Self {
        WsolaParams {
            frame_ms: 32.0,
            search_ms: 3.0,
            corr_step: 1,
            template_ms: 15.0,
            tie_break: 0.05,
        }
    }
}

/// Choose synthesis and analysis hops so the input is read contiguously.
pub fn plan_overlaps(frame: usize, ratio: f64) -> (usize, f64) {
    assert!(frame >= 2);
    let ratio = ratio.clamp(1e-3, 1.0);
    let mut divisions = 2usize;
    while (divisions as f64) * ratio < 1.0 && divisions < 64 {
        divisions *= 2;
    }
    let synthesis_hop = (frame / divisions).max(1);
    (synthesis_hop, synthesis_hop as f64 / ratio)
}

/// Render `x` into the time domain described by `time_map`.
pub fn render(x: &[f64], time_map: &TimeMap, sr: u32, params: Option<WsolaParams>) -> Vec<f64> {
    let params = params.unwrap_or_default();
    let in_length = x.len().min(time_map.in_length.max(0) as usize);
    if in_length == 0 {
        return vec![0.0; time_map.out_length().max(0) as usize];
    }

    let frame = ((params.frame_ms * sr as f64 / 1000.0).round() as usize).max(2);
    if frame >= in_length {
        return resize_linear(&x[..in_length], time_map.out_length().max(0) as usize);
    }

    let (synthesis_hop, analysis_hop) = plan_overlaps(frame, time_map.ratio());
    let max_dev = ((params.search_ms * sr as f64 / 1000.0).round() as i64).max(1);
    let template_len = ((params.template_ms * sr as f64 / 1000.0).round() as usize)
        .max(1)
        .min(frame);
    let corr_step = params.corr_step.max(1);

    // Pad both ends by replicating the edge sample.
    let mut padded = vec![0.0f64; in_length + 2 * frame];
    for i in 0..frame {
        padded[i] = x[0];
        padded[in_length + frame + i] = x[in_length - 1];
    }
    padded[frame..frame + in_length].copy_from_slice(&x[..in_length]);

    let n_windows = padded.len() - frame + 1;
    let energy = uniform_filter1d_nearest(
        &padded.iter().map(|v| v * v).collect::<Vec<_>>(),
        frame,
    );
    let norms: Vec<f64> = (0..n_windows)
        .map(|i| energy[i].max(0.0).sqrt())
        .collect();

    let out_length = time_map.out_length().max(0) as usize;
    let mut accumulator = vec![0.0f64; out_length + frame + synthesis_hop];
    let mut envelope = vec![0.0f64; out_length + frame + synthesis_hop];
    let window = hann(frame);
    let template_norm: f64 = padded[frame..frame + template_len]
        .iter()
        .map(|v| v * v)
        .sum::<f64>()
        .sqrt()
        + EPS;

    let mut offsets: Vec<i64> = Vec::new();
    let mut o = -max_dev;
    while o <= max_dev {
        offsets.push(o);
        o += corr_step as i64;
    }
    let n_offsets = offsets.len();
    let mut walker = MapWalker::new(time_map);
    let distance_slope = params.tie_break / max_dev as f64;

    let last_in = (n_windows as f64 - 1.0) - frame as f64;
    let n_frames = ((out_length as f64 / synthesis_hop as f64).ceil() as usize).max(1);
    let identity = (time_map.ratio() - 1.0).abs() < 1e-9;

    for n in 0..n_frames {
        let out_pos = n * synthesis_hop;
        let chosen: f64;

        if n == 0 || identity || analysis_hop < 1.0 {
            chosen = walker.at(out_pos as f64).clamp(0.0, last_in);
        } else {
            let reference = (walker.at(out_pos as f64 - synthesis_hop as f64) + analysis_hop)
                .clamp(0.0, last_in);
            let mut low_idx = ((reference - max_dev as f64) / corr_step as f64).floor() as i64;
            let mut high_idx = ((reference + max_dev as f64) / corr_step as f64) as i64;
            low_idx = low_idx.clamp(0, n_offsets as i64 - 1);
            high_idx = high_idx.clamp(0, n_offsets as i64 - 1);
            if high_idx <= low_idx {
                chosen = reference;
            } else {
                let lo = low_idx as usize;
                let hi = high_idx as usize;
                let centre = (reference as i64).clamp(0, n_windows as i64 - 1) as usize;
                let template = &padded[centre..centre + template_len];
                let mut best = lo;
                let mut best_score = f64::NEG_INFINITY;
                for i in lo..=hi {
                    let cand = offsets[i] * corr_step as i64;
                    let p = (reference as i64 + cand).clamp(0, n_windows as i64 - 1) as usize;
                    let mut score = 0.0f64;
                    for k in 0..template_len {
                        score += padded[p + k] * template[k];
                    }
                    let scale = norms[p] * template_norm;
                    if scale > EPS {
                        score = score / scale - distance_slope * (offsets[i].abs() as f64);
                        if score > best_score {
                            best_score = score;
                            best = i;
                        }
                    }
                }
                if best_score == f64::NEG_INFINITY {
                    chosen = reference;
                } else {
                    let cand = offsets[best] * corr_step as i64;
                    chosen = (reference as i64 + cand).clamp(0, last_in as i64) as f64;
                }
            }
        }

        let start = chosen.round() as i64 + frame as i64;
        if start < 0 {
            continue;
        }
        let start = start as usize;
        let avail = (padded.len() - start).min(frame);
        for k in 0..avail {
            accumulator[out_pos + k] += window[k] * padded[start + k];
            envelope[out_pos + k] += window[k];
        }
    }

    let mut out = vec![0.0f64; accumulator.len()];
    for i in 0..accumulator.len() {
        if envelope[i] > EPS {
            out[i] = accumulator[i] / envelope[i];
        }
    }
    out.truncate(out_length);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timing::TimeMap;

    fn steady_tone(f0: f64, seconds: f64, sr: u32) -> Vec<f64> {
        let n = (seconds * sr as f64) as usize;
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * f0 * i as f64 / sr as f64).sin())
            .collect()
    }

    #[test]
    fn wsola_is_exact_identity_at_ratio_one() {
        let sr = 16000;
        let x = steady_tone(140.0, 1.0, sr);
        let tm = TimeMap::uniform(x.len() as i64, 1.0).unwrap();
        let y = render(&x, &tm, sr, None);
        assert_eq!(y.len(), x.len());
        let mut max_diff = 0.0f64;
        for i in 8..y.len() - 8 {
            max_diff = max_diff.max((y[i] - x[i]).abs());
        }
        assert!(max_diff < 1e-9, "max diff {max_diff}");
    }

    #[test]
    fn output_length_matches_the_time_map() {
        let sr = 16000;
        let x = steady_tone(140.0, 1.5, sr);
        for ratio in [0.5, 0.75] {
            let tm = TimeMap::uniform(x.len() as i64, ratio).unwrap();
            let y = render(&x, &tm, sr, None);
            assert_eq!(y.len(), tm.out_length() as usize);
        }
    }

    #[test]
    fn overlaps_keep_the_input_contiguous() {
        for ratio in [1.0, 0.9, 0.5, 0.43, 0.3, 0.2] {
            let (sh, ah) = plan_overlaps(512, ratio);
            assert!(ah <= 512.0 + 1e-9);
            assert!(sh >= 1);
        }
    }
}
