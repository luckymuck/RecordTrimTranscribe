//! Tests for skipping silence: the real-time `skip_to` jump and the offline
//! skip-silence export.

use fasttalk_core::api::{silence_zones, time_stretch, time_stretch_skip_silence, SkipBakedMap};
use fasttalk_core::stream::StreamStretcher;

fn tone(f0: f64, seconds: f64, sr: u32, amp: f32) -> Vec<f32> {
    let n = (seconds * sr as f64) as usize;
    (0..n)
        .map(|i| (2.0 * std::f64::consts::PI * f0 * i as f64 / sr as f64).sin() as f32 * amp)
        .collect()
}

fn drain(s: &mut StreamStretcher, out: &mut Vec<f32>) {
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
}

fn render_from(x: &[f32], sr: u32, speed: f64) -> Vec<f32> {
    let mut s = StreamStretcher::new(sr, speed);
    let mut out = Vec::new();
    for c in x.chunks(4096) {
        s.push(c);
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

/// After `skip_to(target)` the engine must produce exactly what a fresh engine
/// fed from `target` produces. The `j0`/`j_end` window is measured from the real
/// render buffer, not the requested (and clipped) look-behind, so nothing at the
/// seam is dropped.
#[test]
fn skip_to_matches_a_fresh_render_from_the_target() {
    let sr = 48000;
    let x = tone(140.0, 2.0, sr, 0.3);
    let skip_at = sr as usize; // 1.0 s

    let mut s = StreamStretcher::new(sr, 2.0);
    for c in x[..skip_at].chunks(4096) {
        s.push(c);
        let _ = s.pull(1 << 20);
    }
    s.skip_to(skip_at as f64);

    let mut after = Vec::new();
    for c in x[skip_at..].chunks(4096) {
        s.push(c);
        after.extend(s.pull(1 << 20));
    }
    drain(&mut s, &mut after);

    let reference = render_from(&x[skip_at..], sr, 2.0);

    assert!(!after.is_empty(), "nothing rendered after the skip");
    let n = after.len().min(reference.len());
    assert!(n > sr as usize / 4, "too little to compare");
    // Skip the cold-start region: the reference uses the full 20 ms startup fade
    // while a skip resumes on a 2 ms one. Past that both are the same render.
    let lo = (0.03 * sr as f64) as usize;
    let mut worst = 0.0f32;
    for i in lo..n {
        worst = worst.max((after[i] - reference[i]).abs());
    }
    assert!(worst < 1e-4, "post-skip audio diverged: worst {worst}");
    let len_diff = (after.len() as i64 - reference.len() as i64).abs();
    assert!(len_diff < 64, "length {} vs {}", after.len(), reference.len());
}

/// A skip must not repeat audio. A slow monotone ramp makes any repeat visible
/// as a jump backwards in the output.
#[test]
fn skip_does_not_repeat_audio() {
    let sr = 48000;
    let n = sr as usize * 4;
    let x: Vec<f32> = (0..n).map(|i| i as f32 / n as f32).collect();
    let skip = 2 * sr as usize;

    for speed in [1.0f64, 2.0, 4.0] {
        let mut s = StreamStretcher::new(sr, speed);
        s.push(&x[..skip]);
        let _ = s.pull(1 << 20);
        s.skip_to(skip as f64);
        s.push(&x[skip..]);
        let mut out = Vec::new();
        drain(&mut s, &mut out);

        let mut worst_back = 0.0f32;
        for i in 1..out.len() {
            worst_back = worst_back.max(out[i - 1] - out[i]);
        }
        // A ramp has a tiny per-sample rise; a repeat would be a large step back.
        assert!(
            worst_back < 0.005,
            "speed {speed}: backward jump of {worst_back} suggests doubled audio"
        );
    }
}

/// A skip that targets an already-passed position must be clamped, never rewind.
#[test]
fn skip_to_is_monotonic() {
    let sr = 16000;
    let x = tone(140.0, 1.0, sr, 0.3);

    let mut s = StreamStretcher::new(sr, 2.0);
    s.push(&x[..8000]);
    let _ = s.pull(1 << 20);
    s.skip_to(8000.0);
    s.skip_to(4000.0); // must clamp to >= 8000
    s.push(&x[8000..]);
    let mut out = Vec::new();
    drain(&mut s, &mut out);

    // x[8000..] is 8000 samples; at 2x that is ~4000 output samples. A rewind to
    // 4000 would instead yield ~6000.
    let len = out.len() as i64;
    assert!((len - 4000).abs() < 300, "got {len}, skip was not clamped");
}

#[test]
fn skip_to_resumes_without_a_long_fade() {
    let sr = 48000;
    let x = vec![0.5f32; sr as usize * 2];
    // 1.0x is passthrough, so the output level is exactly the fade envelope.
    let mut s = StreamStretcher::new(sr, 1.0);
    s.push(&x[..sr as usize]);
    let _ = s.pull(1 << 20);
    s.skip_to(sr as f64);
    s.push(&x[sr as usize..]);
    let mut out = Vec::new();
    drain(&mut s, &mut out);

    // The resume fade is short (5 ms), not the 20 ms startup ramp.
    let probe = (0.008 * sr as f64) as usize;
    assert!(out.len() > probe + 10, "too little output to probe");
    let level = out[probe].abs();
    assert!(
        level > 0.49,
        "level at 8 ms after the jump was {level}; the long startup fade is back"
    );
}

/// The head and tail of a gap are spliced in the export. Without a crossfade
/// that join is a step, which is the click heard at the cut.
#[test]
fn skip_silence_export_joins_without_a_step() {
    let sr = 48000;
    // Loud tone, a quiet tone below the silence threshold, loud tone again. The
    // quiet tone is kept as the head and tail, so the splice has real content.
    let loud = tone(440.0, 0.5, sr, 0.3);
    let quiet = tone(300.0, 1.5, sr, 0.025);
    let mut x = Vec::new();
    x.extend(&loud);
    x.extend(&quiet);
    x.extend(&loud);

    let out = time_stretch_skip_silence(&x, sr, 1.0, false, 0.25, 0.2);
    let max_step = out
        .windows(2)
        .map(|w| (w[1] - w[0]).abs())
        .fold(0.0f32, f32::max);
    // The loud tone's own step is ~0.017 and a hard splice of the quiet edges
    // would step by up to ~0.05. The crossfade keeps it near the source.
    assert!(max_step < 0.03, "export has a splice step of {max_step}");
}

#[test]
fn silence_zones_finds_only_long_gaps() {
    let sr = 48000;
    let mut x = tone(140.0, 0.5, sr, 0.3);
    x.extend(vec![0.0f32; (1.5 * sr as f64) as usize]); // 1.5 s > 0.5 s
    x.extend(tone(140.0, 0.5, sr, 0.3));

    let zones = silence_zones(&x, sr, 0.5);
    assert_eq!(zones.len(), 2, "expected exactly one zone, got {zones:?}");
    // Raw detected edges. The speech hangover (~100 ms) delays the detected
    // silence start past the nominal 24000, which is the point: the tail of the
    // last word stays on the speech side.
    assert!(
        (24000.0..=30000.0).contains(&zones[0]),
        "zone start {} outside the hangover band",
        zones[0]
    );
    assert!(
        (95000.0..=97000.0).contains(&zones[1]),
        "zone end {}",
        zones[1]
    );

    // A threshold above the gap length yields nothing.
    assert!(silence_zones(&x, sr, 2.0).is_empty());
}

#[test]
fn skip_silence_export_cuts_the_gap_to_the_kept_pause() {
    let sr = 48000;
    let speech = tone(140.0, 0.5, sr, 0.3);
    let mut x = Vec::new();
    x.extend(&speech);
    x.extend(vec![0.0f32; (1.5 * sr as f64) as usize]); // 1.5 s > 0.5 s
    x.extend(&speech);

    let out = time_stretch_skip_silence(&x, sr, 2.0, false, 0.5, 0.2);
    // Two 0.5 s speech spans at 2x (~0.5 s) plus the kept 0.2 s pause, itself
    // halved by the 2x speed. No-skip would be ~1.25 s.
    let expected = (speech.len() * 2) as f64 * 0.5 + 0.2 * sr as f64 * 0.5;
    let got = out.len() as f64;
    assert!(
        (got - expected).abs() < 0.12 * expected,
        "got {got} samples, expected ~{expected}"
    );
    assert!(out.iter().all(|v| v.is_finite()));
}

#[test]
fn skip_silence_export_of_pure_silence_leaves_the_kept_pause() {
    let sr = 48000;
    let x = vec![0.0f32; (2.0 * sr as f64) as usize];
    let out = time_stretch_skip_silence(&x, sr, 2.0, false, 0.5, 0.2);
    // A recording that is entirely silence collapses to just the kept pause,
    // halved to 0.1 s by the 2x speed.
    let expected = 0.2 * sr as f64 * 0.5;
    let got = out.len() as f64;
    assert!(
        (got - expected).abs() < 0.25 * expected,
        "got {got} samples, expected ~{expected}"
    );
}

/// The map must agree with the rendered audio: a position inside a skipped gap
/// collapses to the shared boundary, and the end maps to the output length.
#[test]
fn skip_baked_map_agrees_with_the_render() {
    let sr = 48000;
    let speech_len = (0.5 * sr as f64) as usize;
    let mut x = tone(140.0, 0.5, sr, 0.3);
    x.extend(vec![0.0f32; (1.5 * sr as f64) as usize]);
    x.extend(tone(140.0, 0.5, sr, 0.3));

    let map = SkipBakedMap::new(&x, sr, 2.0, false, 0.5, 0.2);
    let out_len = time_stretch_skip_silence(&x, sr, 2.0, false, 0.5, 0.2).len() as f64;

    assert!(map.map_position(0.0).abs() < 1.0, "start should map to 0");

    // Everything inside the skipped middle collapses to the boundary between the
    // kept head and the kept tail. The energy detector's boundary carries
    // frame/hop resolution (~30 ms) plus the ~100 ms speech hangover, so compare
    // the probes to each other tightly and to the nominal boundary loosely.
    let expected_boundary = (speech_len as f64 + 0.1 * sr as f64) * 0.5;
    let resolution = 0.12 * sr as f64;
    // All three probes sit inside the skipped middle (between the two kept halves).
    let probes = [40000, 60000, 80000];
    let mapped: Vec<f64> = probes.iter().map(|p| map.map_position(*p as f64)).collect();
    for (i, &got) in mapped.iter().enumerate() {
        assert!(
            (got - mapped[0]).abs() < 1.0,
            "gap probe {} mapped to {got}, differs from {}",
            probes[i],
            mapped[0]
        );
        assert!(
            (got - expected_boundary).abs() < resolution,
            "gap probe {} mapped to {got}, expected near {expected_boundary}",
            probes[i]
        );
    }

    assert!(
        (map.map_position(x.len() as f64) - out_len).abs() < 2.0,
        "end {} != rendered length {out_len}",
        map.map_position(x.len() as f64)
    );
}

/// Class-aware mode must hit the requested speed, not just approach it. The
/// per-class floors used to leave the baked output well short of the dial once
/// the speed passed about 2x. The floors still cap the maximum reachable speed
/// (speech cannot compress below 0.45), so this uses a pause-heavy signal whose
/// floor minimum allows the requested targets.
#[test]
fn class_aware_bake_hits_the_target_speed() {
    let sr = 48000;
    let mut x = Vec::new();
    for _ in 0..8 {
        x.extend(tone(140.0, 0.25, sr, 0.3));
        x.extend(vec![0.0f32; (0.85 * sr as f64) as usize]);
    }
    for speed in [2.0f64, 3.0, 4.0] {
        let out = time_stretch(&x, sr, speed, true);
        let expected = x.len() as f64 / speed;
        let got = out.len() as f64;
        assert!(
            (got - expected).abs() < 0.05 * expected,
            "speed {speed}: baked {got}, expected ~{expected}"
        );
    }
}
