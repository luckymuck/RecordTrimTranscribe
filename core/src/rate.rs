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

/// Frame RMS energy over `f32` samples.
///
/// The playback path needs silence detection but must not materialise an `f64`
/// copy of the whole recording (8 bytes/sample, ~1.4 GB for an hour at 48 kHz).
/// This computes the energy in place on the `f32` slice instead.
fn frame_rms_f32(x: &[f32], frame: usize, hop: usize) -> Vec<f64> {
    if x.len() < frame || hop == 0 {
        return Vec::new();
    }
    let n = 1 + (x.len() - frame) / hop;
    (0..n)
        .map(|i| {
            let base = i * hop;
            let s: f64 = x[base..base + frame]
                .iter()
                .map(|v| {
                    let v = *v as f64;
                    v * v
                })
                .sum();
            (s / frame as f64).sqrt()
        })
        .collect()
}

/// Frames of hangover that keep a run labelled speech after it drops quiet.
/// The analysis hop is 10 ms in both callers, so this is about 100 ms.
const HANGOVER_FRAMES: usize = 10;

/// Classify frame energies into contiguous speech/silence runs.
///
/// Each run is `(start_sample, end_sample, is_speech)`.
///
/// The decision is made in decibels against a high percentile rather than the
/// single loudest frame. Anchoring to the peak meant one cough or plosive could
/// raise the threshold far above soft speech, so trailing words and fricatives
/// counted as silence and skip-silence then cut them. Hysteresis (separate
/// enter/exit levels) plus a hangover keep brief dips inside a word from
/// fragmenting it.
fn energy_runs(x_len: usize, rms: &[f64], hop: usize, frame: usize) -> Vec<(i64, i64, bool)> {
    if rms.is_empty() {
        return Vec::new();
    }
    let db: Vec<f64> = rms
        .iter()
        .map(|v| 20.0 * v.max(1e-9).log10())
        .collect();
    let mut sorted = db.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let floor = sorted[sorted.len() / 10];
    let speech_level = sorted[(sorted.len() * 90) / 100];
    let span = (speech_level - floor).max(1e-6);
    let enter = floor + 0.35 * span;
    let exit = floor + 0.20 * span;

    let mut speech = vec![false; db.len()];
    let mut in_speech = false;
    let mut quiet_run = 0usize;
    for (i, level) in db.iter().enumerate() {
        let limit = if in_speech { exit } else { enter };
        if *level > limit {
            in_speech = true;
            quiet_run = 0;
            speech[i] = true;
        } else if in_speech {
            quiet_run += 1;
            if quiet_run <= HANGOVER_FRAMES {
                speech[i] = true;
            } else {
                in_speech = false;
                quiet_run = 0;
            }
        }
    }

    let mut runs = Vec::new();
    let mut start_frame = 0usize;
    let mut current = speech[0];
    for i in 1..speech.len() {
        if speech[i] != current {
            push_run(&mut runs, x_len, start_frame, i, hop, frame, current);
            start_frame = i;
            current = speech[i];
        }
    }
    push_run(&mut runs, x_len, start_frame, speech.len(), hop, frame, current);
    runs
}

fn run_bounds(
    x_len: usize,
    first_frame: usize,
    last_frame: usize,
    hop: usize,
    frame: usize,
) -> Option<(i64, i64)> {
    let start = (first_frame * hop) as i64;
    let end = ((last_frame.saturating_sub(1)) * hop + frame).min(x_len) as i64;
    if end <= start {
        None
    } else {
        Some((start, end))
    }
}

fn push_run(
    runs: &mut Vec<(i64, i64, bool)>,
    x_len: usize,
    first_frame: usize,
    last_frame: usize,
    hop: usize,
    frame: usize,
    speech: bool,
) {
    if let Some((start, end)) = run_bounds(x_len, first_frame, last_frame, hop, frame) {
        runs.push((start, end, speech));
    }
}

/// Segment audio into silence and speech by local energy.
///
/// Returns a contiguous, non-overlapping cover of `[0, len)` labelled
/// `Class::Silence` or `Class::Speech`.
pub fn align_by_energy(x: &[f64], sr: u32) -> Vec<Segment> {
    let frame = ((0.020 * sr as f64) as usize).max(2);
    let hop = ((0.010 * sr as f64) as usize).max(1);
    let rms = frame_rms(x, frame, hop);
    let runs = energy_runs(x.len(), &rms, hop, frame);
    if runs.is_empty() {
        return vec![Segment::with_class(0, x.len() as i64, "SIL", Class::Silence)];
    }
    runs.into_iter()
        .map(|(start, end, speech)| {
            if speech {
                Segment::with_class(start, end, "SP", Class::Speech)
            } else {
                Segment::with_class(start, end, "SIL", Class::Silence)
            }
        })
        .collect()
}

/// Silence runs longer than `min_silence_s`, as flat `[start, end, start, end,
/// ...]` sample positions.
///
/// This is the playback-side counterpart of [`align_by_energy`]: it works on the
/// `f32` samples directly and returns only the runs to skip, so the caller never
/// holds a full-length `f64` copy or the segment list.
///
/// The boundaries are the raw detected silence edges. How much silence to keep
/// on each side is a function of playback speed, so the caller applies that
/// inset (see `skipKeepSourceSeconds` in the client) rather than baking it in
/// here and forcing a re-scan on every speed change.
pub fn silence_zones_f32(x: &[f32], sr: u32, min_silence_s: f64) -> Vec<f64> {
    let frame = ((0.020 * sr as f64) as usize).max(2);
    let hop = ((0.010 * sr as f64) as usize).max(1);
    let rms = frame_rms_f32(x, frame, hop);
    let runs = energy_runs(x.len(), &rms, hop, frame);
    let min_len = min_silence_s * sr as f64;
    let mut zones = Vec::new();
    for (start, end, speech) in runs {
        if speech || (end - start) as f64 <= min_len {
            continue;
        }
        zones.push(start as f64);
        zones.push(end as f64);
    }
    zones
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
