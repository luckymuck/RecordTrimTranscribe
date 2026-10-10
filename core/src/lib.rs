//! Browser/WASM port of the FastTalk speech time-scale modification pipeline.
//!
//! The crate is built twice: natively for the test suite, and to WASM for the web
//! and Tauri clients. The public surface used by JavaScript lives in [`api`].

pub mod api;
pub mod classes;
pub mod engines;
pub mod filters;
pub mod pitch;
pub mod rate;
pub mod stream;
pub mod timing;
