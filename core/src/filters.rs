//! Windowing and filtering helpers shared by the DSP engines.
//!
//! Rust replacements for the handful of NumPy/SciPy operations the Python
//! implementation relied on (`get_window`, `median_filter`, `maximum_filter1d`,
//! `uniform_filter1d`, `np.convolve`, and FFT-based autocorrelation).

use realfft::RealFftPlanner;

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
pub fn maximum_filter1d_nearest(x: &[f64], size: usize) -> Vec<f64> {
    let n = x.len();
    if n == 0 || size <= 1 {
        return x.to_vec();
    }
    let half = size / 2;
    let mut out = vec![0.0f64; n];
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
    out
}

/// Moving average with nearest-edge padding (`scipy.ndimage.uniform_filter1d`, mode="nearest").
pub fn uniform_filter1d_nearest(x: &[f64], size: usize) -> Vec<f64> {
    let n = x.len();
    if n == 0 || size <= 1 {
        return x.to_vec();
    }
    let half = size / 2;
    let mut out = vec![0.0f64; n];
    for i in 0..n {
        let mut sum = 0.0;
        for j in 0..size {
            let idx = (i as isize + j as isize - half as isize).clamp(0, n as isize - 1) as usize;
            sum += x[idx];
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
pub fn autocorr(frame: &[f64], size: usize, max_lag: usize) -> Vec<f64> {
    let mut planner = RealFftPlanner::<f64>::new();
    let r2c = planner.plan_fft_forward(size);
    let c2r = planner.plan_fft_inverse(size);

    let mut input = r2c.make_input_vec();
    for (i, &v) in frame.iter().enumerate().take(size) {
        input[i] = v;
    }
    let mut spectrum = r2c.make_output_vec();
    r2c.process(&mut input, &mut spectrum).expect("r2c");
    for c in spectrum.iter_mut() {
        *c = c.norm_sqr().into();
    }
    let mut out = c2r.make_output_vec();
    c2r.process(&mut spectrum, &mut out).expect("c2r");

    let scale = 1.0 / size as f64;
    out.iter().take(max_lag + 1).map(|v| v * scale).collect()
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
