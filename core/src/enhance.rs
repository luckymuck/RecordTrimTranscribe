//! Offline cleanup and enhancement applied to the source before it is stretched.
//!
//! Three stages, in the order the client runs them: a rumble high-pass, a
//! consonant boost (high-shelf plus light high-band compression), and a soft
//! limiter. All three are O(n) single-pass filters built on RBJ biquads, so a
//! long recording does not pay a convolution.
//!
//! Stretching exaggerates noise and breath, so this runs before the DSP rather
//! than after it (S-5); the consonant shelf follows clear-speech practice of
//! raising soft consonants relative to vowels (S-4); the limiter is the
//! "after Norm" half of S-13.

const EPS: f64 = 1e-12;
/// Butterworth Q.
const Q_BUTTERWORTH: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// A normalised RBJ biquad (a0 = 1).
#[derive(Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    fn from_raw(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    fn lowpass(sr: u32, cutoff_hz: f64, q: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * (cutoff_hz / sr as f64).clamp(1e-6, 0.49);
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q.max(1e-3));
        Self::from_raw(
            (1.0 - cos) / 2.0,
            1.0 - cos,
            (1.0 - cos) / 2.0,
            1.0 + alpha,
            -2.0 * cos,
            1.0 - alpha,
        )
    }

    fn highpass(sr: u32, cutoff_hz: f64, q: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * (cutoff_hz / sr as f64).clamp(1e-6, 0.49);
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q.max(1e-3));
        Self::from_raw(
            (1.0 + cos) / 2.0,
            -(1.0 + cos),
            (1.0 + cos) / 2.0,
            1.0 + alpha,
            -2.0 * cos,
            1.0 - alpha,
        )
    }

    /// Direct-form-I pass. The filter is minimum-phase; for a rumble filter and
    /// a shelf that is the normal choice and inaudible on speech.
    fn process(&self, x: &[f64]) -> Vec<f64> {
        let mut out = vec![0.0f64; x.len()];
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for (i, &v) in x.iter().enumerate() {
            let y = self.b0 * v + self.b1 * x1 + self.b2 * x2 - self.a1 * y1 - self.a2 * y2;
            out[i] = y;
            x2 = x1;
            x1 = v;
            y2 = y1;
            y1 = y;
        }
        out
    }
}

/// One-pole smoothing coefficient for a time constant in seconds.
fn pole(sr: u32, seconds: f64) -> f64 {
    (-1.0 / (seconds.max(1e-6) * sr as f64)).exp()
}

/// Remove rumble and hum below `cutoff_hz` (12 dB/octave).
pub fn highpass(x: &[f64], sr: u32, cutoff_hz: f64) -> Vec<f64> {
    Biquad::highpass(sr, cutoff_hz, Q_BUTTERWORTH).process(x)
}

/// Raise the band above `corner_hz` by `gain_db`, with `amount` (0..1) of light
/// compression on that band so loud sibilants do not run away.
pub fn consonant_boost(x: &[f64], sr: u32, corner_hz: f64, gain_db: f64, amount: f64) -> Vec<f64> {
    let amount = amount.clamp(0.0, 1.0);
    let shelf = 10f64.powf(gain_db / 20.0);
    // Complementary split: `low + (x - low)` is exactly `x`, so the sum below
    // reconstructs the signal even though the biquad is minimum-phase.
    let low = Biquad::lowpass(sr, corner_hz, Q_BUTTERWORTH).process(x);
    let attack = pole(sr, 0.005);
    let release = pole(sr, 0.100);
    const THRESHOLD_DB: f64 = -30.0;
    const RATIO: f64 = 2.0;
    const KNEE_DB: f64 = 12.0;

    let mut env = 0.0f64;
    let mut out = Vec::with_capacity(x.len());
    for i in 0..x.len() {
        let high = x[i] - low[i];
        let a = high.abs();
        let coeff = if a > env { attack } else { release };
        env = a + coeff * (env - a);
        let level_db = 20.0 * env.max(EPS).log10();
        let over = level_db - THRESHOLD_DB;
        let reduction_db = if over <= -KNEE_DB / 2.0 {
            0.0
        } else if over >= KNEE_DB / 2.0 {
            -over * (1.0 - 1.0 / RATIO)
        } else {
            -((over + KNEE_DB / 2.0).powi(2) / (2.0 * KNEE_DB)) * (1.0 - 1.0 / RATIO)
        };
        let gain = 10f64.powf(reduction_db / 20.0);
        let applied = 1.0 + (gain - 1.0) * amount;
        out.push(low[i] + high * shelf * applied);
    }
    out
}

/// Frame RMS in dBFS: 20 ms frames on a 10 ms hop.
fn frame_levels_db(x: &[f64], sr: u32) -> Vec<f64> {
    let frame = ((0.020 * sr as f64) as usize).max(2);
    let hop = ((0.010 * sr as f64) as usize).max(1);
    if x.len() < frame {
        return Vec::new();
    }
    let n = 1 + (x.len() - frame) / hop;
    (0..n)
        .map(|i| {
            let base = i * hop;
            let sum: f64 = x[base..base + frame].iter().map(|v| v * v).sum();
            20.0 * (sum / frame as f64).sqrt().max(EPS).log10()
        })
        .collect()
}

/// Moving average over `width` frames, with the window truncated at the edges.
fn moving_average(v: &[f64], width: usize) -> Vec<f64> {
    let n = v.len();
    if n == 0 || width <= 1 {
        return v.to_vec();
    }
    let half = (width / 2) as isize;
    let mut out = vec![0.0f64; n];
    for i in 0..n {
        let lo = (i as isize - half).max(0) as usize;
        let hi = ((i as isize + half + 1) as usize).min(n);
        let sum: f64 = v[lo..hi].iter().sum();
        out[i] = sum / (hi - lo) as f64;
    }
    out
}

/// Bring quiet passages up toward the level of the loud ones.
///
/// This is a seconds-long leveler, not short-term compression: the problem it
/// addresses is a whole sentence or section being quieter, as when one speaker
/// is far from the microphone. Gain is applied only upward, capped at
/// `max_boost_db`, and it is *held* below a gate so pauses are not lifted --
/// which is what keeps silence detection working on the result. The gain curve
/// is then smoothed so there is no step at a section boundary.
pub fn level(x: &[f64], sr: u32, max_boost_db: f64, window_s: f64) -> Vec<f64> {
    let levels = frame_levels_db(x, sr);
    if levels.is_empty() {
        return x.to_vec();
    }
    let hop = ((0.010 * sr as f64) as usize).max(1);
    let width = ((window_s * sr as f64 / hop as f64).round() as usize).max(1);
    let smoothed = moving_average(&levels, width);

    // The loud level is a high percentile of the smoothed envelope, so a single
    // spike cannot set the target -- the same reasoning as the silence detector.
    let mut sorted = smoothed.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let loud_db = sorted[(sorted.len() * 90) / 100];
    let gate_db = loud_db - 40.0;

    let mut gains = vec![1.0f64; smoothed.len()];
    let mut held = 1.0f64;
    for (i, db) in smoothed.iter().enumerate() {
        if *db <= gate_db {
            // A pause keeps whatever gain its surroundings had.
            gains[i] = held;
        } else {
            let boost = (loud_db - db).clamp(0.0, max_boost_db);
            gains[i] = 10f64.powf(boost / 20.0);
            held = gains[i];
        }
    }
    let smooth_width = ((0.3 * sr as f64 / hop as f64).round() as usize).max(1);
    let gains = moving_average(&gains, smooth_width);

    // Apply, interpolating between frame centres.
    let mut out = Vec::with_capacity(x.len());
    for (i, &v) in x.iter().enumerate() {
        let pos = i as f64 / hop as f64;
        let f = pos.floor() as usize;
        let frac = pos - f as f64;
        let g0 = gains.get(f).copied().unwrap_or(1.0);
        let g1 = gains.get(f + 1).copied().unwrap_or(g0);
        out.push(v * (g0 + (g1 - g0) * frac));
    }
    out
}

/// Soft-knee waveshaper that asymptotes just below `ceiling`.
fn soft_knee(v: f64, ceiling: f64) -> f64 {
    let knee = 0.9 * ceiling;
    let a = v.abs();
    if a <= knee {
        return v;
    }
    let over = (a - knee) / (ceiling - knee).max(EPS);
    v.signum() * (knee + (ceiling - knee) * over.tanh())
}

/// Peak limiter: a fast attack and slow release keep sustained loud passages
/// under `ceiling_db`, and a soft knee guarantees the ceiling is never exceeded
/// even on a transient the envelope missed.
pub fn soft_limiter(x: &[f64], sr: u32, ceiling_db: f64) -> Vec<f64> {
    let ceiling = 10f64.powf(ceiling_db.min(0.0) / 20.0);
    let attack = pole(sr, 0.0005);
    let release = pole(sr, 0.050);
    let mut env = 0.0f64;
    let mut out = Vec::with_capacity(x.len());
    for &s in x {
        let a = s.abs();
        let coeff = if a > env { attack } else { release };
        env = a + coeff * (env - a);
        let gain = if env > ceiling { ceiling / env } else { 1.0 };
        out.push(soft_knee(s * gain, ceiling));
    }
    out
}
