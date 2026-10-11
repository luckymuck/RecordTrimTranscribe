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

/// Per-signal analysis shared by every span of one render.
///
/// The padding, energy and norm passes are O(input) each, so doing them once and
/// rendering several spans from the result is what makes a span-limited render
/// cheaper than a full pass rather than more expensive (CORE-9).
pub struct WsolaSetup {
    padded: Vec<f64>,
    norms: Vec<f64>,
    template_norm: f64,
    frame: usize,
    synthesis_hop: usize,
    analysis_hop: f64,
    max_dev: i64,
    template_len: usize,
    corr_step: usize,
    offsets: Vec<i64>,
    distance_slope: f64,
    last_in: f64,
    total_frames: usize,
    identity: bool,
    out_length: usize,
    n_windows: usize,
    /// Set when the signal is too short to window; the whole render is then a
    /// linear resize of the input.
    degenerate: Option<Vec<f64>>,
}

impl WsolaSetup {
    pub fn new(x: &[f64], time_map: &TimeMap, sr: u32, params: Option<WsolaParams>) -> Self {
        let params = params.unwrap_or_default();
        let out_length = time_map.out_length().max(0) as usize;
        let in_length = x.len().min(time_map.in_length.max(0) as usize);
        let frame = ((params.frame_ms * sr as f64 / 1000.0).round() as usize).max(2);

        let mut setup = WsolaSetup {
            padded: Vec::new(),
            norms: Vec::new(),
            template_norm: EPS,
            frame,
            synthesis_hop: 1,
            analysis_hop: 1.0,
            max_dev: 1,
            template_len: 1,
            corr_step: 1,
            offsets: Vec::new(),
            distance_slope: 0.0,
            last_in: 0.0,
            total_frames: 1,
            identity: false,
            out_length,
            n_windows: 0,
            degenerate: None,
        };

        if in_length == 0 {
            setup.degenerate = Some(vec![0.0; out_length]);
            return setup;
        }
        if frame >= in_length {
            setup.degenerate = Some(resize_linear(&x[..in_length], out_length));
            return setup;
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

        setup.padded = padded;
        setup.norms = norms;
        setup.template_norm = template_norm;
        setup.synthesis_hop = synthesis_hop;
        setup.analysis_hop = analysis_hop;
        setup.max_dev = max_dev;
        setup.template_len = template_len;
        setup.corr_step = corr_step;
        setup.offsets = offsets;
        setup.distance_slope = params.tie_break / max_dev as f64;
        setup.last_in = (n_windows as f64 - 1.0) - frame as f64;
        setup.total_frames = ((out_length as f64 / synthesis_hop as f64).ceil() as usize).max(1);
        setup.identity = (time_map.ratio() - 1.0).abs() < 1e-9;
        setup.n_windows = n_windows;
        setup
    }

    /// Render output samples `[out_lo, out_hi)`.
    ///
    /// The synthesis grid is `n * synthesis_hop` in absolute output coordinates
    /// and each window's source position is chosen from the time map alone --
    /// nothing depends on the previous window's choice -- so a span lines up
    /// with the corresponding part of a full render. Only the overlap-add
    /// normalisation right at the span edges differs, where fewer windows
    /// overlap; callers use the result only where the PSOLA engine does not own
    /// the signal, so that difference is masked by the blend weight.
    pub fn render_span(&self, time_map: &TimeMap, out_lo: usize, out_hi: usize) -> Vec<f64> {
        let lo = out_lo.min(self.out_length);
        let hi = out_hi.min(self.out_length).max(lo);
        let span = hi - lo;

        if let Some(full) = &self.degenerate {
            return full[lo..hi].to_vec();
        }

        let frame = self.frame;
        let synthesis_hop = self.synthesis_hop;
        let mut accumulator = vec![0.0f64; span + frame + synthesis_hop];
        let mut envelope = vec![0.0f64; span + frame + synthesis_hop];
        let window = hann(frame);
        let mut walker = MapWalker::new(time_map);

        // Windows whose support reaches into the span. One before `lo` writes
        // only its tail; one at or past `hi` writes nothing.
        let first_n = lo.saturating_sub(frame) / synthesis_hop;
        let last_n = ((hi + synthesis_hop - 1) / synthesis_hop).min(self.total_frames);

        for n in first_n..last_n {
            let out_pos = n * synthesis_hop;
            let chosen: f64;

            if n == 0 || self.identity || self.analysis_hop < 1.0 {
                chosen = walker.at(out_pos as f64).clamp(0.0, self.last_in);
            } else {
                let reference = (walker.at(out_pos as f64 - synthesis_hop as f64)
                    + self.analysis_hop)
                    .clamp(0.0, self.last_in);
                let mut low_idx =
                    ((reference - self.max_dev as f64) / self.corr_step as f64).floor() as i64;
                let mut high_idx =
                    ((reference + self.max_dev as f64) / self.corr_step as f64) as i64;
                low_idx = low_idx.clamp(0, self.offsets.len() as i64 - 1);
                high_idx = high_idx.clamp(0, self.offsets.len() as i64 - 1);
                if high_idx <= low_idx {
                    chosen = reference;
                } else {
                    let lo_i = low_idx as usize;
                    let hi_i = high_idx as usize;
                    let centre = (reference as i64).clamp(0, self.n_windows as i64 - 1) as usize;
                    let template = &self.padded[centre..centre + self.template_len];
                    let mut best = lo_i;
                    let mut best_score = f64::NEG_INFINITY;
                    for i in lo_i..=hi_i {
                        let cand = self.offsets[i] * self.corr_step as i64;
                        let p = (reference as i64 + cand).clamp(0, self.n_windows as i64 - 1)
                            as usize;
                        let mut score = 0.0f64;
                        for k in 0..self.template_len {
                            score += self.padded[p + k] * template[k];
                        }
                        let scale = self.norms[p] * self.template_norm;
                        if scale > EPS {
                            score = score / scale
                                - self.distance_slope * (self.offsets[i].abs() as f64);
                            if score > best_score {
                                best_score = score;
                                best = i;
                            }
                        }
                    }
                    if best_score == f64::NEG_INFINITY {
                        chosen = reference;
                    } else {
                        let cand = self.offsets[best] * self.corr_step as i64;
                        chosen = (reference as i64 + cand).clamp(0, self.last_in as i64) as f64;
                    }
                }
            }

            let start = chosen.round() as i64 + frame as i64;
            if start < 0 {
                continue;
            }
            let start = start as usize;
            let avail = (self.padded.len() - start).min(frame);
            // Skip the part of the window that falls before the span.
            let k_start = lo.saturating_sub(out_pos);
            for k in k_start..avail {
                let idx = out_pos + k - lo;
                if idx >= accumulator.len() {
                    break;
                }
                accumulator[idx] += window[k] * self.padded[start + k];
                envelope[idx] += window[k];
            }
        }

        let mut out = vec![0.0f64; span];
        for i in 0..span {
            if envelope[i] > EPS {
                out[i] = accumulator[i] / envelope[i];
            }
        }
        out
    }
}

/// Render `x` into the time domain described by `time_map`.
pub fn render(x: &[f64], time_map: &TimeMap, sr: u32, params: Option<WsolaParams>) -> Vec<f64> {
    let out_length = time_map.out_length().max(0) as usize;
    WsolaSetup::new(x, time_map, sr, params).render_span(time_map, 0, out_length)
}

/// Render only output samples `[out_lo, out_hi)`, without a shared setup.
///
/// Prefer [`WsolaSetup::render_span`] when rendering more than one span of the
/// same signal: the setup is O(input) and would otherwise be repeated.
pub fn render_range(
    x: &[f64],
    time_map: &TimeMap,
    sr: u32,
    params: Option<WsolaParams>,
    out_lo: usize,
    out_hi: usize,
) -> Vec<f64> {
    WsolaSetup::new(x, time_map, sr, params).render_span(time_map, out_lo, out_hi)
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
