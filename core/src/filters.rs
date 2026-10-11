//! Windowing and filtering helpers shared by the DSP engines.
//!
//! Rust replacements for the handful of NumPy/SciPy operations the Python
//! implementation relied on (`get_window`, `median_filter`, `maximum_filter1d`,
//! `uniform_filter1d`, `np.convolve`, and FFT-based autocorrelation).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use rustfft::num_complex::Complex;

/// Symmetric Hann window (`scipy.signal.get_window("hann", n, fftbins=False)`).
pub fn hann(n: usize) -> Vec<f64> {
    if n <= 1 {
        return vec![1.0; n];
    }
    let denom = (n - 1) as f64;
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / denom).cos())
        .collect()
}

/// In-place smoothing of a signal already confined to `[0, 1]`, by a Hann-kernel
/// moving average with clamped edges.
///
/// The kernel is non-negative and normalised by its own sum, so the result is
/// still a convex combination of the inputs and cannot leave `[0, 1]`.
pub fn smooth_unit(v: &mut [f64], width: usize) {
    let width = width.max(3) | 1; // odd, so the kernel has a true centre sample
    let n = v.len();
    if n < 3 || width < 3 {
        return;
    }
    let kernel = hann(width);
    let ksum: f64 = kernel.iter().sum();
    let half = (width / 2) as isize;
    let src = v.to_vec();
    for (i, slot) in v.iter_mut().enumerate() {
        let mut acc = 0.0;
        for (k, w) in kernel.iter().enumerate() {
            let j = (i as isize + k as isize - half).clamp(0, n as isize - 1) as usize;
            acc += w * src[j];
        }
        *slot = acc / ksum;
    }
}

/// Full convolution trimmed the way `np.convolve(..., mode="same")` does.
pub fn convolve_same(x: &[f64], kernel: &[f64]) -> Vec<f64> {
    let n = x.len();
    let k = kernel.len();
    if n == 0 || k == 0 {
        return vec![0.0; n];
    }
    let mut full = vec![0.0f64; n + k - 1];
    for (i, &xi) in x.iter().enumerate() {
        if xi == 0.0 {
            continue;
        }
        for (j, &kj) in kernel.iter().enumerate() {
            full[i + j] += xi * kj;
        }
    }
    // mode="same" centres the full result.
    let start = (k - 1) / 2;
    full[start..start + n].to_vec()
}

/// Sliding median with nearest-edge padding (`scipy.ndimage.median_filter`, mode="nearest").
pub fn median_filter_nearest(x: &[f64], size: usize) -> Vec<f64> {
    let n = x.len();
    if n == 0 || size <= 1 {
        return x.to_vec();
    }
    let half = size / 2;
    let mut out = vec![0.0f64; n];
    let mut buf = Vec::with_capacity(size);
    for i in 0..n {
        buf.clear();
        for j in 0..size {
            let idx = (i as isize + j as isize - half as isize).clamp(0, n as isize - 1) as usize;
            buf.push(x[idx]);
        }
        buf.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        out[i] = buf[size / 2];
    }
    out
}

/// Sliding maximum with index clamping (`scipy.ndimage.maximum_filter1d`).
/// Maximum filter with edge clamping, writing into a reused buffer.
///
/// `track_f0` runs this once per frame; allocating a fresh output each time was
/// a per-frame allocation on a hot path (CORE-11).
pub fn maximum_filter1d_nearest_into(x: &[f64], size: usize, out: &mut [f64]) {
    let n = x.len();
    assert!(out.len() >= n, "maximum filter output buffer is too small");
    if n == 0 {
        return;
    }
    if size <= 1 {
        out[..n].copy_from_slice(x);
        return;
    }
    let half = size / 2;
    for i in 0..n {
        let mut m = f64::NEG_INFINITY;
        for j in 0..size {
            let idx = (i as isize + j as isize - half as isize).clamp(0, n as isize - 1) as usize;
            if x[idx] > m {
                m = x[idx];
            }
        }
        out[i] = m;
    }
}

pub fn maximum_filter1d_nearest(x: &[f64], size: usize) -> Vec<f64> {
    let mut out = vec![0.0f64; x.len()];
    maximum_filter1d_nearest_into(x, size, &mut out);
    out
}

/// Moving average with nearest-edge padding (`scipy.ndimage.uniform_filter1d`, mode="nearest").
///
/// Implemented with a running sum, which makes it O(n + size) instead of
/// O(n * size). The window here is the WSOLA frame length (1536 samples at
/// 48 kHz), so the naive form cost roughly 40 million iterations per streaming
/// block and left the playback engine slower than real time at high speeds.
///
/// The running sum is resynchronised from scratch periodically so floating
/// point drift cannot accumulate over a long signal.
pub fn uniform_filter1d_nearest(x: &[f64], size: usize) -> Vec<f64> {
    let n = x.len();
    if n == 0 || size <= 1 {
        return x.to_vec();
    }
    let half = (size / 2) as isize;
    let last = n as isize - 1;
    let window_sum = |centre: isize| -> f64 {
        let mut sum = 0.0;
        for j in 0..size as isize {
            let idx = (centre + j - half).clamp(0, last) as usize;
            sum += x[idx];
        }
        sum
    };

    let mut out = vec![0.0f64; n];
    let mut sum = window_sum(0);
    out[0] = sum / size as f64;
    for i in 1..n {
        let centre = i as isize;
        let add = (centre + half).clamp(0, last) as usize;
        let sub = (centre - 1 - half).clamp(0, last) as usize;
        sum += x[add] - x[sub];
        if i % 1024 == 0 {
            sum = window_sum(centre);
        }
        out[i] = sum / size as f64;
    }
    out
}

/// Windowed-sinc low-pass kernel normalised to unit DC gain.
pub fn lowpass_kernel(sr: u32, cutoff: f64, taps: usize) -> Vec<f64> {
    let taps = if taps % 2 == 0 { taps + 1 } else { taps };
    let mid = (taps - 1) as f64 / 2.0;
    let fc = (cutoff / (sr as f64 / 2.0)).clamp(0.01, 0.99);
    let mut kernel: Vec<f64> = (0..taps)
        .map(|i| {
            let n = i as f64 - mid;
            let sinc = if n.abs() < 1e-12 {
                1.0
            } else {
                (2.0 * std::f64::consts::PI * fc * n).sin() / (std::f64::consts::PI * n)
            };
            let hamming = 0.54 - 0.46 * (2.0 * std::f64::consts::PI * i as f64 / (taps - 1) as f64).cos();
            sinc * hamming
        })
        .collect();
    let total: f64 = kernel.iter().sum();
    if total.abs() > 0.0 {
        for k in kernel.iter_mut() {
            *k /= total;
        }
    }
    kernel
}

/// Linear resampling used only when a window cannot fit (`np.interp`-style).
pub fn resize_linear(x: &[f64], length: usize) -> Vec<f64> {
    if length == 0 {
        return Vec::new();
    }
    if x.is_empty() {
        return vec![0.0; length];
    }
    if x.len() == 1 {
        return vec![x[0]; length];
    }
    let last = (x.len() - 1) as f64;
    (0..length)
        .map(|i| {
            let pos = if length > 1 {
                last * i as f64 / (length - 1) as f64
            } else {
                0.0
            };
            let lo = pos.floor() as usize;
            let hi = (lo + 1).min(x.len() - 1);
            let t = pos - lo as f64;
            x[lo] + t * (x[hi] - x[lo])
        })
        .collect()
}

/// Autocorrelation of `frame` for lags `0..=max_lag`, normalised as NumPy's
/// `irfft(rfft(a) * conj(rfft(a)))` is (i.e. the true correlation, no `size` factor).
///
/// Planning a transform allocates scratch buffers and computes twiddles, which
/// costs far more than running the transform. `autocorr` runs once per pitch
/// analysis frame, so re-planning on every call dominated the streaming
/// engine's cost and left it slower than real time above 2x. Plans and work
/// buffers are therefore cached per size.
pub fn autocorr(frame: &[f64], size: usize, max_lag: usize) -> Vec<f64> {
    FFT_CACHE.with(|cell| {
        let mut cache = cell.borrow_mut();
        let plan = cache.entry(size).or_insert_with(|| FftPlan::new(size));

        for slot in plan.input.iter_mut() {
            *slot = Default::default();
        }
        let n = frame.len().min(size);
        for (dst, &v) in plan.input[..n].iter_mut().zip(frame.iter()) {
            *dst = v.into();
        }

        plan.r2c.process(&mut plan.input, &mut plan.spectrum).expect("r2c");
        for c in plan.spectrum.iter_mut() {
            *c = c.norm_sqr().into();
        }
        plan.c2r
            .process(&mut plan.spectrum, &mut plan.scratch)
            .expect("c2r");

        let scale = 1.0 / size as f64;
        plan.scratch[..max_lag + 1].iter().map(|v| v * scale).collect()
    })
}

/// A planned forward/inverse real FFT pair plus its reusable work buffers.
struct FftPlan {
    r2c: Arc<dyn RealToComplex<f64>>,
    c2r: Arc<dyn ComplexToReal<f64>>,
    input: Vec<f64>,
    spectrum: Vec<Complex<f64>>,
    scratch: Vec<f64>,
}

impl FftPlan {
    fn new(size: usize) -> Self {
        let mut planner = RealFftPlanner::<f64>::new();
        let r2c = planner.plan_fft_forward(size);
        let c2r = planner.plan_fft_inverse(size);
        let input = r2c.make_input_vec();
        let spectrum = r2c.make_output_vec();
        let scratch = c2r.make_output_vec();
        FftPlan {
            r2c,
            c2r,
            input,
            spectrum,
            scratch,
        }
    }
}

thread_local! {
    static FFT_CACHE: RefCell<HashMap<usize, FftPlan>> = RefCell::new(HashMap::new());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hann_is_symmetric_and_zero_at_ends() {
        let w = hann(9);
        assert!((w[0]).abs() < 1e-12);
        assert!((w[8]).abs() < 1e-12);
        assert!((w[4] - 1.0).abs() < 1e-12);
        assert!((w[2] - w[6]).abs() < 1e-12);
    }

    #[test]
    fn autocorr_peak_matches_a_known_period() {
        // A 160 Hz tone at 16 kHz has a period of 100 samples.
        let sr = 16000.0;
        let f0 = 160.0;
        let n = 4096usize;
        let frame: Vec<f64> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * f0 * i as f64 / sr).sin())
            .collect();
        let size = 8192usize;
        let ac = autocorr(&frame, size, 400);
        let energy: f64 = frame.iter().map(|v| v * v).sum();
        assert!(
            (ac[0] - energy).abs() < 1e-3 * energy,
            "ac[0]={} energy={}",
            ac[0],
            energy
        );
        let mut best = 60usize;
        for lag in 60..400 {
            if ac[lag] > ac[best] {
                best = lag;
            }
        }
        assert!((best as f64 - 100.0).abs() < 3.0, "peak lag was {best}");
        // Normalised correlation must be in [-1, 1].
        assert!(ac[best] <= energy + 1e-6, "corr {} out of range", ac[best]);
    }

    #[test]
    fn resize_linear_hits_the_endpoints() {
        let r = resize_linear(&[0.0, 1.0, 2.0], 5);
        assert!((r[0] - 0.0).abs() < 1e-12);
        assert!((r[4] - 2.0).abs() < 1e-12);
        assert_eq!(r.len(), 5);
    }
}
