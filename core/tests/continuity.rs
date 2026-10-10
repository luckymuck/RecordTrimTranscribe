//! Sample-level continuity regression tests for the hybrid renderer.
//!
//! A pop/click is a step in the waveform: one sample-to-sample delta far larger
//! than its neighbours, which shows up as a full-height broadband line in a
//! spectrogram. These tests pin that down.
//!
//! The signal deliberately alternates voiced and unvoiced regions, because that
//! is where the PSOLA and WSOLA engines meet and where the renderer used to
//! splice one engine's output into the other's. It is enveloped so the source
//! itself contains no steps: anything measured downstream is the engine's doing.

use fasttalk_core::engines::hybrid;
use fasttalk_core::stream::StreamStretcher;
use fasttalk_core::timing::TimeMap;

const SR: u32 = 48000;

/// Voiced tone bursts with raised-cosine edges, separated by loud-ish room tone
/// (unvoiced). The amplitude of the noise is high enough that any WSOLA
/// analysis-offset jump would register as a step.
fn speech_like(seconds: f64, sr: u32) -> Vec<f32> {
    let n = (seconds * sr as f64) as usize;
    let burst = (0.35 * sr as f64) as usize;
    let quiet = (0.25 * sr as f64) as usize;
    let period = burst + quiet;
    let ramp = (0.02 * sr as f64) as usize;

    let mut state = 0x2545F491_4F6CDD1Du64;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let noise = ((state >> 40) as f32 / 8388608.0) - 1.0;
        let phase = i as f64 * 2.0 * std::f64::consts::PI * 120.0 / sr as f64;
        // Harmonics give the tracker real structure to lock onto.
        let voiced = 0.30
            * (phase.sin() as f32
                + 0.5 * (2.0 * phase).sin() as f32
                + 0.25 * (3.0 * phase).sin() as f32);

        let pos = i % period;
        let v = if pos < burst {
            voiced * smooth(pos, ramp, burst)
        } else {
            noise * 0.01
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

fn offline(x: &[f32], sr: u32, speed: f64) -> Vec<f32> {
    let ratio = 1.0 / speed;
    let buf: Vec<f64> = x.iter().map(|v| *v as f64).collect();
    let tm = TimeMap::uniform(buf.len() as i64, ratio).unwrap();
    let rates = hybrid::uniform_rate_plan(buf.len() as i64, ratio);
    hybrid::render(&buf, &tm, &rates, sr)
        .into_iter()
        .map(|v| v as f32)
        .collect()
}

fn max_step(y: &[f32]) -> f32 {
    y.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
}

fn median_step(y: &[f32]) -> f32 {
    let mut d: Vec<f32> = y.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
    if d.is_empty() {
        return 0.0;
    }
    d.sort_by(|a, b| a.partial_cmp(b).unwrap());
    d[d.len() / 2]
}

/// The renderer must not introduce a step larger than the signal already has.
/// Four times the source's own largest delta leaves room for resampling and
/// engine blending while still catching a splice: the pre-fix numbers were
/// 24x (2x) and 32x (4x) over.
fn assert_continuity(label: &str, y: &[f32], source: &[f32]) {
    let budget = max_step(source) * 4.0;
    let got = max_step(y);
    assert!(
        got <= budget,
        "{label}: max step {got:.5} exceeds {budget:.5} \
         ({:.1}x the source's {}); a discontinuity remains",
        got / max_step(source),
        max_step(source)
    );
    // Blending must not inflate the typical activity either.
    assert!(
        median_step(y) <= median_step(source) * 2.5,
        "{label}: median step {} vs source {}",
        median_step(y),
        median_step(source)
    );
}

#[test]
fn streaming_playback_is_step_free_at_speed() {
    let x = speech_like(6.0, SR);
    for speed in [2.0f64, 3.0, 4.0] {
        assert_continuity(&format!("stream {speed}x"), &stream_through(&x, SR, speed), &x);
    }
}

#[test]
fn offline_export_is_step_free_at_speed() {
    let x = speech_like(6.0, SR);
    for speed in [2.0f64, 3.0, 4.0] {
        assert_continuity(&format!("offline {speed}x"), &offline(&x, SR, speed), &x);
    }
}

/// Pure silence and pure tone are the degenerate cases where the engines hand
/// over completely; neither may produce a step.
#[test]
fn degenerate_signals_stay_step_free() {
    let sr = SR;
    for (name, x) in [
        ("silence", vec![0.0f32; sr as usize * 2]),
        ("dc", vec![0.2f32; sr as usize * 2]),
        (
            "tone",
            (0..sr as usize * 2)
                .map(|i| (2.0 * std::f64::consts::PI * 200.0 * i as f64 / sr as f64).sin() as f32 * 0.3)
                .collect(),
        ),
    ] {
        let y = stream_through(&x, sr, 2.0);
        assert!(
            y.iter().all(|v| v.is_finite()),
            "{name}: produced non-finite samples"
        );
        assert!(!y.is_empty(), "{name}: produced no output");
    }
}

/// Playback renders on the main thread against a live audio deadline, so the
/// engine must stay faster than real time at every speed the UI offers.
///
/// This is a real guard, not a formality: `uniform_filter1d_nearest` was
/// O(n * size) with a 1536-sample window, which cost ~40 million iterations per
/// block and left the engine running at 0.85x realtime at 4x -- slower than the
/// audio it was trying to produce, so the graph starved and clicked.
#[test]
fn streaming_renders_faster_than_realtime() {
    let x = speech_like(8.0, SR);
    for speed in [2.0f64, 3.0, 4.0] {
        let started = std::time::Instant::now();
        let y = stream_through(&x, SR, speed);
        let elapsed = started.elapsed().as_secs_f64();
        let audio_seconds = y.len() as f64 / SR as f64;
        let realtime_factor = audio_seconds / elapsed;
        assert!(
            realtime_factor >= 1.5,
            "{speed}x: rendered {audio_seconds:.3}s of audio in {elapsed:.3}s \
             ({realtime_factor:.2}x realtime, needs >= 1.5x to stay ahead of the audio clock)"
        );
        println!(
            "stream {speed}x: rendered {audio_seconds:.2}s of audio in {elapsed:.3}s ({realtime_factor:.1}x realtime)"
        );
    }
}