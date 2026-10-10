//! Tests for skipping silence: the real-time `skip_to` jump and the offline
//! skip-silence export.

use fasttalk_core::api::{silence_zones, time_stretch_skip_silence, SkipBakedMap};
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
    let mut worst = 0.0f32;
    for i in 0..n {
        worst = worst.max((after[i] - reference[i]).abs());
    }
    assert!(worst < 1e-4, "post-skip audio diverged: worst {worst}");
    let len_diff = (after.len() as i64 - reference.len() as i64).abs();
    assert!(len_diff < 64, "length {} vs {}", after.len(), reference.len());
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
fn silence_zones_finds_only_long_gaps() {
    let sr = 48000;
    let mut x = tone(140.0, 0.5, sr, 0.3);
    x.extend(vec![0.0f32; (1.5 * sr as f64) as usize]); // 1.5 s > 0.5 s
    x.extend(tone(140.0, 0.5, sr, 0.3));

    let zones = silence_zones(&x, sr, 0.5, 0.2);
    assert_eq!(zones.len(), 2, "expected exactly one zone, got {zones:?}");
    // The kept 0.2 s is split evenly, so the zone is inset by 0.1 s on each side.
    assert!((zones[0] - 28800.0).abs() < 2000.0, "zone start {}", zones[0]);
    assert!((zones[1] - 91200.0).abs() < 2000.0, "zone end {}", zones[1]);

    // A threshold above the gap length yields nothing.
    assert!(silence_zones(&x, sr, 2.0, 0.2).is_empty());
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
    // frame/hop resolution (~30 ms), so compare the probes to each other tightly
    // and to the nominal boundary loosely.
    let expected_boundary = (speech_len as f64 + 0.1 * sr as f64) * 0.5;
    let resolution = 0.035 * sr as f64;
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
