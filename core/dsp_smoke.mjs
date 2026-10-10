// Sanity check of the WASM DSP bindings (run with: node core/dsp_smoke.mjs).
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const dsp = require("./pkg-node/fasttalk_core.js");

const sr = 16000;
const n = sr * 2;
const x = new Float32Array(n);
for (let i = 0; i < n; i++) {
  x[i] = 0.4 * Math.sin((2 * Math.PI * 140 * i) / sr);
}

let ok = true;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name} ${extra}`);
  if (!cond) ok = false;
};

// Offline render, uniform and class-aware.
for (const speed of [1.5, 2.0]) {
  const y = dsp.time_stretch(x, sr, speed, false);
  const expected = x.length / speed;
  check(
    `offline uniform ${speed}x length`,
    Math.abs(y.length - expected) < 0.05 * expected,
    `(${y.length} vs ${expected.toFixed(0)})`
  );
  check(`offline uniform ${speed}x finite`, y.every((v) => Number.isFinite(v)));
}

const yc = dsp.time_stretch(x, sr, 2.0, true);
check("offline class-aware runs", yc.length > 0 && yc.every((v) => Number.isFinite(v)));

// Analysis summary.
const info = JSON.parse(dsp.analyze(x, sr));
check("analyze detects voicing", info.voicedFrames > 10, JSON.stringify(info));
check("analyze f0 near 140", Math.abs(info.medianF0 - 140) < 5, `${info.medianF0.toFixed(1)} Hz`);

// Streaming engine.
const s = new dsp.StreamStretcher(sr, 2.0);
s.push(x);
s.finish();
const out = s.pull(n);
check(
  "streaming ~2x length",
  Math.abs(out.length - n / 2) < 0.1 * (n / 2),
  `(${out.length} vs ${n / 2})`
);

console.log(ok ? "\nALL OK" : "\nFAILURES");
process.exit(ok ? 0 : 1);
