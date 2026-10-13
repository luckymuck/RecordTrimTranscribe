//! Clean-up stage tests: rumble high-pass, consonant boost, soft limiter.
//!
//! These are single-tone or two-tone probes, so a stage's effect on each band
//! is measured directly rather than inferred from the waveform.

use fasttalk_core::enhance;

const SR: u32 = 48000;
/// Samples to skip so the biquad transient is out of the measurement window.
const SKIP: usize = 4800;

fn sine(f: f64, seconds: f64, sr: u32, amp: f64) -> Vec<f64> {
    let n = (seconds * sr as f64) as usize;
    (0..n)
        .map(|i| amp * (2.0 * std::f64::consts::PI * f * i as f64 / sr as f64).sin())
        .collect()
}

/// Amplitude of `f` in `x` (single-bin projection; phase-insensitive).
fn tone_amplitude(x: &[f64], f: f64, sr: u32) -> f64 {
    let (mut re, mut im) = (0.0f64, 0.0f64);
    for (i, &v) in x.iter().enumerate() {
        let phase = 2.0 * std::f64::consts::PI * f * i as f64 / sr as f64;
        re += v * phase.cos();
        im -= v * phase.sin();
    }
    2.0 * (re * re + im * im).sqrt() / x.len() as f64
}

#[test]
fn highpass_attenuates_rumble_and_passes_speech() {
    let rumble = enhance::highpass(&sine(40.0, 2.0, SR, 0.5), SR, 80.0);
    let speech = enhance::highpass(&sine(1000.0, 2.0, SR, 0.5), SR, 80.0);

    let rumble_amp = tone_amplitude(&rumble[SKIP..], 40.0, SR);
    let speech_amp = tone_amplitude(&speech[SKIP..], 1000.0, SR);

    assert!(
        rumble_amp < 0.5 * 0.35,
        "40 Hz should be at least ~9 dB down, got {rumble_amp}"
    );
    assert!(
        (speech_amp - 0.5).abs() < 0.5 * 0.12,
        "1 kHz should pass, got {speech_amp}"
    );
}

#[test]
fn consonant_boost_raises_the_high_band() {
    let corner = 2000.0;
    let gain_db = 6.0;
    let mut x = sine(200.0, 2.0, SR, 0.3);
    let high = sine(6000.0, 2.0, SR, 0.1);
    for (i, h) in high.iter().enumerate() {
        x[i] += h;
    }

    // amount = 0: the shelf alone, no compression.
    let y = enhance::consonant_boost(&x, SR, corner, gain_db, 0.0);
    let low_ratio = tone_amplitude(&y[SKIP..], 200.0, SR) / tone_amplitude(&x[SKIP..], 200.0, SR);
    let high_ratio = tone_amplitude(&y[SKIP..], 6000.0, SR) / tone_amplitude(&x[SKIP..], 6000.0, SR);
    let expected = 10f64.powf(gain_db / 20.0);

    assert!(
        (low_ratio - 1.0).abs() < 0.1,
        "the low band should be untouched, ratio {low_ratio}"
    );
    assert!(
        (high_ratio / expected - 1.0).abs() < 0.25,
        "high band ratio {high_ratio}, expected about {expected}"
    );
}

#[test]
fn consonant_boost_compresses_loud_highs_more_than_quiet() {
    let loud = enhance::consonant_boost(&sine(6000.0, 2.0, SR, 0.5), SR, 2000.0, 0.0, 1.0);
    let quiet = enhance::consonant_boost(&sine(6000.0, 2.0, SR, 0.005), SR, 2000.0, 0.0, 1.0);

    let loud_gain = tone_amplitude(&loud[SKIP..], 6000.0, SR) / 0.5;
    let quiet_gain = tone_amplitude(&quiet[SKIP..], 6000.0, SR) / 0.005;

    assert!(
        loud_gain < quiet_gain * 0.8,
        "a loud high band should be compressed more: loud {loud_gain}, quiet {quiet_gain}"
    );
    assert!(
        quiet_gain > 0.9,
        "a quiet high band should be left alone, got {quiet_gain}"
    );
}

#[test]
fn soft_limiter_never_exceeds_the_ceiling() {
    let ceiling_db = -1.0;
    let ceiling = 10f64.powf(ceiling_db / 20.0);
    for amp in [0.95, 1.0, 2.0] {
        let y = enhance::soft_limiter(&sine(300.0, 1.0, SR, amp), SR, ceiling_db);
        let peak = y.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        assert!(peak <= ceiling + 1e-6, "amp {amp}: peak {peak} exceeds {ceiling}");
        assert!(y.iter().all(|v| v.is_finite()));
    }
}

#[test]
fn soft_limiter_leaves_quiet_material_untouched() {
    let x = sine(300.0, 1.0, SR, 0.2);
    let y = enhance::soft_limiter(&x, SR, -1.0);
    for i in 0..x.len() {
        assert!((x[i] - y[i]).abs() < 1e-9, "sample {i} changed by {}", x[i] - y[i]);
    }
}

#[test]
fn stages_stay_finite_and_silent_on_silence() {
    let x = vec![0.0f64; SR as usize];
    let outputs = [
        enhance::highpass(&x, SR, 80.0),
        enhance::consonant_boost(&x, SR, 2000.0, 6.0, 1.0),
        enhance::soft_limiter(&x, SR, -1.0),
    ];
    for y in outputs {
        assert_eq!(y.len(), x.len());
        assert!(y.iter().all(|v| v.is_finite() && v.abs() < 1e-9));
    }
}

// â”€â”€ Leveler (uneven speaker levels) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn rms(a: &[f64]) -> f64 {
    (a.iter().map(|v| v * v).sum::<f64>() / a.len() as f64).sqrt()
}

/// 5 s loud, 5 s quiet (20 dB down), 5 s loud. Longer than the 3 s window so the
/// envelope can actually track the sections.
fn uneven(sr: u32) -> Vec<f64> {
    let mut x = sine(150.0, 5.0, sr, 0.4);
    x.extend(sine(150.0, 5.0, sr, 0.04));
    x.extend(sine(150.0, 5.0, sr, 0.4));
    x
}

#[test]
fn leveler_raises_a_quiet_section_and_leaves_the_loud_ones() {
    let sr = 48000;
    let x = uneven(sr);
    let y = enhance::level(&x, sr, 12.0, 3.0);
    assert_eq!(y.len(), x.len());
    let n = sr as usize;
    // Measure the middle of each section, clear of the transitions.
    let loud_before = rms(&x[1 * n..4 * n]);
    let loud_after = rms(&y[1 * n..4 * n]);
    let quiet_before = rms(&x[6 * n..9 * n]);
    let quiet_after = rms(&y[6 * n..9 * n]);

    assert!(
        (loud_after / loud_before - 1.0).abs() < 0.05,
        "loud section should be left alone: {loud_before} -> {loud_after}"
    );
    let gain_db = 20.0 * (quiet_after / quiet_before).log10();
    assert!(
        gain_db > 6.0,
        "quiet section should be raised, got {gain_db:.1} dB"
    );
    assert!(
        gain_db <= 12.2,
        "boost must respect the cap, got {gain_db:.1} dB"
    );
}

#[test]
fn leveler_leaves_pauses_relative_to_their_surroundings() {
    let sr = 48000;
    // Speech, then a room-tone pause, then speech again.
    let mut x = sine(150.0, 2.0, sr, 0.4);
    x.extend(vec![0.002f64; (2.0 * sr as f64) as usize]); // -54 dBFS room tone
    x.extend(sine(150.0, 2.0, sr, 0.4));
    let y = enhance::level(&x, sr, 12.0, 3.0);
    let n = sr as usize;
    let speech = rms(&y[0..n]);
    let pause = rms(&y[3 * n..4 * n]);
    // The pause must stay far below the speech: lifting it would break the
    // silence detector, which is the whole reason the gain is held through it.
    assert!(
        pause < speech * 0.1,
        "pause rose to {pause} against speech {speech}"
    );
}

#[test]
fn leveler_keeps_silence_silent_and_stays_finite() {
    let sr = 48000;
    let x = vec![0.0f64; sr as usize];
    let y = enhance::level(&x, sr, 12.0, 3.0);
    assert_eq!(y.len(), x.len());
    assert!(y.iter().all(|v| v.is_finite() && v.abs() < 1e-12));
}

#[test]
fn silence_is_still_detected_after_leveling() {
    use fasttalk_core::rate::silence_zones_f32;
    let sr = 48000;
    let speech = sine(150.0, 0.5, sr, 0.3);
    let quiet = sine(150.0, 0.5, sr, 0.03); // 20 dB down: the far speaker
    let mut x = Vec::new();
    x.extend(&speech);
    x.extend(vec![0.0f64; (1.5 * sr as f64) as usize]);
    x.extend(&quiet);
    x.extend(vec![0.0f64; (1.5 * sr as f64) as usize]);
    x.extend(&speech);

    let y = enhance::level(&x, sr, 12.0, 3.0);
    let y32: Vec<f32> = y.iter().map(|v| *v as f32).collect();
    let zones = silence_zones_f32(&y32, sr, 0.5);
    assert_eq!(
        zones.len(),
        4,
        "expected the two gaps to survive leveling, got {zones:?}"
    );
}

#[test]
fn leveler_does_not_introduce_steps() {
    let sr = 48000;
    let x = uneven(sr);
    let y = enhance::level(&x, sr, 12.0, 3.0);
    let source_step = x.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f64, f64::max);
    let out_step = y.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f64, f64::max);
    assert!(
        out_step <= source_step * 4.0,
        "leveling introduced a step: {out_step} against {source_step}"
    );
}
