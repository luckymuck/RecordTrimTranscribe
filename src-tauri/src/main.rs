// Desktop shell. WebView2 is preinstalled on Windows 10/11, so the shipped app
// needs no Python, Node, or Rust runtime. The whole product UI and all
// processing (DSP wasm, Whisper wasm, encoders) live in the embedded web assets.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running RecordTrimTranscribe");
}
