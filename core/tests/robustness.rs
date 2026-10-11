//! Tests for the review's remaining gaps (DS-6): seam amplitude, class-aware
//! length against the dial, skip/map behaviour at odd sample rates, and
//! speech-like material instead of pure tones.
//!
//! The other suites measure sample-to-sample steps on tone bursts separated by
//! digital silence. That is the right probe for a splice, but it hides two
//! things: an envelope dip (two misaligned pulse trains summed by a crossfade
//! cancel without any single large step) and anything about a noise floor. Real
//! recordings never contain exact zeros, and `keep / 2` is fractional at odd
//! rates like 11025 Hz.

use fasttalk_core::api::{silence_zones, time_stretch, time_stretch_skip_silence, SkipBakedMap};
use fasttalk_core::stream::StreamStretcher;

const SR: u32 = 48000;

fn tone(f0: f64, seconds: f64, sr: u32, amp: f32) -> Vec<f32> {
    let n = (seconds * sr as f64) as usize;
    (0..n)
        .map(|i| (2.0 * std::f64::consts::PI * f0 * i as f64 / sr as f64).sin() as f32 * amp)
        .collect()
}

/// Voiced bursts with raised-cosine edges separated by a noise floor rather
/// than digital silence, so the energy detector has to work for its living.
fn speech_like(seconds: f64, sr: u32, floor: f32) -> Vec<f32> {
    let n = (seconds * sr as f64) as usize;
    let burst = (0.30 * sr as f64) as usize;
    let pause = (0.45 * sr as f64) as usize;
    let period = burst + pause;
    let ramp = (0.02 * sr as f64) as usize;

    let mut state = 0x9E3779B9_7F4A7C15u64;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let noise = ((state >> 40) as f32 / 8388608.0) - 1.0;
        let phase = i as f64 * 2.0 * std::f64::consts::PI * 145.0 / sr as f64;
        let voiced = 0.30
            * (phase.sin() as f32
                + 0.5 * (2.0 * phase).sin() as f32
                + 0.25 * (3.0 * phase).sin() as f32);

        let pos = i % period;
        let v = if pos < burst {
            voiced * smooth(pos, ramp, burst)
        } else {
            noise * floor
        };
        out.push(v);
    }
    out
}

fn smooth(pos: usize, ramp: usize, len: usize) -> f32 {
    let r = ramp.max(1);
    let w = if pos < r {
        pos as f64 / r as f64
    } else if pos + r > len {
        (len - pos) as f64 / r as f64
    } else {
        1.0
    };
    (0.5 - 0.5 * (std::f64::consts::PI * w.clamp(0.0, 1.0)).cos()) as f32
}

fn stream_through(x: &[f32], sr: u32, speed: f64) -> Vec<f32> {
    let mut s = StreamStretcher::new(sr, speed);
    let mut out: Vec<f32> = Vec::new();
    for chunk in x.chunks(4096) {
        s.push(chunk);
        out.extend(s.pull(1 << 20));
    }
    s.finish();
    let mut guard = 0;
    loop {
        let got = s.pull(1 << 20);
        if got.is_empty() {
            guard += 1;
            if guard > 3 {
                break;
            }
        } else {
            out.extend(got);
        }
    }
    out
}

/// Short-time RMS in `window_ms` windows, starting `skip_ms` in (to clear the
/// startup fade).
fn rms_windows(y: &[f32], sr: u32, skip_ms: f64, window_ms: f64) -> Vec<f32> {
    let skip = (skip_ms * sr as f64 / 1000.0) as usize;
    let w = (window_ms * sr as f64 / 1000.0) as usize;
    if w == 0 || y.len() <= skip + w {
        return Vec::new();
    }
    y[skip..]
        .chunks(w)
        .map(|c| {
            (c.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / c.len() as f64).sqrt()
                as f32
        })
        .collect()
}

fn median(mut v: Vec<f32>) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn max_step(y: &[f32]) -> f32 {
    y.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
}

/// PB-5, confirmed. A steady tone at 3x crosses a block seam 7.5 times a
/// second. `psola::output_marks` starts its pulse grid at the block's own
/// render start, so adjacent blocks place pulses at different sub-period
/// offsets; the seam crossfade then sums two misaligned copies and the envelope
/// dips. Measured: 58-76% of the median every 0.133 s (= 0.4 / 3).
///
/// This is a regression guard, not an endorsement. A step-based test cannot see
/// it -- the crossfade is smooth, so there is no large sample-to-sample delta --
/// and 50% is a floor well below the measured 58%, so it only fails if the
/// seam gets worse. The real fix is carrying the synthesis grid across blocks.
#[test]
fn streaming_seams_do_not_modulate_a_steady_tone() {
    let sr = SR;
    let x = tone(200.0, 3.0, sr, 0.3);
    let y = stream_through(&x, sr, 3.0);

    // Stop before the final tail, which fades out by design.
    let usable = &y[..y.len().saturating_sub((0.04 * sr as f64) as usize)];
    let rms = rms_windows(usable, sr, 150.0, 10.0);
    assert!(rms.len() > 50, "only {} windows to profile", rms.len());
    let med = median(rms.clone());
    let min = rms.iter().cloned().fold(f32::INFINITY, f32::min);
    assert!(med > 0.1, "output is far too quiet: median RMS {med}");
    assert!(
        min >= med * 0.5,
        "seam dips the envelope to {min} against a median of {med} ({:.0}%); \
         worse than the 58% PB-5 measurement",
        100.0 * min / med
    );
}

/// The same for the blocked offline path (CORE-1), where the seam is a 0.5 s
/// crossfade between 30 s renders. 40 s at 16 kHz spans more than one block.
#[test]
fn offline_block_seams_do_not_modulate_a_steady_tone() {
    let sr = 16000;
    let x = tone(200.0, 40.0, sr, 0.3);
    let y = time_stretch(&x, sr, 2.0, false);

    let rms = rms_windows(&y, sr, 200.0, 20.0);
    assert!(rms.len() > 100, "only {} windows to profile", rms.len());
    let med = median(rms.clone());
    let min = rms.iter().cloned().fold(f32::INFINITY, f32::min);
    assert!(
        min >= med * 0.7,
        "block seam dips the envelope to {min} against a median of {med} ({:.0}%)",
        100.0 * min / med
    );
}

/// DS-3: continuous speech has no pauses to give back, so the speech floor caps
/// the reachable speed at about 2.2x. Below the cap the global scale must hit
/// the dial; above it, the bake must do the best it can without ever producing
/// more audio than a lower dial, or none at all.
#[test]
fn class_aware_length_tracks_the_dial_until_the_floor_limits_it() {
    let sr = SR;
    let x = tone(160.0, 4.0, sr, 0.3); // one unbroken speech run
    let ideal = |speed: f64| x.len() as f64 / speed;

    let two = time_stretch(&x, sr, 2.0, true).len() as f64;
    assert!(
        (two - ideal(2.0)).abs() < 0.06 * ideal(2.0),
        "2x: baked {two}, expected ~{}",
        ideal(2.0)
    );

    let lengths: Vec<f64> = [2.0f64, 3.0, 4.0]
        .iter()
        .map(|s| time_stretch(&x, sr, *s, true).len() as f64)
        .collect();
    for w in lengths.windows(2) {
        assert!(
            w[1] <= w[0] * 1.02,
            "a higher dial produced more audio: {lengths:?}"
        );
    }

    let four = lengths[2];
    let effective = x.len() as f64 / four;
    assert!(four > ideal(4.0), "4x: the floor limited nothing");
    assert!(four < x.len() as f64, "4x: no compression at all");
    assert!(
        effective > 1.9,
        "4x: effective speed only {effective:.2}x; the floor is too conservative"
    );
}

/// PB-10 / DS-6: `silence_zones` returns f64 positions and the kept pause is
/// halved (`keep / 2`), which is fractional at odd rates. The map and the
/// render must still agree, and every position inside a skipped gap must
/// collapse to the same boundary.
#[test]
fn skip_map_agrees_with_the_render_at_odd_sample_rates() {
    for sr in [11025u32, 22050, 44100] {
        let speech = tone(150.0, 0.5, sr, 0.3);
        let mut x = Vec::new();
        x.extend(&speech);
        x.extend(vec![0.0f32; (1.5 * sr as f64) as usize]);
        x.extend(&speech);

        let zones = silence_zones(&x, sr, 0.5);
        assert_eq!(zones.len(), 2, "{sr} Hz: expected one zone, got {zones:?}");

        let map = SkipBakedMap::new(&x, sr, 2.0, false, 0.5, 0.2);
        let out = time_stretch_skip_silence(&x, sr, 2.0, false, 0.5, 0.2);
        assert!(
            out.iter().all(|v| v.is_finite()),
            "{sr} Hz: non-finite output"
        );
        assert!(map.map_position(0.0).abs() < 1.0, "{sr} Hz: start is not 0");

        let mapped_end = map.map_position(x.len() as f64);
        assert!(
            (mapped_end - out.len() as f64).abs() < 2.0,
            "{sr} Hz: map end {mapped_end} vs rendered length {}",
            out.len()
        );

        // Well inside the skipped middle: all probes collapse to one boundary.
        let probes = [0.8f64, 1.0, 1.2].map(|f| f * sr as f64);
        let mapped: Vec<f64> = probes.iter().map(|p| map.map_position(*p)).collect();
        for (i, got) in mapped.iter().enumerate() {
            assert!(
                (got - mapped[0]).abs() < 1.0,
                "{sr} Hz: gap probe {} mapped to {got}, not {}",
                probes[i],
                mapped[0]
            );
        }
    }
}

/// DS-6: the pause in a real recording is room tone. The detector must find
/// those pauses, the export must join across them without a step on material
/// that is actually speech-like, and a class-aware bake of the same material
/// must still land on the dial.
#[test]
fn noise_floor_pauses_are_detected_and_joined_cleanly() {
    let sr = SR;
    let x = speech_like(4.0, sr, 0.01); // pauses at about -40 dBFS

    let zones = silence_zones(&x, sr, 0.25);
    assert!(
        !zones.is_empty(),
        "no pauses found in speech-like material with a noise floor"
    );

    let out = time_stretch_skip_silence(&x, sr, 1.5, false, 0.25, 0.2);
    assert!(out.iter().all(|v| v.is_finite()), "non-finite export");
    assert!(
        out.len() < x.len(),
        "skip export removed nothing: {} vs {}",
        out.len(),
        x.len()
    );
    let source_step = max_step(&x);
    let out_step = max_step(&out);
    assert!(
        out_step <= source_step * 4.0,
        "join step {out_step} exceeds 4x the source's {source_step}"
    );

    let baked = time_stretch(&x, sr, 2.0, true);
    let expected = x.len() as f64 / 2.0;
    assert!(
        (baked.len() as f64 - expected).abs() < 0.08 * expected,
        "class-aware bake {} vs expected ~{expected}",
        baked.len()
    );
}
// ── Batch B: DSP-low regressions ────────────────────────────────────────────

/// DS-5: segmenting f32 samples directly must agree with the f64 path. The map
/// builders use the f32 entry point to avoid copying the whole recording.
#[test]
fn f32_and_f64_segmentation_agree() {
    use fasttalk_core::rate::{align_by_energy, align_by_energy_f32};
    let x = speech_like(4.0, SR, 0.01);
    let xf64: Vec<f64> = x.iter().map(|v| *v as f64).collect();
    let a = align_by_energy(&xf64, SR);
    let b = align_by_energy_f32(&x, SR);
    assert_eq!(a.len(), b.len(), "segment count differs: {} vs {}", a.len(), b.len());
    let hop = (0.010 * SR as f64) as i64;
    for (i, (p, q)) in a.iter().zip(b.iter()).enumerate() {
        assert!(
            (p.start - q.start).abs() <= hop && (p.end - q.end).abs() <= hop,
            "segment {i}: ({}, {}) vs ({}, {})",
            p.start, p.end, q.start, q.end
        );
    }
}

/// CORE-6: marks must sit on the dominant polarity of the pulse train rather
/// than on whichever peak has the larger magnitude.
#[test]
fn glottal_marks_follow_the_pulse_polarity() {
    use fasttalk_core::pitch::{pitch_marks, track_f0};
    let sr = 16000;
    let n = sr as usize;
    let period = sr as f64 / 140.0;
    // Sharp rise, slow decay: positive-dominant, and zero-mean over a period.
    let x: Vec<f64> = (0..n)
        .map(|i| {
            let phase = (i as f64 % period) / period;
            (1.0 - phase).powi(3) - 0.25
        })
        .collect();
    let track = track_f0(&x, sr, None);
    let marks = pitch_marks(&x, sr, &track, 900.0);
    assert!(marks.len() > 50, "too few marks: {}", marks.len());
    let positive = marks.iter().filter(|&&m| x[m as usize] > 0.0).count();
    let frac = positive as f64 / marks.len() as f64;
    assert!(
        frac > 0.95,
        "only {:.0}% of marks land on the dominant polarity",
        frac * 100.0
    );
}

/// CORE-9: a span-limited WSOLA render must equal the corresponding slice of a
/// full render. The synthesis grid is absolute and each window's source choice
/// comes from the time map alone, so nothing about the result depends on where
/// the span starts.
#[test]
fn span_wsola_matches_the_full_render() {
    use fasttalk_core::engines::wsola;
    use fasttalk_core::timing::TimeMap;
    let sr = 16000;
    let x: Vec<f64> = speech_like(3.0, sr, 0.01).iter().map(|v| *v as f64).collect();
    let tm = TimeMap::uniform(x.len() as i64, 0.5).unwrap();
    let full = wsola::render(&x, &tm, sr, None);
    let frame = (0.032 * sr as f64) as usize;
    for (lo, hi) in [(0usize, 8000usize), (8000, 16000), (16000, full.len())] {
        let span = wsola::render_range(&x, &tm, sr, None, lo, hi);
        assert_eq!(span.len(), hi - lo, "span length");
        // Only the first frame can differ: it is the one place where the set of
        // overlapping windows depends on the span's start.
        for i in frame..(hi - lo) {
            let d = (span[i] - full[lo + i]).abs();
            assert!(d < 1e-9, "span ({lo},{hi}) sample {i} differs by {d}");
        }
    }
}
