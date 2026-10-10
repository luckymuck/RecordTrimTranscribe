//! Composition of copy-through, pitch-synchronous, and overlap-add regions.
//!
//! Ported from `fasttalk/engines/hybrid.py`. Voiced material is rendered
//! pitch-synchronously (PSOLA); whatever carries no glottal marks falls back to
//! WSOLA; copy-through regions (stop closures/bursts) are written last.

use crate::classes::{Class, Mode};
use crate::engines::{psola, wsola};
use crate::filters::smooth_unit;
use crate::pitch::track_f0;
use crate::timing::{SegmentRate, TimeMap};

/// Render `x` according to `rates`, assembled into the domain of `time_map`.
///
/// PSOLA and WSOLA are never spliced. Everywhere the two engines could disagree,
/// chiefly at voiced/unvoiced transitions, they are blended with a continuous
/// weight taken from PSOLA's overlap-add gain envelope. Splicing on a boolean
/// coverage mask steps the waveform at exactly those transitions, which is
/// audible as a click and shows up as a full-height broadband line in a
/// spectrogram.
pub fn render(x: &[f64], time_map: &TimeMap, rates: &[SegmentRate], sr: u32) -> Vec<f64> {
    let out_length = time_map.out_length().max(0) as usize;
    if out_length == 0 {
        return Vec::new();
    }

    let track = track_f0(x, sr, None);
    let analysis = psola::analyse(x, sr, Some(&track), None);

    // Pitch-synchronous pass, empty when there is nothing periodic to lock onto.
    let (mut out, envelope) = if analysis.usable() {
        psola::render_with_envelope(x, time_map, sr, None, Some(&track))
    } else {
        (vec![0.0; out_length], vec![0.0; out_length])
    };
    apply_copy_through(&mut out, x, time_map, rates, out_length);

    let weight = psola_weight(&envelope, sr);
    if weight.iter().all(|w| *w >= 1.0) {
        return out;
    }

    // Only pay for the overlap-add pass where PSOLA does not fully own the signal.
    let mut filler = wsola::render(x, time_map, sr, None);
    filler.resize(out_length, 0.0);
    apply_copy_through(&mut filler, x, time_map, rates, out_length);

    for i in 0..out_length {
        let w = weight[i];
        out[i] = out[i] * w + filler[i] * (1.0 - w);
    }
    out
}

/// Overwrite copy-through regions (stop closures, bursts) with the raw input.
///
/// Applied to both engine outputs before they are blended, so the blend sees the
/// same content either way and the transition stays continuous.
fn apply_copy_through(
    out: &mut [f64],
    x: &[f64],
    time_map: &TimeMap,
    rates: &[SegmentRate],
    out_length: usize,
) {
    for r in rates {
        if r.mode != Mode::CopyThrough {
            continue;
        }
        let out_start = time_map.output_at(r.start as f64).round() as i64;
        let out_end = time_map.output_at(r.end as f64).round() as i64;
        let lo = out_start.max(0) as usize;
        let hi = (out_end.min(out_length as i64)).max(0) as usize;
        let width = hi.saturating_sub(lo);
        if width == 0 {
            continue;
        }
        let src = (r.start.max(0) as usize).min(x.len());
        let n = width.min(x.len().saturating_sub(src));
        for k in 0..n {
            out[lo + k] = x[src + k];
        }
    }
}

/// Turn PSOLA's overlap-add gain envelope into a blend weight in `[0, 1]`.
///
/// The envelope sits at its steady-state overlap count through the interior of
/// voiced material and decays to zero across the outer window edge, so it ramps
/// smoothly from "PSOLA owns this" to "PSOLA has nothing to say here". A high
/// percentile is used as the reference rather than the peak so that irregular
/// mark spacing cannot push an interior sample below full weight.
fn psola_weight(envelope: &[f64], sr: u32) -> Vec<f64> {
    let mut nonzero: Vec<f64> = envelope.iter().copied().filter(|v| *v > 1e-12).collect();
    if nonzero.is_empty() {
        return vec![0.0; envelope.len()];
    }
    nonzero.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let reference = nonzero[nonzero.len() * 95 / 100].max(1e-12);

    let mut weight: Vec<f64> = envelope
        .iter()
        .map(|v| (v / reference).clamp(0.0, 1.0))
        .collect();
    // Short symmetric smoothing removes the ripple that mark-spacing jitter
    // leaves in the interior without shifting the edge transitions.
    smooth_unit(&mut weight, ((0.005 * sr as f64).round() as usize).max(3));
    weight
}

/// Uniform compression with pitch preserved, for the control condition.
pub fn render_uniform(x: &[f64], ratio: f64, sr: u32) -> Vec<f64> {
    let tm = TimeMap::uniform(x.len() as i64, ratio.clamp(1e-3, 1.0)).unwrap();
    psola::render(x, &tm, sr, None, None)
}

/// A per-region rate plan for a uniform speed.
pub fn uniform_rate_plan(length: i64, ratio: f64) -> Vec<SegmentRate> {
    vec![SegmentRate::new(0, length, ratio, Mode::OverlapAdd, Class::Speech)]
}
