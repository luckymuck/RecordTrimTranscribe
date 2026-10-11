//! Browser/WASM port of the FastTalk speech time-scale modification pipeline.
//!
//! The crate is built twice: natively for the test suite, and to WASM for the web
//! and Tauri clients. The public surface used by JavaScript lives in [`api`].

pub mod api;
pub mod classes;
pub mod engines;
pub mod enhance;
pub mod filters;
pub mod pitch;
pub mod rate;
pub mod stream;
pub mod timing;

/// Install a panic hook so a panic reports its message and location in the
/// browser console instead of trapping as "unreachable" (CORE-12).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}
