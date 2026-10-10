//! Composition of copy-through, pitch-synchronous, and overlap-add regions.
//!
//! Ported from `fasttalk/engines/hybrid.py`. Voiced material is rendered
//! pitch-synchronously (PSOLA); whatever carries no glottal marks falls back to
//! WSOLA; copy-through regions (stop closures/bursts) are written last.

use crate::classes::{Class, Mode};
use crate::engines::{psola, wsola};
use crate::pitch::track_f0;
use crate::timing::{SegmentRate, TimeMap};

/// Render `x` according to `rates`, assembled into the domain of `time_map`.
pub fn render(x: &[f64], time_map: &TimeMap, rates: &[SegmentRate], sr: u32) -> Vec<f64> {
    let out_length = time_map.out_length().max(0) as usize;
    if out_length == 0 {
        return Vec::new();
    }

    let track = track_f0(x, sr, None);
    let analysis = psola::analyse(x, sr, Some(&track), None);

    let (mut out, covered) = if analysis.usable() {
        psola::render_with_coverage(x, time_map, sr, None, Some(&track))
    } else {
        (vec![0.0; out_length], vec![false; out_length])
    };

    let all_covered = covered.iter().all(|c| *c);
    if !all_covered {
        let filler = wsola::render(x, time_map, sr, None);
        for i in 0..out_length {
            if !covered[i] {
                out[i] = filler.get(i).copied().unwrap_or(0.0);
            }
        }
    }

    // Copy-through regions are written last so neither pass can disturb them.
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

    out
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
