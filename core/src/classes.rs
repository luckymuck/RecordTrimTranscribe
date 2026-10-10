//! Articulatory classification of ARPAbet phones and per-class duration priors.
//!
//! Ported from `fasttalk/classes.py`. The taxonomy drives which segments absorb
//! compression, which are floored, and which are copied through unmodified.

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Class {
    Vowel,
    Nasal,
    Liquid,
    Fricative,
    Affricate,
    Stop,
    Silence,
    Speech,
}

impl Class {
    pub fn as_str(self) -> &'static str {
        match self {
            Class::Vowel => "vowel",
            Class::Nasal => "nasal",
            Class::Liquid => "liquid",
            Class::Fricative => "fricative",
            Class::Affricate => "affricate",
            Class::Stop => "stop",
            Class::Silence => "silence",
            Class::Speech => "speech",
        }
    }
}

/// How a segment is rendered by the engine.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    CopyThrough,
    OverlapAdd,
}

const VOWELS: &[&str] = &[
    "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW",
    "AX", "IX", "UX", "AXR", "AUX",
];
const NASALS: &[&str] = &["M", "N", "NG", "EN", "NX"];
const LIQUIDS: &[&str] = &["L", "R", "W", "Y", "EL", "DX"];
const FRICATIVES: &[&str] = &["F", "V", "TH", "DH", "S", "Z", "SH", "ZH", "HH", "PF"];
const AFFRICATES: &[&str] = &["CH", "JH", "TQ"];
const STOPS: &[&str] = &["P", "B", "T", "D", "K", "G", "PX"];
const SILENCE: &[&str] = &["SIL", "SPN", "SP"];

/// Map an ARPAbet phone label to its class.
///
/// Unknown labels fall back to `Fricative`, because an unrecognised short segment
/// is far more likely to be consonant material we must protect than a vowel we may
/// safely compress.
pub fn classify(label: &str) -> Class {
    let key = label.trim().to_ascii_uppercase();
    if key.is_empty() {
        return Class::Fricative;
    }
    if VOWELS.contains(&key.as_str()) {
        return Class::Vowel;
    }
    if NASALS.contains(&key.as_str()) {
        return Class::Nasal;
    }
    if LIQUIDS.contains(&key.as_str()) {
        return Class::Liquid;
    }
    if FRICATIVES.contains(&key.as_str()) {
        return Class::Fricative;
    }
    if AFFRICATES.contains(&key.as_str()) {
        return Class::Affricate;
    }
    if STOPS.contains(&key.as_str()) {
        return Class::Stop;
    }
    if SILENCE.contains(&key.as_str()) {
        return Class::Silence;
    }
    Class::Fricative
}

pub fn is_silence_label(label: &str) -> bool {
    SILENCE.contains(&label.trim().to_ascii_uppercase().as_str())
}

/// Duration policy for one articulatory class.
#[derive(Clone, Copy, Debug)]
pub struct ClassProfile {
    /// Lower bound on `out_duration / in_duration`.
    pub floor: f64,
    /// Nominal rate as a multiple of the global target ratio.
    pub multiplier: f64,
    /// Width of the protected segment onset.
    pub head_ms: f64,
    /// Rendering mode for the protected head.
    pub head_mode: Mode,
}

pub fn profile_for(cls: Class) -> ClassProfile {
    match cls {
        Class::Vowel => ClassProfile { floor: 0.30, multiplier: 1.00, head_ms: 0.0, head_mode: Mode::OverlapAdd },
        Class::Nasal => ClassProfile { floor: 0.55, multiplier: 1.15, head_ms: 0.0, head_mode: Mode::OverlapAdd },
        Class::Liquid => ClassProfile { floor: 0.60, multiplier: 1.15, head_ms: 0.0, head_mode: Mode::OverlapAdd },
        Class::Fricative => ClassProfile { floor: 0.55, multiplier: 1.15, head_ms: 20.0, head_mode: Mode::OverlapAdd },
        Class::Affricate => ClassProfile { floor: 0.65, multiplier: 1.20, head_ms: 45.0, head_mode: Mode::CopyThrough },
        Class::Stop => ClassProfile { floor: 0.70, multiplier: 1.20, head_ms: 35.0, head_mode: Mode::CopyThrough },
        Class::Silence => ClassProfile { floor: 0.10, multiplier: 0.55, head_ms: 0.0, head_mode: Mode::OverlapAdd },
        Class::Speech => ClassProfile { floor: 0.45, multiplier: 1.10, head_ms: 0.0, head_mode: Mode::OverlapAdd },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arpabet_labels_classify_correctly() {
        assert_eq!(classify("AA"), Class::Vowel);
        assert_eq!(classify("IH"), Class::Vowel);
        assert_eq!(classify("M"), Class::Nasal);
        assert_eq!(classify("NG"), Class::Nasal);
        assert_eq!(classify("L"), Class::Liquid);
        assert_eq!(classify("S"), Class::Fricative);
        assert_eq!(classify("SH"), Class::Fricative);
        assert_eq!(classify("CH"), Class::Affricate);
        assert_eq!(classify("P"), Class::Stop);
        assert_eq!(classify("SIL"), Class::Silence);
        assert_eq!(classify("sp"), Class::Silence);
    }

    #[test]
    fn classification_is_case_insensitive() {
        assert_eq!(classify("sh"), Class::Fricative);
    }

    #[test]
    fn unknown_short_labels_default_to_consonant() {
        assert_eq!(classify("ZZZ"), Class::Fricative);
        assert_eq!(classify(""), Class::Fricative);
    }

    #[test]
    fn floors_are_ordered_from_least_to_most_protected() {
        assert!(profile_for(Class::Vowel).floor < profile_for(Class::Fricative).floor);
        assert!(profile_for(Class::Fricative).floor <= profile_for(Class::Stop).floor);
        assert!(profile_for(Class::Silence).floor < profile_for(Class::Vowel).floor);
    }
}
