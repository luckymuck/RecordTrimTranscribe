//! Fundamental frequency tracking and glottal pitch-mark placement.
//!
//! Ported from `fasttalk/pitch.py`. TD-PSOLA only avoids the phase cancellation
//! that wrecks generic overlap-add when consecutive analysis windows are aligned
//! to glottal closure instants; this module produces those marks. Unvoiced and
//! silent regions produce no marks.

use crate::filters::{
    autocorr, convolve_same, lowpass_kernel, maximum_filter1d_nearest_into, median_filter_nearest,
};

const EPS: f64 = 1e-12;
const LAG_TIE_BREAK: f64 = 0.05;

#[derive(Clone, Copy, Debug)]
pub struct F0Params {
    pub fmin: f64,
    pub fmax: f64,
    pub frame_ms: f64,
    pub hop_ms: f64,
    pub voiced_threshold: f64,
    pub octave_ratio: f64,
    pub pitch_range_hz: f64,
}

impl Default for F0Params {
    fn default() -> Self {
        F0Params {
            fmin: 60.0,
            fmax: 400.0,
            frame_ms: 40.0,
            hop_ms: 10.0,
            voiced_threshold: 0.40,
            octave_ratio: 0.85,
            pitch_range_hz: 900.0,
        }
    }
}

/// Sampled F0 and voicing decision on a uniform grid.
#[derive(Clone, Debug)]
pub struct F0Track {
    pub f0: Vec<f64>,
    pub voiced: Vec<bool>,
    pub hop: usize,
    pub sr: u32,
}

impl F0Track {
    pub fn period_at(&self, sample: i64) -> f64 {
        let n = self.f0.len();
        if n == 0 {
            return self.sr as f64 / 120.0;
        }
        let index = ((sample.max(0) as usize) / self.hop.max(1)).min(n - 1);
        let mut f = self.f0[index];
        if !(f > 0.0) || f.is_nan() {
            let mut usable: Vec<f64> = self
                .f0
                .iter()
                .zip(self.voiced.iter())
                .filter(|(v, voiced)| **voiced && **v > 0.0)
                .map(|(v, _)| *v)
                .collect();
            usable.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            f = if usable.is_empty() {
                120.0
            } else {
                usable[usable.len() / 2]
            };
        }
        if f > 0.0 {
            self.sr as f64 / f
        } else {
            self.sr as f64 / 120.0
        }
    }
}

/// Estimate an F0 track by normalised autocorrelation with octave control.
pub fn track_f0(x: &[f64], sr: u32, params: Option<F0Params>) -> F0Track {
    let params = params.unwrap_or_default();
    let frame = (params.frame_ms * sr as f64 / 1000.0).round() as usize;
    let hop = (params.hop_ms * sr as f64 / 1000.0).round() as usize;
    let lo = (sr as f64 / params.fmax).max(2.0) as usize;
    let hi = ((frame as f64 - 1.0).min(sr as f64 / params.fmin)) as usize;

    if x.len() < frame || hi <= lo || hop == 0 {
        return F0Track {
            f0: Vec::new(),
            voiced: Vec::new(),
            hop,
            sr,
        };
    }

    let n_frames = 1 + (x.len() - frame) / hop;
    let mut f0 = vec![0.0f64; n_frames];
    let mut voiced = vec![false; n_frames];

    let mut size = 1usize;
    while size < frame + hi {
        size <<= 1;
    }

    let mut window = vec![0.0f64; frame];
    // Hoisted out of the frame loop: these were allocated per frame, which is
    // thousands of allocations per second on a hot path (CORE-11).
    let mut cum = vec![0.0f64; frame + 1];
    let mut r = vec![0.0f64; hi + 1];
    let mut band = vec![0.0f64; hi.saturating_sub(lo)];
    let mut local_max = vec![0.0f64; band.len()];
    for f in 0..n_frames {
        let base = f * hop;
        window.copy_from_slice(&x[base..base + frame]);
        let mean = window.iter().sum::<f64>() / frame as f64;
        for v in window.iter_mut() {
            *v -= mean;
        }
        let rms = (window.iter().map(|v| v * v).sum::<f64>() / frame as f64).sqrt();

        let corr = autocorr(&window, size, hi);

        // head[lag] = energy of the first frame-lag samples; tail[lag] = energy of
        // the last frame-lag samples (see fasttalk/pitch.py `_track_block`).
        cum[0] = 0.0;
        for k in 1..=frame {
            cum[k] = cum[k - 1] + window[frame - k] * window[frame - k];
        }
        let total = cum[frame];

        for (lag, value) in r.iter_mut().enumerate().take(hi + 1) {
            let head = total - cum[lag];
            let tail = cum[frame - lag];
            let denom = (head * tail).max(0.0) + EPS;
            *value = corr[lag] / denom.sqrt();
        }

        band.copy_from_slice(&r[lo..hi]);
        let band_max = band.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let threshold = params.octave_ratio * band_max;
        maximum_filter1d_nearest_into(&band, 3, &mut local_max);

        let mut chosen: Option<usize> = None;
        for i in 0..band.len() {
            if (band[i] - local_max[i]).abs() < f64::EPSILON && band[i] >= threshold {
                chosen = Some(i + lo);
                break;
            }
        }
        let mut argmax_band = 0usize;
        for i in 1..band.len() {
            if band[i] > band[argmax_band] {
                argmax_band = i;
            }
        }
        let lag = chosen.unwrap_or(argmax_band + lo);

        let peak = r[lag];
        let ok = rms > 1e-4 && peak >= params.voiced_threshold && peak.is_finite();

        voiced[f] = ok;
        if ok {
            // Parabolic refinement of the lag.
            let l = lag as f64;
            let denom = r[lag - 1] - 2.0 * r[lag] + r[lag + 1];
            let refined = l + 0.5 * (r[lag - 1] - r[lag + 1]) / (denom + EPS);
            let settled = if refined.is_finite() && refined >= lo as f64 && refined <= hi as f64 {
                refined
            } else {
                l
            };
            let val = sr as f64 / settled;
            if val.is_finite() && val > 0.0 {
                f0[f] = val;
            } else {
                voiced[f] = false;
            }
        }
    }

    if voiced.iter().any(|v| *v) {
        f0 = fill_unvoiced(&f0, &voiced);
        f0 = median_filter_nearest(&f0, 5);
    }

    F0Track {
        f0,
        voiced,
        hop,
        sr,
    }
}

/// Interpolate F0 log-linearly across unvoiced gaps.
fn fill_unvoiced(f0: &[f64], voiced: &[bool]) -> Vec<f64> {
    let n = f0.len();
    if !voiced.iter().any(|v| *v) {
        return f0.to_vec();
    }
    let idx_voiced: Vec<usize> = (0..n).filter(|&i| voiced[i]).collect();
    let log_voiced: Vec<f64> = idx_voiced.iter().map(|&i| (f0[i] + EPS).ln()).collect();
    (0..n)
        .map(|i| {
            let v = linear_interp(i as f64, &idx_voiced, &log_voiced);
            v.exp()
        })
        .collect()
}

fn linear_interp(q: f64, xp: &[usize], fp: &[f64]) -> f64 {
    let n = xp.len();
    if n == 0 {
        return 0.0;
    }
    if q <= xp[0] as f64 {
        return fp[0];
    }
    if q >= xp[n - 1] as f64 {
        return fp[n - 1];
    }
    let mut lo = 0usize;
    let mut hi = n - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if xp[mid] as f64 <= q {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let span = (xp[hi] - xp[lo]) as f64;
    if span <= 0.0 {
        return fp[lo];
    }
    let t = (q - xp[lo] as f64) / span;
    fp[lo] + t * (fp[hi] - fp[lo])
}

/// Locate glottal closure instants as phase-aligned mark positions.
pub fn pitch_marks(x: &[f64], sr: u32, track: &F0Track, pitch_range_hz: f64) -> Vec<i64> {
    let n_frames = track.f0.len();
    if n_frames == 0 || x.is_empty() {
        return Vec::new();
    }

    // A windowed-sinc's transition width is about 3.3*fs/N taps, so a fixed
    // 129 taps gives a ~410 Hz transition at 16 kHz but ~1.2 kHz at 48 kHz --
    // the band the marks are picked from gets smeared at higher rates. Scale
    // the tap count with the rate to hold the transition width constant.
    let taps = (((129.0 * sr as f64) / 16000.0).round() as usize).max(33) | 1;
    let low = convolve_same(x, &lowpass_kernel(sr, pitch_range_hz, taps));
    let voiced = &track.voiced;
    let limit = (low.len() - 1) as i64;
    let max_marks = n_frames * 40;

    let mut marks: Vec<i64> = Vec::new();
    let mut frame = 0usize;
    while frame < n_frames && marks.len() < max_marks {
        if !voiced[frame] {
            frame += 1;
            continue;
        }
        let period = track.period_at((frame * track.hop) as i64);
        let centre = (frame * track.hop) as i64;
        let reach = (0.5 * period) as i64;
        let lo = (centre - reach).max(0);
        let hi = (centre + reach + 1).min(low.len() as i64);
        if hi <= lo {
            frame += 1;
            continue;
        }
        // Dominant polarity of this voiced run (CORE-6). A glottal pulse train
        // is asymmetric, so the sign of the third moment of the low-passed
        // signal says which way its pulses point. Picking `argmax |low|` let the
        // choice flip between runs, which moves the mark half a period and can
        // shift the segment's phase.
        let run_end = (frame..n_frames).find(|&f| !voiced[f]).unwrap_or(n_frames);
        let run_lo = (frame * track.hop) as i64;
        let run_hi = ((run_end * track.hop) as i64).min(low.len() as i64);
        let mut skew = 0.0f64;
        for i in run_lo..run_hi.max(run_lo + 1) {
            let v = low[i as usize];
            skew += v * v * v;
        }
        let positive = skew >= 0.0;
        // Most positive (or most negative) sample in the window, not the largest
        // magnitude.
        let mut best = lo;
        let mut best_val = f64::NEG_INFINITY;
        for i in lo..hi {
            let v = if positive { low[i as usize] } else { -low[i as usize] };
            if v > best_val {
                best_val = v;
                best = i;
            }
        }
        let mut mark = best;
        let mut span = frame;

        while marks.len() < max_marks {
            if mark >= limit {
                break;
            }
            marks.push(mark);
            let period = track.period_at(mark);
            let target = mark + period.round() as i64;
            if target >= limit {
                span = ((mark / track.hop as i64) as usize).min(n_frames - 1);
                break;
            }
            span = ((target / track.hop as i64) as usize).min(n_frames - 1).max(0);
            if !voiced[span] {
                break;
            }
            let lag = best_glottal_lag(&low, mark, target, (0.3 * period).max(1.0) as i64, 2);
            mark = (target + lag).max(mark + 1).min(limit);
        }
        frame = span + 1;
    }

    if marks.len() < 2 {
        return Vec::new();
    }
    // Dedupe identical positions (marks are strictly increasing by construction).
    let mut unique: Vec<i64> = Vec::with_capacity(marks.len());
    for m in marks {
        if unique.last().map_or(true, |&p| m > p) {
            unique.push(m);
        }
    }
    unique
}

/// Lag in `[-reach, reach]` aligning a candidate window with the previous period.
fn best_glottal_lag(low: &[f64], previous: i64, target: i64, reach: i64, _lo: usize) -> i64 {
    if reach < 1 {
        return 0;
    }
    let width = (2 * reach + 1) as usize;
    let tstart = (previous - reach).max(0) as usize;
    if tstart + width > low.len() {
        return 0;
    }
    let template = &low[tstart..tstart + width];
    if template.len() < 3 {
        return 0;
    }
    let start = (target - 2 * reach).max(0) as usize;
    let stop = (start + (4 * reach + 1) as usize).min(low.len());
    let region = &low[start..stop];
    if region.len() < width {
        return 0;
    }
    // np.correlate(region, template, mode="valid").
    let out_len = region.len() - width + 1;
    let mut corr = vec![0.0f64; out_len];
    for (i, c) in corr.iter_mut().enumerate() {
        let mut s = 0.0;
        for k in 0..width {
            s += region[i + k] * template[k];
        }
        *c = s;
    }
    if corr.is_empty() {
        return 0;
    }
    let cmax = corr.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let span = reach as f64;
    for (i, c) in corr.iter_mut().enumerate() {
        let lags = i as f64 - reach as f64;
        let weight = if span > 0.0 { lags.abs() / span } else { 0.0 };
        *c -= LAG_TIE_BREAK * cmax * weight;
    }
    let mut best = 0usize;
    for i in 1..corr.len() {
        if corr[i] > corr[best] {
            best = i;
        }
    }
    (best as i64 - reach).clamp(-reach, reach)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steady_tone(f0: f64, seconds: f64, sr: u32) -> Vec<f64> {
        let n = (seconds * sr as f64) as usize;
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * f0 * i as f64 / sr as f64).sin())
            .collect()
    }

    #[test]
    fn f0_tracker_recovers_a_known_tone() {
        let sr = 16000;
        for expected in [110.0, 150.0, 220.0] {
            let x = steady_tone(expected, 2.0, sr);
            let track = track_f0(&x, sr, None);
            let mut voiced: Vec<f64> = track
                .f0
                .iter()
                .zip(track.voiced.iter())
                .filter(|(_, v)| **v)
                .map(|(f, _)| *f)
                .collect();
            assert!(voiced.len() > 20, "too few voiced frames");
            voiced.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let median = voiced[voiced.len() / 2];
            assert!(
                (median - expected).abs() / expected < 0.02,
                "expected {expected}, got {median}"
            );
        }
    }

    #[test]
    fn f0_tracker_reports_no_voicing_for_silence() {
        let sr = 16000;
        let track = track_f0(&vec![0.0; sr as usize], sr, None);
        assert!(!track.voiced.iter().any(|v| *v));
    }

    #[test]
    fn pitch_marks_land_on_glottal_pulses() {
        let sr = 16000;
        let x = steady_tone(200.0, 2.0, sr);
        let track = track_f0(&x, sr, None);
        let marks = pitch_marks(&x, sr, &track, 900.0);
        assert!(marks.len() > 100, "only {} marks", marks.len());
        let mut spacing: Vec<f64> = marks.windows(2).map(|w| (w[1] - w[0]) as f64).collect();
        spacing.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = spacing[spacing.len() / 2];
        assert!((median - sr as f64 / 200.0).abs() < 4.0, "median {median}");
    }
}
