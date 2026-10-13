//! Offline cleanup and enhancement applied to the source before it is stretched.
//!
//! Stages, in the order the client runs them: a rumble high-pass, RNNoise
//! denoise (client side), a voice leveler, a consonant boost, normalize (client
//! side) and a lookahead limiter. Everything here is O(n) and single-pass, built
//! on RBJ biquads, so a long recording does not pay a convolution.
//!
//! Stretching exaggerates noise and breath, so this runs before the DSP rather
//! than after it (S-5); the consonant shelf follows clear-speech practice of
//! raising soft consonants relative to vowels (S-4); the limiter is the
//! "after Norm" half of S-13.
//!
//! The stages work *in place* on any sample type through [`Sample`]. The client
//! keeps audio as `f32`, so an `f32` in-place pass costs one buffer instead of
//! the input copy, the `f64` expansion and the output copy a `&[f32] -> Vec<f64>`
//! API paid for each stage: about 24 bytes per sample of WASM heap, which put a
//! one-hour recording over wasm32's 4 GiB ceiling.

const EPS: f64 = 1e-12;
/// Butterworth Q.
const Q_BUTTERWORTH: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// A sample type the stages can read and write in place.
pub trait Sample: Copy {
    fn to_f64(self) -> f64;
    fn from_f64(v: f64) -> Self;
}

impl Sample for f32 {
    #[inline]
    fn to_f64(self) -> f64 {
        self as f64
    }
    #[inline]
    fn from_f64(v: f64) -> Self {
        v as f32
    }
}

impl Sample for f64 {
    #[inline]
    fn to_f64(self) -> f64 {
        self
    }
    #[inline]
    fn from_f64(v: f64) -> Self {
        v
    }
}

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

    /// Direct-form-I pass into `out`. The filter is minimum-phase; for a rumble
    /// filter and a shelf that is the normal choice and inaudible on speech.
    fn process_into<S: Sample>(&self, x: &[S], out: &mut [S]) {
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for (i, &v) in x.iter().enumerate() {
            let xin = v.to_f64();
            let y = self.b0 * xin + self.b1 * x1 + self.b2 * x2 - self.a1 * y1 - self.a2 * y2;
            out[i] = S::from_f64(y);
            x2 = x1;
            x1 = xin;
            y2 = y1;
            y1 = y;
        }
    }
}

/// One-pole smoothing coefficient for a time constant in seconds.
fn pole(sr: u32, seconds: f64) -> f64 {
    (-1.0 / (seconds.max(1e-6) * sr as f64)).exp()
}

fn hop_samples(sr: u32) -> usize {
    ((0.010 * sr as f64) as usize).max(1)
}

fn frame_samples(sr: u32) -> usize {
    ((0.020 * sr as f64) as usize).max(2)
}

/// Remove rumble and hum below `cutoff_hz` (12 dB/octave), in place.
pub fn highpass_in_place<S: Sample>(x: &mut [S], sr: u32, cutoff_hz: f64) {
    let biquad = Biquad::highpass(sr, cutoff_hz, Q_BUTTERWORTH);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    for v in x.iter_mut() {
        let xin = v.to_f64();
        let y = biquad.b0 * xin + biquad.b1 * x1 + biquad.b2 * x2 - biquad.a1 * y1 - biquad.a2 * y2;
        x2 = x1;
        x1 = xin;
        y2 = y1;
        y1 = y;
        *v = S::from_f64(y);
    }
}

/// Remove rumble and hum below `cutoff_hz` (12 dB/octave).
pub fn highpass<S: Sample>(x: &[S], sr: u32, cutoff_hz: f64) -> Vec<S> {
    let mut out = x.to_vec();
    highpass_in_place(&mut out, sr, cutoff_hz);
    out
}

/// Raise the band above `corner_hz` by `gain_db`, with `amount` (0..1) of light
/// compression on that band so loud sibilants do not run away.
///
/// The compressor's threshold comes from the recording's own high-band level, an
/// upper percentile of the band's frame levels. The previous absolute -30 dBFS
/// threshold made the stage level-dependent: net high-band gain was +6 dB on
/// quiet audio and negative on loud audio, so one setting did opposite things at
/// different input levels and strong fricatives were cut rather than lifted.
pub fn consonant_boost_in_place<S: Sample>(
    x: &mut [S],
    sr: u32,
    corner_hz: f64,
    gain_db: f64,
    amount: f64,
) {
    let mut amount = amount.clamp(0.0, 1.0);
    let shelf = 10f64.powf(gain_db / 20.0);
    // Complementary split: `low + (x - low)` is exactly `x`, so the sum below
    // reconstructs the signal even though the biquad is minimum-phase.
    let mut low = vec![S::from_f64(0.0); x.len()];
    Biquad::lowpass(sr, corner_hz, Q_BUTTERWORTH).process_into(x, &mut low);

    let band_levels = high_band_frame_levels(x, &low, sr);
    if band_levels.is_empty() {
        // Too short to measure the band: the shelf alone, no compression.
        amount = 0.0;
    }
    let threshold_db = percentile(&band_levels, 85) - CONSONANT_THRESHOLD_BELOW_REF_DB;

    let attack = pole(sr, 0.005);
    let release = pole(sr, 0.100);
    const RATIO: f64 = 2.0;
    const KNEE_DB: f64 = 12.0;

    let mut env = 0.0f64;
    for i in 0..x.len() {
        let low_v = low[i].to_f64();
        let high = x[i].to_f64() - low_v;
        let a = high.abs();
        let coeff = if a > env { attack } else { release };
        env = a + coeff * (env - a);
        let level_db = 20.0 * env.max(EPS).log10();
        let over = level_db - threshold_db;
        let reduction_db = if over <= -KNEE_DB / 2.0 {
            0.0
        } else if over >= KNEE_DB / 2.0 {
            -over * (1.0 - 1.0 / RATIO)
        } else {
            -((over + KNEE_DB / 2.0).powi(2) / (2.0 * KNEE_DB)) * (1.0 - 1.0 / RATIO)
        };
        let gain = 10f64.powf(reduction_db / 20.0);
        let applied = 1.0 + (gain - 1.0) * amount;
        x[i] = S::from_f64(low_v + high * shelf * applied);
    }
}

/// Raise the band above `corner_hz` by `gain_db`, with `amount` (0..1) of light
/// compression on that band.
pub fn consonant_boost<S: Sample>(
    x: &[S],
    sr: u32,
    corner_hz: f64,
    gain_db: f64,
    amount: f64,
) -> Vec<S> {
    let mut out = x.to_vec();
    consonant_boost_in_place(&mut out, sr, corner_hz, gain_db, amount);
    out
}

/// Frame RMS in dBFS: 20 ms frames on a 10 ms hop.
fn frame_levels_db<S: Sample>(x: &[S], sr: u32) -> Vec<f64> {
    let frame = frame_samples(sr);
    let hop = hop_samples(sr);
    if x.len() < frame {
        return Vec::new();
    }
    let n = 1 + (x.len() - frame) / hop;
    (0..n)
        .map(|i| {
            let base = i * hop;
            let sum: f64 = x[base..base + frame]
                .iter()
                .map(|v| {
                    let v = v.to_f64();
                    v * v
                })
                .sum();
            20.0 * (sum / frame as f64).sqrt().max(EPS).log10()
        })
        .collect()
}

/// Frame levels of the high band `x - low`, for the consonant compressor.
fn high_band_frame_levels<S: Sample>(x: &[S], low: &[S], sr: u32) -> Vec<f64> {
    let frame = frame_samples(sr);
    let hop = hop_samples(sr);
    if x.len() < frame {
        return Vec::new();
    }
    let n = 1 + (x.len() - frame) / hop;
    (0..n)
        .map(|i| {
            let base = i * hop;
            let sum: f64 = (base..base + frame)
                .map(|j| {
                    let h = x[j].to_f64() - low[j].to_f64();
                    h * h
                })
                .sum();
            20.0 * (sum / frame as f64).sqrt().max(EPS).log10()
        })
        .collect()
}

/// A percentile of `v`, clamped to `pct` in 0..=100.
fn percentile(v: &[f64], pct: usize) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut sorted = v.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    sorted[((sorted.len() - 1) * pct.min(100)) / 100]
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

/// Moving percentile over `width` frames, with the window truncated at the edges.
fn moving_percentile(v: &[f64], width: usize, pct: usize) -> Vec<f64> {
    let n = v.len();
    if n == 0 {
        return Vec::new();
    }
    let pct = pct.min(100);
    let half = (width.max(1) / 2) as isize;
    let mut out = Vec::with_capacity(n);
    let mut window = Vec::with_capacity(width.max(1));
    for i in 0..n {
        let lo = (i as isize - half).max(0) as usize;
        let hi = ((i as isize + half + 1) as usize).min(n);
        window.clear();
        window.extend_from_slice(&v[lo..hi]);
        let k = (window.len() - 1) * pct / 100;
        let (_, value, _) = window.select_nth_unstable_by(k, |a, b| {
            a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
        });
        out.push(*value);
    }
    out
}

/// A run of frames judged to be speech, as inclusive frame indices.
#[derive(Debug, Clone, Copy)]
struct SpeechRun {
    first: usize,
    last: usize,
}

/// Group frames above `gate_db` into runs, merging gaps of up to `max_gap`
/// frames so a breath inside a sentence does not split an utterance.
fn speech_runs(levels: &[f64], gate_db: f64, max_gap: usize) -> Vec<SpeechRun> {
    let n = levels.len();
    let mut runs = Vec::new();
    let mut i = 0;
    while i < n {
        if levels[i] <= gate_db {
            i += 1;
            continue;
        }
        let first = i;
        let mut last = i;
        let mut j = i + 1;
        while j < n {
            if levels[j] > gate_db {
                last = j;
                j += 1;
                continue;
            }
            let mut k = j;
            while k < n && levels[k] <= gate_db {
                k += 1;
            }
            if k < n && k - j <= max_gap {
                j = k;
            } else {
                break;
            }
        }
        runs.push(SpeechRun { first, last });
        i = j.max(first + 1);
    }
    runs
}

/// The recording's noise floor: the median level of frames below the speech
/// gate. With no measurable pauses, assume a floor far below the loud level so
/// the cap is not constrained by an absent measurement.
fn noise_floor_db(levels: &[f64], gate_db: f64, loud_db: f64) -> f64 {
    let quiet: Vec<f64> = levels.iter().copied().filter(|v| *v <= gate_db).collect();
    if quiet.is_empty() {
        loud_db - ASSUMED_FLOOR_DB
    } else {
        percentile(&quiet, 50)
    }
}

/// Gain that lifts `level_db` toward `loud_db`, upward only and capped.
fn gain_for(loud_db: f64, level_db: f64, cap_db: f64) -> f64 {
    10f64.powf((loud_db - level_db).clamp(0.0, cap_db) / 20.0)
}

/// How far below the loud level a frame may sit and still count as speech. A
/// quiet speaker 20-30 dB down is speech; a pause is further down than this.
const SPEECH_GATE_DB: f64 = 35.0;
/// A frame this far below the loud level may still rise, so a leveler pass
/// cannot lift a transient that is already near the loud level.
const TRANSIENT_HEADROOM_DB: f64 = 6.0;
/// Shortest gap that separates two utterances.
const MIN_PAUSE_S: f64 = 0.25;
/// Utterances at most this long get one flat gain, so a turn's first and last
/// words are lifted as much as its middle. Longer stretches track the windowed
/// estimate instead, which follows a slow drift.
const FLAT_RUN_MAX_S: f64 = 10.0;
/// Assumed floor (below the loud level) when no pause was measured.
const ASSUMED_FLOOR_DB: f64 = 60.0;
/// Least signal-to-noise the result may have: a passage is not lifted so far
/// that its noise floor ends up closer than this to the loud level.
const MIN_SNR_DB: f64 = 20.0;

/// Hold unity gain through the pauses, ramping to the next utterance's gain so
/// that the gain an utterance starts and ends with is its own. This is what
/// fixes turn-taking: with a windowed estimate alone, the loud speaker in the
/// window pulled a quiet turn's first and last half second down to a partial
/// boost while the middle of the turn got the full one.
fn ramp_pauses(gains: &mut [f64], runs: &[SpeechRun], ramp_frames: usize) {
    let n = gains.len();
    if runs.is_empty() {
        for g in gains.iter_mut() {
            *g = 1.0;
        }
        return;
    }
    let ramp = ramp_frames.max(1);
    let run_gain: Vec<f64> = runs
        .iter()
        .map(|r| gains[r.first.min(n.saturating_sub(1))])
        .collect();

    let first = runs[0].first.min(n);
    let start = first.saturating_sub(ramp);
    for i in 0..first {
        gains[i] = if i < start {
            1.0
        } else {
            let t = (i - start + 1) as f64 / (first - start + 1) as f64;
            1.0 + (run_gain[0] - 1.0) * t
        };
    }
    for k in 0..runs.len().saturating_sub(1) {
        let a = runs[k].last + 1;
        let b = runs[k + 1].first;
        if b <= a {
            continue;
        }
        let span = (b - a) as f64;
        for i in a..b {
            let t = (i - a + 1) as f64 / (span + 1.0);
            gains[i] = run_gain[k] + (run_gain[k + 1] - run_gain[k]) * t;
        }
    }
    let last = runs[runs.len() - 1].last;
    let end = (last + ramp + 1).min(n);
    for i in (last + 1)..n {
        gains[i] = if i >= end {
            1.0
        } else {
            let t = (i - last) as f64 / (end - last).max(1) as f64;
            run_gain[run_gain.len() - 1] * (1.0 - t) + t
        };
    }
}

/// Apply a per-frame gain curve in place, interpolating between frame centres.
fn apply_gains<S: Sample>(x: &mut [S], gains: &[f64], hop: usize) {
    for (i, v) in x.iter_mut().enumerate() {
        let pos = i as f64 / hop as f64;
        let f = pos.floor() as usize;
        let frac = pos - f as f64;
        let g0 = gains.get(f).copied().unwrap_or(1.0);
        let g1 = gains.get(f + 1).copied().unwrap_or(g0);
        *v = S::from_f64(v.to_f64() * (g0 + (g1 - g0) * frac));
    }
}

/// Bring quiet passages up toward the level of the loud ones, in place.
///
/// This is a seconds-long leveler, not short-term compression: the problem it
/// addresses is a whole sentence or section being quieter, as when one speaker
/// is far from the microphone. Gain is applied only upward, capped at
/// `max_boost_db`, and the cap is further limited by the recording's own
/// headroom above its noise floor, so lifting a passage cannot bring its noise
/// up with it.
///
/// Utterances are levelled one at a time: frames above a gate are grouped into
/// runs, each short run gets a single gain measured from its own speech level,
/// and the gain ramps across the pauses between runs. A windowed estimate alone
/// left a quiet turn's first and last half second under-boosted whenever the
/// window still held the previous, louder speaker.
///
/// Frames that are already near the loud level are not lifted with their
/// passage, so a thump or click cannot be pushed into the limiter by a boost
/// meant for the quiet speech around it.
pub fn level_in_place<S: Sample>(x: &mut [S], sr: u32, max_boost_db: f64, window_s: f64) {
    let levels = frame_levels_db(x, sr);
    if levels.is_empty() {
        return;
    }
    let hop = hop_samples(sr);
    let width = ((window_s * sr as f64 / hop as f64).round() as usize).max(1);
    let local = moving_percentile(&levels, width, 75);

    // The loud level is a high percentile of the frame levels, so a single spike
    // cannot set the target -- the same reasoning as the silence detector.
    let loud_db = percentile(&levels, 90);
    let gate_db = loud_db - SPEECH_GATE_DB;
    let noise_db = noise_floor_db(&levels, gate_db, loud_db);
    let cap_db = max_boost_db.min((loud_db - MIN_SNR_DB - noise_db).max(0.0));

    // Windowed estimate first: it tracks a slow drift inside a long stretch.
    let mut gains = vec![1.0f64; levels.len()];
    for i in 0..levels.len() {
        if levels[i] > gate_db {
            gains[i] = gain_for(loud_db, local[i], cap_db);
        }
    }

    let max_gap = ((MIN_PAUSE_S * sr as f64 / hop as f64).round() as usize).max(1);
    let runs = speech_runs(&levels, gate_db, max_gap);
    let flat_limit = FLAT_RUN_MAX_S * sr as f64 / hop as f64;
    for run in &runs {
        let frames = (run.last - run.first + 1) as f64;
        if frames > flat_limit {
            continue;
        }
        let run_level = percentile(&levels[run.first..=run.last], 75);
        let gain = gain_for(loud_db, run_level, cap_db);
        for g in gains.iter_mut().take(run.last + 1).skip(run.first) {
            *g = gain;
        }
    }

    let ramp_frames = ((0.3 * sr as f64 / hop as f64).round() as usize).max(1);
    ramp_pauses(&mut gains, &runs, ramp_frames);

    let smooth_width = ((0.3 * sr as f64 / hop as f64).round() as usize).max(1);
    let mut gains = moving_average(&gains, smooth_width);

    // A transient is not lifted with the passage it sits in. This runs after the
    // smoothing: a 20 ms thump is only a couple of frames, so a cap applied
    // before the average would be smeared straight back over it by its
    // neighbours, which still carry the passage's full boost.
    for i in 0..levels.len() {
        let ceiling = 10f64.powf((loud_db + TRANSIENT_HEADROOM_DB - levels[i]).max(0.0) / 20.0);
        if ceiling < gains[i] {
            gains[i] = ceiling;
        }
    }

    // Spread the cap one frame either side. The gain actually applied is
    // interpolated between frame centres, so a cap that stopped at the
    // transient's last frame was interpolated back up toward the next frame's
    // passage gain across that frame, amplifying the tail of the event anyway.
    let capped = gains.clone();
    for i in 0..gains.len() {
        let left = if i > 0 { capped[i - 1] } else { capped[i] };
        let right = if i + 1 < capped.len() { capped[i + 1] } else { capped[i] };
        gains[i] = capped[i].min(left).min(right);
    }

    apply_gains(x, &gains, hop);
}

/// Bring quiet passages up toward the level of the loud ones.
pub fn level<S: Sample>(x: &[S], sr: u32, max_boost_db: f64, window_s: f64) -> Vec<S> {
    let mut out = x.to_vec();
    level_in_place(&mut out, sr, max_boost_db, window_s);
    out
}

/// Soft-knee waveshaper that asymptotes just below `ceiling`.
///
/// The knee sits at 98% of the ceiling: it is a last-resort clamp for an
/// overshoot the lookahead gain did not catch, not a shaper for material that is
/// legitimately near the ceiling. At 90% it distorted everything above -1.9 dBFS.
fn soft_knee(v: f64, ceiling: f64) -> f64 {
    let knee = 0.98 * ceiling;
    let a = v.abs();
    if a <= knee {
        return v;
    }
    let over = (a - knee) / (ceiling - knee).max(EPS);
    v.signum() * (knee + (ceiling - knee) * over.tanh())
}

/// Lookahead, in seconds: how far ahead the limiter sees a peak.
const LIMIT_LOOKAHEAD_S: f64 = 0.003;
/// Gain attack: must be shorter than the lookahead so the gain is down in time.
const LIMIT_ATTACK_S: f64 = 0.0005;
/// Gain release: how long the limiter takes to come back after a peak.
const LIMIT_RELEASE_S: f64 = 0.150;
/// Peaks are placed this far below the ceiling, so the final clamp does not
/// touch them.
const LIMIT_TARGET: f64 = 0.98;

/// `|x|` maxima over a forward window of `look` samples, via a monotonic deque.
fn forward_max_abs<S: Sample>(x: &[S], look: usize) -> Vec<f64> {
    let n = x.len();
    let mut out = vec![0.0f64; n];
    let mut deque: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    for i in (0..n).rev() {
        let v = x[i].to_f64().abs();
        while let Some(&back) = deque.back() {
            if x[back].to_f64().abs() <= v {
                deque.pop_back();
            } else {
                break;
            }
        }
        deque.push_back(i);
        while let Some(&front) = deque.front() {
            if front > i + look - 1 {
                deque.pop_front();
            } else {
                break;
            }
        }
        out[i] = deque.front().map(|j| x[*j].to_f64().abs()).unwrap_or(v);
    }
    out
}

/// Peak limiter with lookahead, in place.
///
/// The gain comes from the largest sample in the next few milliseconds, so it is
/// already down when a peak arrives. The previous envelope follower reacted
/// after the peak and the waveshaper then distorted the overshoot (about 2% THD
/// over the ceiling, and 0.15% even below it).
pub fn soft_limiter_in_place<S: Sample>(x: &mut [S], sr: u32, ceiling_db: f64) {
    let n = x.len();
    if n == 0 {
        return;
    }
    let ceiling = 10f64.powf(ceiling_db.min(0.0) / 20.0);
    let target_level = ceiling * LIMIT_TARGET;
    let look = ((LIMIT_LOOKAHEAD_S * sr as f64) as usize).max(1);
    let ahead = forward_max_abs(x, look);

    let attack = pole(sr, LIMIT_ATTACK_S);
    let release = pole(sr, LIMIT_RELEASE_S);
    let mut gain = 1.0f64;
    for i in 0..n {
        let target = if ahead[i] > target_level {
            target_level / ahead[i]
        } else {
            1.0
        };
        let coeff = if target < gain { attack } else { release };
        gain = target + coeff * (gain - target);
        let v = x[i].to_f64() * gain;
        x[i] = S::from_f64(soft_knee(v, ceiling));
    }
}

/// Peak limiter to `ceiling_db` (S-13).
pub fn soft_limiter<S: Sample>(x: &[S], sr: u32, ceiling_db: f64) -> Vec<S> {
    let mut out = x.to_vec();
    soft_limiter_in_place(&mut out, sr, ceiling_db);
    out
}

/// Threshold, below the band's own upper percentile, where the consonant
/// compressor starts to work.
const CONSONANT_THRESHOLD_BELOW_REF_DB: f64 = 6.0;
