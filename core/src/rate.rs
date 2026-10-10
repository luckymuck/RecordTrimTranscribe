//! Energy-based segmentation and per-class rate allocation.
//!
//! Ports the usable parts of `fasttalk/align.py` (the energy fallback, since MFA
//! phoneme alignment is not available in the browser) and `fasttalk/rate/base.py`
//! (class floors and multipliers). Class-aware allocation therefore reduces to
//! silence-vs-speech awareness plus whatever boundaries the caller supplies.

use crate::classes::{profile_for, Class, Mode};
use crate::timing::{split_protected_head, Segment, SegmentRate};

/// Frame RMS energy.
fn frame_rms(x: &[f64], frame: usize, hop: usize) -> Vec<f64> {
    if x.len() < frame || hop == 0 {
        return Vec::new();
    }
    let n = 1 + (x.len() - frame) / hop;
    (0..n)
        .map(|i| {
            let base = i * hop;
            let s: f64 = x[base..base + frame].iter().map(|v| v * v).sum();
            (s / frame as f64).sqrt()
        })
        .collect()
}

/// Segment audio into silence and speech by local energy.
///
/// Returns a contiguous, non-overlapping cover of `[0, len)` labelled
/// `Class::Silence` or `Class::Speech`.
pub fn align_by_energy(x: &[f64], sr: u32) -> Vec<Segment> {
    let frame = ((0.020 * sr as f64) as usize).max(2);
    let hop = ((0.010 * sr as f64) as usize).max(1);
    let rms = frame_rms(x, frame, hop);
    if rms.is_empty() {
        return vec![Segment::with_class(0, x.len() as i64, "SIL", Class::Silence)];
    }

    let mut sorted = rms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let peak = sorted[sorted.len() - 1];
    let floor = sorted[sorted.len() / 10]; // 10th percentile as the noise floor
    let threshold = (floor + 0.08 * (peak - floor)).max(1e-4);

    let speech: Vec<bool> = rms.iter().map(|v| *v > threshold).collect();

    let mut segments = Vec::new();
    let mut start_frame = 0usize;
    let mut current = speech[0];
    for i in 1..speech.len() {
        if speech[i] != current {
            push_segment(&mut segments, x.len(), start_frame, i, hop, frame, current);
            start_frame = i;
            current = speech[i];
        }
    }
    push_segment(
        &mut segments,
        x.len(),
        start_frame,
        speech.len(),
        hop,
        frame,
        current,
    );
    segments
}

fn push_segment(
    segments: &mut Vec<Segment>,
    x_len: usize,
    first_frame: usize,
    last_frame: usize,
    hop: usize,
    frame: usize,
    speech: bool,
) {
    let start = (first_frame * hop) as i64;
    let end = ((last_frame.saturating_sub(1)) * hop + frame).min(x_len) as i64;
    if end <= start {
        return;
    }
    let (label, cls) = if speech {
        ("SP", Class::Speech)
    } else {
        ("SIL", Class::Silence)
    };
    segments.push(Segment::with_class(start, end, label, cls));
}

/// Class-aware rate plan for a target `ratio` (`out/in`).
///
/// Each segment's nominal rate is `ratio * multiplier`, floored at the class
/// floor. Protected heads are emitted as separate copy-through or overlap-add
/// pieces.
pub fn plan_rates(segments: &[Segment], in_length: i64, ratio: f64, sr: u32) -> Vec<SegmentRate> {
    let ratio = ratio.clamp(1e-3, 1.0);
    let mut rates = Vec::new();
    let mut cursor: i64 = 0;
    for seg in segments {
        let start = seg.start.max(cursor).min(in_length);
        let end = seg.end.max(start).min(in_length);
        if end <= start {
            continue;
        }
        if start > cursor {
            rates.push(SegmentRate::new(cursor, start, 1.0, Mode::OverlapAdd, Class::Silence));
        }
        let clamped = Segment::with_class(start, end, &seg.label, seg.cls);
        for (s, e, is_head) in split_protected_head(&clamped, sr) {
            let profile = profile_for(seg.cls);
            let nominal = (ratio * profile.multiplier).clamp(profile.floor, 1.0);
            if is_head && profile.head_mode == Mode::CopyThrough {
                rates.push(SegmentRate {
                    start: s,
                    end: e,
                    rate: 1.0,
                    mode: Mode::CopyThrough,
                    cls: seg.cls,
                    label: seg.label.clone(),
                    head: true,
                });
            } else {
                rates.push(SegmentRate {
                    start: s,
                    end: e,
                    rate: nominal,
                    mode: Mode::OverlapAdd,
                    cls: seg.cls,
                    label: seg.label.clone(),
                    head: is_head,
                });
            }
        }
        cursor = end;
    }
    if cursor < in_length {
        rates.push(SegmentRate::new(cursor, in_length, 1.0, Mode::OverlapAdd, Class::Silence));
    }
    rates
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timing::TimeMap;

    fn alternating(seconds: f64, sr: u32) -> Vec<f64> {
        let n = (seconds * sr as f64) as usize;
        let period = sr as usize / 4;
        let mut x = vec![0.0f64; n];
        let mut start = 0usize;
        while start + period < n {
            for i in 0..period {
                x[start + i] = (2.0 * std::f64::consts::PI * 140.0 * i as f64 / sr as f64).sin() * 0.4;
            }
            start += 2 * period;
        }
        x
    }

    #[test]
    fn energy_alignment_separates_speech_and_silence() {
        let sr = 16000;
        let mut x = vec![0.0f64; sr as usize / 2];
        x.extend(alternating(1.0, sr));
        x.extend(vec![0.0f64; sr as usize / 2]);
        let segments = align_by_energy(&x, sr);
        assert_eq!(segments[0].cls, Class::Silence);
        assert_eq!(segments.last().unwrap().cls, Class::Silence);
        assert!(segments.iter().any(|s| s.cls == Class::Speech));
    }

    #[test]
    fn pure_silence_is_all_silence() {
        let sr = 16000;
        let segments = align_by_energy(&vec![0.0; sr as usize], sr);
        assert!(segments.iter().all(|s| s.cls == Class::Silence));
    }

    #[test]
    fn plan_produces_a_monotone_map() {
        let sr = 16000;
        let x = alternating(2.0, sr);
        let segments = align_by_energy(&x, sr);
        let rates = plan_rates(&segments, x.len() as i64, 0.5, sr);
        let tm = TimeMap::from_rates(&rates, x.len() as i64);
        assert!(tm.out_length() < x.len() as i64);
        // Silence should compress harder than the nominal 0.5.
        let silence_rate = rates.iter().find(|r| r.cls == Class::Silence).unwrap().rate;
        assert!(silence_rate < 0.5);
    }
}
