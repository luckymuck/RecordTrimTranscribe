//! Time-domain pitch-synchronous overlap-add with an arbitrary time map.
//!
//! Ported from `fasttalk/engines/psola.py`. Analysis is global: pitch marks are a
//! property of the whole signal, and callers render spans of it, with all positions
//! staying in global coordinates.

use crate::filters::hann;
use crate::pitch::{pitch_marks, track_f0, F0Track};
use crate::timing::{MapWalker, TimeMap};

const EPS: f64 = 1e-12;

#[derive(Clone, Copy, Debug)]
pub struct PsolaParams {
    pub window_periods: f64,
    pub mark_window_hz: f64,
}

impl Default for PsolaParams {
    fn default() -> Self {
        PsolaParams {
            window_periods: 2.0,
            mark_window_hz: 900.0,
        }
    }
}

/// Glottal marks in global input coordinates, with their local periods.
#[derive(Clone, Debug)]
pub struct PsolaAnalysis {
    pub marks: Vec<i64>,
    pub periods: Vec<f64>,
    pub sr: u32,
}

impl PsolaAnalysis {
    pub fn empty(sr: u32) -> Self {
        PsolaAnalysis {
            marks: Vec::new(),
            periods: Vec::new(),
            sr,
        }
    }

    pub fn usable(&self) -> bool {
        self.marks.len() >= 2
    }

    /// Marks inside `[in_lo, in_hi)`, still in global coordinates.
    pub fn span(&self, in_lo: i64, in_hi: i64) -> (Vec<i64>, Vec<f64>) {
        let mut m = Vec::new();
        let mut p = Vec::new();
        for (i, &mk) in self.marks.iter().enumerate() {
            if mk >= in_lo && mk < in_hi {
                m.push(mk);
                p.push(self.periods[i]);
            }
        }
        (m, p)
    }
}

/// Locate glottal closure instants once for the whole signal.
pub fn analyse(
    x: &[f64],
    sr: u32,
    track: Option<&F0Track>,
    params: Option<PsolaParams>,
) -> PsolaAnalysis {
    let params = params.unwrap_or_default();
    let owned;
    let track = match track {
        Some(t) => t,
        None => {
            owned = track_f0(x, sr, None);
            &owned
        }
    };
    let marks = pitch_marks(x, sr, track, params.mark_window_hz);
    if marks.len() < 2 {
        return PsolaAnalysis::empty(sr);
    }
    let periods: Vec<f64> = marks.iter().map(|&m| track.period_at(m)).collect();
    PsolaAnalysis {
        marks,
        periods,
        sr,
    }
}

/// Lay a synthesis mark grid that advances at the analysis pitch period.
///
/// This is the crux of TD-PSOLA: mapping every input mark through the time map is
/// wrong. The output marks must be spaced at the source pitch period, with the time
/// map deciding only which input mark synthesises each one.
fn output_marks(
    marks: &[i64],
    periods: &[f64],
    time_map: &TimeMap,
    out_lo: i64,
    out_hi: i64,
) -> (Vec<i64>, Vec<i64>, Vec<usize>) {
    if marks.is_empty() || out_hi <= out_lo {
        return (Vec::new(), Vec::new(), Vec::new());
    }

    let last_mark = marks[marks.len() - 1];
    let q0 = time_map.output_at(marks[0] as f64);
    let mut q = q0.max(out_lo as f64);
    let smallest = periods.iter().cloned().fold(f64::INFINITY, f64::min);
    let budget = (4.0 * ((out_hi as f64 - q) / smallest.max(1.0)) + 512.0) as usize;

    let mut positions: Vec<i64> = Vec::new();
    let mut indices: Vec<usize> = Vec::new();
    let marks_f: Vec<f64> = marks.iter().map(|&m| m as f64).collect();
    let mut walker = MapWalker::new(time_map);
    let mut steps = 0usize;

    while q < out_hi as f64 && positions.len() < budget && steps < 4 * budget {
        steps += 1;
        let in_pos = walker.at(q);
        let cursor: usize = if in_pos <= marks_f[0] {
            0
        } else if in_pos >= last_mark as f64 {
            break;
        } else {
            let c = marks_f.partition_point(|&m| m < in_pos);
            if c >= marks.len() {
                break;
            }
            c
        };
        let period = periods[cursor];
        // Advance by the observed spacing between adjacent marks.
        let mut step = if cursor + 1 < marks.len() {
            (marks[cursor + 1] - marks[cursor]) as f64
        } else {
            period
        };
        if step < 1.0 {
            step = 1.0;
        }

        if (marks[cursor] as f64 - in_pos).abs() > step {
            let nxt = time_map.output_at(marks[cursor] as f64);
            q = if nxt > q + 1e-6 { nxt } else { q + step };
            walker.rewind();
            continue;
        }

        positions.push(q.round() as i64);
        indices.push(cursor);
        q += step;
    }

    if positions.is_empty() {
        return (Vec::new(), Vec::new(), Vec::new());
    }
    let mut pos = Vec::with_capacity(positions.len());
    let mut idx = Vec::with_capacity(indices.len());
    for (p, &i) in positions.iter().zip(indices.iter()) {
        if *p >= out_lo && *p < out_hi {
            pos.push(*p);
            idx.push(i);
        }
    }
    let src: Vec<i64> = idx.iter().map(|&i| marks[i]).collect();
    (pos, src, idx)
}

/// Render one input span into one output span using a global analysis.
pub fn render_span(
    x: &[f64],
    time_map: &TimeMap,
    analysis: &PsolaAnalysis,
    in_lo: i64,
    in_hi: i64,
    out_lo: i64,
    out_hi: i64,
    params: Option<PsolaParams>,
) -> (Vec<f64>, Vec<bool>) {
    let params = params.unwrap_or_default();
    let span = (out_hi - out_lo).max(0) as usize;
    let mut out = vec![0.0f64; span];
    let mut coverage = vec![false; span];
    if span == 0 || in_hi <= in_lo {
        return (out, coverage);
    }

    let (marks, periods) = analysis.span(in_lo, in_hi);
    if marks.len() < 2 {
        return (out, coverage);
    }

    let (positions, sources, source_indices) = output_marks(&marks, &periods, time_map, out_lo, out_hi);
    if positions.is_empty() {
        return (out, coverage);
    }

    let widths: Vec<usize> = source_indices
        .iter()
        .map(|&i| {
            let w = (params.window_periods * periods[i]).round() as i64;
            let w = w.max(4);
            (w + (w % 2)) as usize
        })
        .collect();

    let mut envelope = vec![0.0f64; span];
    for (k, (&position, &source)) in positions.iter().zip(sources.iter()).enumerate() {
        let width = widths[k];
        let half = (width / 2) as i64;
        let seg_start = source - half;
        let out_start = position - out_lo;
        let lo = 0i64.max(-seg_start).max(-out_start);
        let hi = (width as i64)
            .min(x.len() as i64 - seg_start)
            .min(span as i64 - out_start);
        if hi <= lo {
            continue;
        }
        let window = hann(width);
        let lo_u = lo as usize;
        let hi_u = hi as usize;
        for j in lo_u..hi_u {
            let xi = (seg_start + j as i64) as usize;
            let oi = (out_start + j as i64) as usize;
            out[oi] += window[j] * x[xi];
            envelope[oi] += window[j];
            coverage[oi] = true;
        }
    }

    for i in 0..span {
        if envelope[i] > EPS {
            out[i] /= envelope[i];
        } else {
            out[i] = 0.0;
        }
    }
    (out, coverage)
}

/// Render `x` pitch-synchronously over the whole extent of `time_map`.
pub fn render(
    x: &[f64],
    time_map: &TimeMap,
    sr: u32,
    params: Option<PsolaParams>,
    track: Option<&F0Track>,
) -> Vec<f64> {
    let analysis = analyse(x, sr, track, params);
    let (rendered, _) = render_span(
        x,
        time_map,
        &analysis,
        0,
        x.len() as i64,
        0,
        time_map.out_length(),
        params,
    );
    rendered
}

/// Whole-signal render plus the mask of samples that received marks.
pub fn render_with_coverage(
    x: &[f64],
    time_map: &TimeMap,
    sr: u32,
    params: Option<PsolaParams>,
    track: Option<&F0Track>,
) -> (Vec<f64>, Vec<bool>) {
    let analysis = analyse(x, sr, track, params);
    render_span(
        x,
        time_map,
        &analysis,
        0,
        x.len() as i64,
        0,
        time_map.out_length(),
        params,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filters::autocorr;
    use crate::timing::TimeMap;

    fn steady_tone(f0: f64, seconds: f64, sr: u32) -> Vec<f64> {
        let n = (seconds * sr as f64) as usize;
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * f0 * i as f64 / sr as f64).sin())
            .collect()
    }

    /// Dominant frequency of a slice, by autocorrelation peak.
    fn dominant_frequency(slice: &[f64], sr: u32) -> f64 {
        let n = slice.len().min(4096);
        let frame = &slice[..n];
        let mean = frame.iter().sum::<f64>() / n as f64;
        let centered: Vec<f64> = frame.iter().map(|v| v - mean).collect();
        let mut size = 1usize;
        while size < 2 * n {
            size <<= 1;
        }
        let max_lag = (sr as usize / 60).min(n - 1);
        let ac = autocorr(&centered, size, max_lag);
        let lo = (sr as f64 / 400.0) as usize;
        let mut best = lo.max(1);
        for lag in lo.max(1)..=max_lag {
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
    fn psola_preserves_pitch_on_a_steady_tone() {
        let sr = 16000;
        let x = steady_tone(140.0, 3.0, sr);
        for ratio in [0.85, 0.7, 0.5, 0.43, 0.35] {
            let tm = TimeMap::uniform(x.len() as i64, ratio).unwrap();
            let y = render(&x, &tm, sr, None, None);
            assert_eq!(y.len(), (x.len() as f64 * ratio).round() as usize);
            let before = dominant_frequency(&x[sr as usize..2 * sr as usize], sr);
            let off = (0.5 * ratio * sr as f64) as usize;
            let span = (2.0 * ratio * sr as f64) as usize;
            let after = dominant_frequency(&y[off..(off + span).min(y.len())], sr);
            assert!(cents(before, after).abs() < 50.0, "ratio {ratio}: {} cents", cents(before, after));
        }
    }

    #[test]
    fn psola_output_length_matches_the_time_map() {
        let sr = 16000;
        let x = steady_tone(140.0, 1.5, sr);
        for ratio in [0.5, 0.75] {
            let tm = TimeMap::uniform(x.len() as i64, ratio).unwrap();
            let y = render(&x, &tm, sr, None, None);
            assert_eq!(y.len(), tm.out_length() as usize);
        }
    }

    #[test]
    fn psola_is_near_identity_at_ratio_one_where_marks_exist() {
        let sr = 16000;
        let x = steady_tone(140.0, 1.5, sr);
        let tm = TimeMap::uniform(x.len() as i64, 1.0).unwrap();
        let (y, coverage) = render_with_coverage(&x, &tm, sr, None, None);
        assert!(coverage.iter().any(|c| *c));
        let mut mask = coverage.clone();
        for i in 0..400.min(mask.len()) {
            mask[i] = false;
        }
        for i in mask.len().saturating_sub(400)..mask.len() {
            mask[i] = false;
        }
        let (ys, xs): (Vec<f64>, Vec<f64>) = y
            .iter()
            .zip(x.iter())
            .zip(mask.iter())
            .filter(|(_, m)| **m)
            .map(|((a, b), _)| (*a, *b))
            .unzip();
        assert!(ys.len() > 100);
        let corr = pearson(&ys, &xs);
        assert!(corr > 0.99, "corr {corr}");
    }

    fn pearson(a: &[f64], b: &[f64]) -> f64 {
        let n = a.len() as f64;
        let ma = a.iter().sum::<f64>() / n;
        let mb = b.iter().sum::<f64>() / n;
        let mut num = 0.0;
        let mut da = 0.0;
        let mut db = 0.0;
        for i in 0..a.len() {
            let xa = a[i] - ma;
            let xb = b[i] - mb;
            num += xa * xb;
            da += xa * xa;
            db += xb * xb;
        }
        num / (da.sqrt() * db.sqrt())
    }
}
