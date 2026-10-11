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
