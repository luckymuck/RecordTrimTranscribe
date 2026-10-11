# RNNoise (vendored)

`rnnoise.js` + `rnnoise.wasm` are the WebAssembly build of
[RNNoise](https://gitlab.xiph.org/xiph/rnnoise) from the npm package
**`@echogarden/rnnoise-wasm@0.2.0`** (RNNoise 0.2).

- Upstream package: https://www.npmjs.com/package/@echogarden/rnnoise-wasm
- Licence: **BSD-3-Clause** (see `COPYING`, which carries the Mozilla, Xiph.Org,
  Jean-Marc Valin and Mark Borgerding notices). BSD-3-Clause is compatible with
  this repository's GPL-3.0 licence.
- `README.upstream.md` is the package's own README, kept for reference.

`app/src/audio/denoise.js` loads this copy first and falls back to the pinned
jsdelivr URL (`https://cdn.jsdelivr.net/npm/@echogarden/rnnoise-wasm@0.2.0/rnnoise.js`)
if it is missing, so the web build works either way and the desktop build works
offline.

To update: fetch the new tarball from the npm registry, replace `rnnoise.js`,
`rnnoise.wasm` and `COPYING`, and update the version above and the fallback URL
in `app/src/audio/denoise.js`.
