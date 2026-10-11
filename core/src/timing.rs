//! Segment, rate-plan, and time-mapping primitives shared by every stage.
//!
//! Ported from `fasttalk/timing.py`. A `TimeMap` is a monotone piecewise-linear
//! input-to-output sample map and is the single currency between rate allocation
//! and waveform rendering.

use crate::classes::{classify, profile_for, Class, ClassProfile, Mode};

/// An input-domain interval carrying a phone label and its class.
#[derive(Clone, Debug)]
pub struct Segment {
    pub start: i64,
    pub end: i64,
    pub label: String,
    pub word: String,
    pub stress: i32,
    pub cls: Class,
}

impl Segment {
    pub fn new(start: i64, end: i64, label: &str) -> Self {
        Segment {
            start,
            end,
            label: label.to_string(),
            word: String::new(),
            stress: 0,
            cls: classify(label),
        }
    }

    pub fn with_class(start: i64, end: i64, label: &str, cls: Class) -> Self {
        Segment {
            start,
            end,
            label: label.to_string(),
            word: String::new(),
            stress: 0,
            cls,
        }
    }

    pub fn duration(&self) -> i64 {
        self.end - self.start
    }

    pub fn profile(&self) -> ClassProfile {
        profile_for(self.cls)
    }
}

/// A segment together with the rate it will be rendered at.
///
/// `rate` is `out_duration / in_duration`, so compression means `rate < 1` and a
/// 2x speed-up means `rate = 0.5`.
#[derive(Clone, Debug)]
pub struct SegmentRate {
    pub start: i64,
    pub end: i64,
    pub rate: f64,
    pub mode: Mode,
    pub cls: Class,
    pub label: String,
    pub head: bool,
}

impl SegmentRate {
    pub fn new(start: i64, end: i64, rate: f64, mode: Mode, cls: Class) -> Self {
        SegmentRate {
            start,
            end,
            rate,
            mode,
            cls,
            label: String::new(),
            head: false,
        }
    }

    pub fn in_duration(&self) -> i64 {
        self.end - self.start
    }

    pub fn out_duration(&self) -> i64 {
        (self.in_duration() as f64 * self.rate).round() as i64
    }
}

/// Split a segment into `(start, end, is_head)` pieces around its protected onset.
pub fn split_protected_head(segment: &Segment, sr: u32) -> Vec<(i64, i64, bool)> {
    let profile = segment.profile();
    let mut head_samples = (profile.head_ms * sr as f64 / 1000.0).round() as i64;
    head_samples = head_samples.clamp(0, segment.duration());
    if head_samples == 0 {
        return vec![(segment.start, segment.end, false)];
    }
    let mut pieces = vec![(segment.start, segment.start + head_samples, true)];
    if head_samples < segment.duration() {
        pieces.push((segment.start + head_samples, segment.end, false));
    }
    pieces
}

/// Monotone piecewise-linear input-to-output sample map.
#[derive(Clone, Debug)]
pub struct TimeMap {
    pub in_length: i64,
    pub anchors: Vec<(i64, i64)>,
}

impl TimeMap {
    pub fn new(in_length: i64, anchors: Vec<(i64, i64)>) -> Result<Self, String> {
        if anchors.is_empty() {
            return Err("anchors must not be empty".to_string());
        }
        if anchors.len() > 1 {
            for w in anchors.windows(2) {
                if w[1].0 <= w[0].0 {
                    return Err("anchor input positions must be strictly increasing".to_string());
                }
                if w[1].1 <= w[0].1 {
                    return Err("anchor output positions must be strictly increasing".to_string());
                }
            }
        }
        Ok(TimeMap { in_length, anchors })
    }

    pub fn identity(length: i64) -> Self {
        TimeMap {
            in_length: length,
            anchors: vec![(0, 0), (length, length)],
        }
    }

    /// Uniform compression: `ratio` must be in `(0, 1]`.
    pub fn uniform(length: i64, ratio: f64) -> Result<Self, String> {
        if !(ratio > 0.0 && ratio <= 1.0) {
            return Err("ratio must be in (0, 1]".to_string());
        }
        let out_length = (length as f64 * ratio).round().max(1.0) as i64;
        Ok(TimeMap {
            in_length: length,
            anchors: vec![(0, 0), (length, out_length)],
        })
    }

    /// Build the map implied by per-segment rates, filling gaps at rate 1.0.
    pub fn from_rates(rates: &[SegmentRate], in_length: i64) -> Self {
        let mut ordered: Vec<&SegmentRate> = rates.iter().filter(|r| r.in_duration() > 0).collect();
        ordered.sort_by_key(|r| r.start);

        let mut anchors: Vec<(i64, i64)> = vec![(0, 0)];
        let mut out_pos: i64 = 0;
        let mut cursor: i64 = 0;
        for r in ordered {
            let start = r.start.max(cursor).min(in_length);
            let end = r.end.max(start).min(in_length);
            if start > cursor {
                out_pos += start - cursor;
                anchors.push((start, out_pos));
            }
            if end <= start {
                continue;
            }
            out_pos += ((end - start) as f64 * r.rate).round() as i64;
            cursor = end;
            anchors.push((end, out_pos));
        }
        if cursor < in_length {
            out_pos += in_length - cursor;
            anchors.push((in_length, out_pos));
        }
        TimeMap { in_length, anchors }
    }

    pub fn out_length(&self) -> i64 {
        self.anchors.last().unwrap().1
    }

    pub fn ratio(&self) -> f64 {
        if self.in_length != 0 {
            self.out_length() as f64 / self.in_length as f64
        } else {
            1.0
        }
    }

    pub fn speed(&self) -> f64 {
        let r = self.ratio();
        if r > 0.0 {
            1.0 / r
        } else {
            f64::INFINITY
        }
    }

    /// Input sample position heard at the given output sample position.
    pub fn input_at(&self, out_position: f64) -> f64 {
        interp_axis(&self.anchors, out_position, true)
    }

    /// Output sample position corresponding to the given input sample position.
    pub fn output_at(&self, in_position: f64) -> f64 {
        interp_axis(&self.anchors, in_position, false)
    }

    /// Local input-to-output slope at the given input position.
    pub fn rate_at(&self, in_position: f64) -> f64 {
        let n = self.anchors.len();
        if n < 2 {
            return 1.0;
        }
        let mut idx = 0usize;
        while idx + 1 < n - 1 && (self.anchors[idx + 1].0 as f64) <= in_position {
            idx += 1;
        }
        let a = self.anchors[idx];
        let b = self.anchors[idx + 1];
        let din = (b.0 - a.0) as f64;
        if din <= 0.0 {
            1.0
        } else {
            (b.1 - a.1) as f64 / din
        }
    }
}

/// Linear interpolation over the anchors with clamping outside the range.
///
/// Binary-searches the anchor slice directly. The previous form built two
/// `Vec<f64>` of every anchor per call, which `psola::output_marks` then hit in
/// a loop -- quadratic on long class-aware plans.
fn interp_axis(anchors: &[(i64, i64)], q: f64, by_output: bool) -> f64 {
    let n = anchors.len();
    if n == 0 {
        return 0.0;
    }
    let key = |a: &(i64, i64)| if by_output { a.1 as f64 } else { a.0 as f64 };
    let val = |a: &(i64, i64)| if by_output { a.0 as f64 } else { a.1 as f64 };
    if q <= key(&anchors[0]) {
        return val(&anchors[0]);
    }
    if q >= key(&anchors[n - 1]) {
        return val(&anchors[n - 1]);
    }
    let mut lo = 0usize;
    let mut hi = n - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if key(&anchors[mid]) <= q {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let span = key(&anchors[hi]) - key(&anchors[lo]);
    if span <= 0.0 {
        return val(&anchors[lo]);
    }
    let t = (q - key(&anchors[lo])) / span;
    val(&anchors[lo]) + t * (val(&anchors[hi]) - val(&anchors[lo]))
}

/// Monotone evaluation of a time map for use inside tight loops.
///
/// The render loops query the map with a strictly increasing argument, so the
/// segment index is advanced instead of searched.
pub struct MapWalker<'a> {
    time_map: &'a TimeMap,
    index: usize,
}

impl<'a> MapWalker<'a> {
    pub fn new(time_map: &'a TimeMap) -> Self {
        MapWalker { time_map, index: 0 }
    }

    pub fn rewind(&mut self) {
        self.index = 0;
    }

    pub fn at(&mut self, position: f64) -> f64 {
        let anchors = &self.time_map.anchors;
        let last = anchors.len() - 1;
        if position <= anchors[0].1 as f64 {
            self.index = 0;
            return anchors[0].0 as f64;
        }
        if position >= anchors[last].1 as f64 {
            self.index = last.saturating_sub(1);
            return anchors[last].0 as f64;
        }
        let mut index = self.index;
        while index + 1 < last && (anchors[index + 1].1 as f64) <= position {
            index += 1;
        }
        self.index = index;
        let span = (anchors[index + 1].1 - anchors[index].1) as f64;
        if span <= 0.0 {
            return anchors[index].0 as f64;
        }
        let t = (position - anchors[index].1 as f64) / span;
        anchors[index].0 as f64 + t * (anchors[index + 1].0 - anchors[index].0) as f64
    }
}

/// Collapse adjacent copy-through regions so the engine emits fewer joins.
pub fn merge_copied_regions(rates: &[SegmentRate]) -> Vec<SegmentRate> {
    let mut merged: Vec<SegmentRate> = Vec::new();
    for r in rates {
        if let Some(last) = merged.last_mut() {
            if last.mode == Mode::CopyThrough && r.mode == Mode::CopyThrough && last.end == r.start {
                last.end = r.end;
                continue;
            }
        }
        merged.push(r.clone());
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::classes::{Class, Mode};

    #[test]
    fn time_map_round_trips_positions() {
        let segments = vec![
            SegmentRate::new(0, 1000, 0.5, Mode::OverlapAdd, Class::Vowel),
            SegmentRate::new(1000, 2000, 0.8, Mode::OverlapAdd, Class::Vowel),
        ];
        let tm = TimeMap::from_rates(&segments, 2000);
        assert_eq!(tm.out_length(), 1300);
        assert!((tm.rate_at(500.0) - 0.5).abs() < 1e-9);
        assert!((tm.rate_at(1500.0) - 0.8).abs() < 1e-9);
    }

    #[test]
    fn time_map_identity() {
        let tm = TimeMap::identity(100);
        assert_eq!(tm.out_length(), 100);
        assert!((tm.rate_at(50.0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn time_map_uniform_rejects_ratios_above_one() {
        assert!(TimeMap::uniform(100, 1.5).is_err());
    }

    #[test]
    fn time_map_rejects_non_monotonic_anchors() {
        assert!(TimeMap::new(100, vec![(0, 0), (50, 60), (40, 80)]).is_err());
    }

    #[test]
    fn from_rates_fills_gaps_at_identity() {
        let rates = vec![SegmentRate::new(100, 200, 0.5, Mode::OverlapAdd, Class::Vowel)];
        let tm = TimeMap::from_rates(&rates, 300);
        assert_eq!(tm.out_length(), 100 + 100 + 50);
        assert!((tm.rate_at(50.0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn protected_head_split_respects_segment_bounds() {
        let segment = Segment::new(0, 3200, "K");
        let pieces = split_protected_head(&segment, 16000);
        assert!(pieces[0].2);
        assert_eq!(pieces[0].0, segment.start);
        assert_eq!(pieces.last().unwrap().1, segment.end);
        assert!(pieces.iter().all(|(lo, hi, _)| hi > lo));
    }

    #[test]
    fn protected_head_never_yields_a_zero_length_piece() {
        let segment = Segment::new(0, 100, "K");
        let pieces = split_protected_head(&segment, 16000);
        assert_eq!(pieces, vec![(0, 100, true)]);
    }

    #[test]
    fn protected_head_split_is_a_no_op_for_vowels() {
        let segment = Segment::new(0, 100, "AA");
        assert_eq!(split_protected_head(&segment, 16000), vec![(0, 100, false)]);
    }

    #[test]
    fn merge_copied_regions_collapses_adjacent_copies() {
        let rates = vec![
            SegmentRate::new(0, 100, 1.0, Mode::CopyThrough, Class::Stop),
            SegmentRate::new(100, 200, 1.0, Mode::CopyThrough, Class::Stop),
            SegmentRate::new(200, 300, 0.5, Mode::OverlapAdd, Class::Vowel),
        ];
        let merged = merge_copied_regions(&rates);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].end, 200);
    }

    #[test]
    fn walker_advances_monotonically() {
        let tm = TimeMap::uniform(1000, 0.5).unwrap();
        let mut w = MapWalker::new(&tm);
        assert!((w.at(0.0) - 0.0).abs() < 1e-9);
        assert!((w.at(250.0) - 500.0).abs() < 1e-6);
        assert!((w.at(500.0) - 1000.0).abs() < 1e-6);
    }
}
