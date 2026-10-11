// Canvas waveform viewer: overview + zoomable main view, playhead, and split markers.
// Concepts adapted from the AudioSplitter.html waveform viewer.

const MAX_BUCKETS = 40000;
// Grab radius for a split, in CSS pixels. Both the drag hit test and the
// context-menu hit test use it, so they cannot disagree (they used to be 6/dpr
// and 7 device px, which is hard to hit on high-DPI and touch screens).
const SPLIT_HIT_PX = 8;

export class WaveformView {
  constructor({ main, overview, playhead, onSeek, onSplitsChange, onViewChange }) {
    this.main = main;
    this.overview = overview;
    this.playheadEl = playhead;
    this.onSeek = onSeek || (() => {});
    this.onSplitsChange = onSplitsChange || (() => {});
    this.onViewChange = onViewChange || (() => {});

    this.pcm = null;
    this.sampleRate = 1;
    this.duration = 0;
    this.bucket = 1;
    this.mins = null;
    this.maxs = null;
    this.viewStart = 0;
    this.viewLen = 0;
    this.splits = [];
    this.splitLabels = [];
    this.playhead = -1;
    this._dragging = null;
    this._ctxMenu = null;
    // Auto-scroll to keep the cursor visible. Turned off when the user pans or
    // zooms so the view stops fighting them, and back on when they seek.
    this.followPlayhead = true;

    this.labelsEl = document.createElement("div");
    this.labelsEl.className = "split-label-layer";
    (playhead.parentElement || this.main.parentElement).appendChild(this.labelsEl);

    this._measureCtx = document.createElement("canvas").getContext("2d");

    this._bind();
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(this.main);
    ro.observe(this.overview);
    this._ro = ro;
  }

  setData(pcm, sampleRate) {
    this._hideCtxMenu();
    this.pcm = pcm;
    this.sampleRate = sampleRate;
    this.duration = pcm.length / sampleRate;
    this.splits = [];
    this.splitLabels = [];
    this._computePeaks();
    this.viewStart = 0;
    this.viewLen = pcm.length;
    this.playhead = -1;
    this.followPlayhead = true;
    this._resize();
    this.onSplitsChange(this.splits);
  }

  /**
   * Replace the audio without resetting splits, labels, or the playhead —
   * for in-place edits like normalization.
   */
  refreshData(pcm, sampleRate) {
    this._hideCtxMenu();
    this.pcm = pcm;
    this.sampleRate = sampleRate;
    this.duration = pcm.length / sampleRate;
    this._computePeaks();
    this.viewStart = 0;
    this.viewLen = pcm.length;
    this._resize();
  }

  clear() {
    this.pcm = null;
    this.splits = [];
    this.splitLabels = [];
    this.playhead = -1;
    this._hideCtxMenu();
    this._resize();
  }

  get hasData() {
    return !!this.pcm;
  }

  _computePeaks() {
    const n = this.pcm.length;
    this.bucket = Math.max(1, Math.ceil(n / MAX_BUCKETS));
    const nb = Math.ceil(n / this.bucket);
    this.mins = new Float32Array(nb);
    this.maxs = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      const s = b * this.bucket;
      const e = Math.min(n, s + this.bucket);
      let mn = 1e9,
        mx = -1e9;
      for (let i = s; i < e; i++) {
        const v = this.pcm[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      this.mins[b] = mn;
      this.maxs[b] = mx;
    }
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const [c, cssH] of [
      [this.main, 120],
      [this.overview, 30],
    ]) {
      const w = c.clientWidth || c.parentElement.clientWidth || 600;
      c.style.height = cssH + "px";
      c.width = Math.max(1, Math.floor(w * dpr));
      c.height = Math.max(1, Math.floor(cssH * dpr));
    }
    this.draw();
  }

  resetZoom() {
    if (!this.pcm) return;
    this.viewStart = 0;
    this.viewLen = this.pcm.length;
    this.followPlayhead = true;
    this.draw();
    this.onViewChange(this._zoomLabel());
  }

  _zoomLabel() {
    if (!this.pcm) return "1×";
    return (this.pcm.length / this.viewLen).toFixed(1) + "×";
  }

  sampleToX(sample) {
    const w = this.main.clientWidth;
    return ((sample - this.viewStart) / this.viewLen) * w;
  }

  xToSample(x) {
    const w = this.main.clientWidth;
    return this.viewStart + (x / w) * this.viewLen;
  }

  setPlayhead(sample) {
    this.playhead = sample;
    if (!this.pcm || this.playhead < 0) {
      this.drawPlayhead();
      return;
    }
    // Keep the cursor visible while playing: scroll the view before it reaches
    // the edge. Only when following, and only when there is somewhere to
    // scroll -- fully zoomed out, the cursor is always visible and the edge
    // test would force a full redraw on every tick for nothing.
    const w = this.main.clientWidth || 1;
    const x = this.sampleToX(sample);
    const margin = Math.max(24, w * 0.06);
    if (
      this.followPlayhead &&
      this.viewLen < this.pcm.length &&
      (x < margin || x > w - margin)
    ) {
      this.viewStart = sample - this.viewLen * 0.15;
      this._clampView();
      this.draw();
    } else {
      this.drawPlayhead();
    }
  }

  drawPlayhead() {
    if (!this.pcm || this.playhead < 0) {
      this.playheadEl.style.display = "none";
      return;
    }
    const x = this.sampleToX(this.playhead);
    if (x < 0 || x > this.main.clientWidth) {
      this.playheadEl.style.display = "none";
      return;
    }
    this.playheadEl.style.display = "block";
    this.playheadEl.style.left = x + "px";
  }

  /** Labels shown to the right of each split line, e.g. "3:15-01-Good morning…". */
  setSplitLabels(labels) {
    this.splitLabels = (labels || []).slice();
    this.draw();
  }

  draw() {
    this._drawOverview();
    this._drawMain();
    this._drawLabels();
    this.drawPlayhead();
  }

  _drawOverview() {
    const c = this.overview;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (!this.pcm) return;
    const w = c.width;
    const h = c.height;
    const mid = h / 2;
    ctx.fillStyle = "#5eead4";
    const step = this.pcm.length / w;
    const lastBucket = this.mins.length - 1;
    for (let x = 0; x < w; x++) {
      const s = Math.floor(x * step);
      const e = Math.min(this.pcm.length, Math.floor((x + 1) * step));
      const b0 = Math.max(0, Math.min(lastBucket, Math.floor(s / this.bucket)));
      const b1 = Math.max(b0, Math.min(lastBucket, Math.floor(Math.max(s, e - 1) / this.bucket)));
      let mn = 1,
        mx = -1;
      for (let b = b0; b <= b1; b++) {
        if (this.mins[b] < mn) mn = this.mins[b];
        if (this.maxs[b] > mx) mx = this.maxs[b];
      }
      ctx.fillRect(x, mid - mx * mid, 1, (mx - mn) * mid || 1);
    }
    // view window highlight
    const vx = (this.viewStart / this.pcm.length) * w;
    const vw = (this.viewLen / this.pcm.length) * w;
    ctx.fillStyle = "rgba(124,156,255,0.18)";
    ctx.fillRect(vx, 0, vw, h);
    ctx.strokeStyle = "#7c9cff";
    ctx.beginPath();
    ctx.moveTo(vx, 0);
    ctx.lineTo(vx, h);
    ctx.moveTo(vx + vw, 0);
    ctx.lineTo(vx + vw, h);
    ctx.stroke();
  }

  _drawMain() {
    const c = this.main;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (!this.pcm) return;
    const w = c.width;
    const h = c.height;
    const mid = h / 2;
    const dpr = window.devicePixelRatio || 1;
    const spp = this.viewLen / w;

    // The split pass below sets lineWidth to 2*dpr and never restores it, so
    // reset it here or the centre line and the raw trace thicken on redraw.
    ctx.lineWidth = dpr;

    ctx.strokeStyle = "#2b3244";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    ctx.fillStyle = "#5eead4";
    if (spp >= this.bucket) {
      for (let x = 0; x < w; x++) {
        const s = this.viewStart + x * spp;
        const e = s + spp;
        const b0 = Math.floor(s / this.bucket);
        const b1 = Math.min(this.mins.length - 1, Math.floor(e / this.bucket));
        let mn = 1,
          mx = -1;
        for (let b = b0; b <= b1; b++) {
          if (this.mins[b] < mn) mn = this.mins[b];
          if (this.maxs[b] > mx) mx = this.maxs[b];
        }
        const y0 = mid - mx * mid;
        const y1 = mid - mn * mid;
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    } else if (spp > 1) {
      // Between one sample per pixel and one bucket per pixel. Drawing a single
      // raw sample per column misses the peaks in between, so the waveform
      // looks like noise; take the min/max of the samples each column covers.
      for (let x = 0; x < w; x++) {
        const s = Math.floor(this.viewStart + x * spp);
        const e = Math.min(
          this.pcm.length,
          Math.max(s + 1, Math.floor(this.viewStart + (x + 1) * spp))
        );
        let mn = 1,
          mx = -1;
        for (let i = s; i < e; i++) {
          const v = this.pcm[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const y0 = mid - mx * mid;
        const y1 = mid - mn * mid;
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    } else {
      // Zoomed in past one sample per pixel: draw the raw samples as a line.
      // The stroke style is set here because the centre line above left it grey.
      ctx.strokeStyle = "#5eead4";
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const s = Math.floor(this.viewStart + x * spp);
        const v = this.pcm[Math.min(this.pcm.length - 1, s)] || 0;
        const y = mid - v * mid;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // splits
    for (let i = 0; i < this.splits.length; i++) {
      const x = (this.sampleToX(this.splits[i]) * dpr);
      if (x < 0 || x > w) continue;
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = "#ffb454";
      ctx.beginPath();
      ctx.arc(x, 8 * dpr, 5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawLabels() {
    this.labelsEl.innerHTML = "";
    if (!this.pcm || this.splits.length === 0) return;
    const font = "10px ui-monospace, Consolas, monospace";
    this._measureCtx.font = font;
    const width = this.main.clientWidth;
    const escapeHtml = (value) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    for (let i = 0; i < this.splits.length; i++) {
      const text = this.splitLabels[i] || "";
      const label = document.createElement("span");
      label.className = "split-label";
      if (text) {
        const [timePart, ...rest] = text.split("-");
        label.innerHTML = `<span class="t">${timePart}</span>` + (rest.length ? "-" + escapeHtml(rest.join("-")) : "");
      } else {
        label.textContent = "";
      }
      let x = this.sampleToX(this.splits[i]) + 5;
      const w = this._measureCtx.measureText(text).width + 14;
      if (x + w > width - 2) {
        x = this.sampleToX(this.splits[i]) - 5;
        label.style.transform = "translateX(-100%)";
      }
      label.style.left = x + "px";
      this.labelsEl.appendChild(label);
    }
  }

  _hideCtxMenu() {
    if (this._ctxMenu) {
      this._ctxMenu.remove();
      this._ctxMenu = null;
      document.removeEventListener("pointerdown", this._ctxDismiss, true);
      document.removeEventListener("keydown", this._ctxEsc, true);
      return true;
    }
    return false;
  }

  showContextMenu(x, y, index) {
    this._hideCtxMenu();
    const menu = document.createElement("div");
    menu.className = "ctxmenu";
    const label = this.splitLabels[index] || `Split ${index + 1}`;
    const title = document.createElement("div");
    title.className = "ctx-title";
    title.textContent = label;
    menu.appendChild(title);
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Delete split";
    del.addEventListener("click", () => {
      this._hideCtxMenu();
      this.removeSplit(index);
    });
    menu.appendChild(del);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => this._hideCtxMenu());
    menu.appendChild(closeBtn);
    document.body.appendChild(menu);
    this._ctxMenu = menu;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - w - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - h - 8) + "px";

    this._ctxDismiss = (e) => {
      if (this._ctxMenu && !this._ctxMenu.contains(e.target)) this._hideCtxMenu();
    };
    this._ctxEsc = (e) => {
      if (e.key === "Escape") this._hideCtxMenu();
    };
    document.addEventListener("pointerdown", this._ctxDismiss, true);
    document.addEventListener("keydown", this._ctxEsc, true);
  }

  _bind() {
    const main = this.main;

    main.addEventListener("contextmenu", (e) => {
      if (!this.pcm) return;
      const rect = main.getBoundingClientRect();
      const x = e.clientX - rect.left;
      let hit = -1;
      for (let i = 0; i < this.splits.length; i++) {
        if (Math.abs(this.sampleToX(this.splits[i]) - x) < SPLIT_HIT_PX) {
          hit = i;
          break;
        }
      }
      if (hit >= 0) {
        e.preventDefault();
        this.showContextMenu(e.clientX, e.clientY, hit);
      }
    });

    main.addEventListener("wheel", (e) => {
      if (!this.pcm) return;
      e.preventDefault();
      this.followPlayhead = false;
      const rect = main.getBoundingClientRect();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Horizontal pan (trackpad two-finger / shift+wheel).
        this.viewStart += (e.deltaX / Math.max(1, rect.width)) * this.viewLen;
        this._clampView();
        this.draw();
        this.onViewChange(this._zoomLabel());
        return;
      }
      const x = e.clientX - rect.left;
      const anchor = this.xToSample(x);
      // Scale by the delta magnitude: a fixed 0.8/1.25 per event makes
      // trackpad inertia over-zoom by many steps at once.
      const magnitude = Math.min(2, Math.abs(e.deltaY) / 100);
      const factor =
        e.deltaY < 0 ? Math.pow(0.8, magnitude) : Math.pow(1.25, magnitude);
      const newLen = Math.max(64, Math.min(this.pcm.length, this.viewLen * factor));
      this.viewStart = anchor - (anchor - this.viewStart) * (newLen / this.viewLen);
      this.viewLen = newLen;
      this._clampView();
      this.draw();
      this.onViewChange(this._zoomLabel());
    }, { passive: false });

    main.addEventListener("pointerdown", (e) => {
      if (!this.pcm) return;
      const rect = main.getBoundingClientRect();
      const x = e.clientX - rect.left;
      // Ctrl+click adds a split at the clicked spot (and is never a drag).
      if (e.ctrlKey || e.metaKey) {
        const sample = Math.max(0, Math.min(this.pcm.length, Math.round(this.xToSample(x))));
        this.addSplit(sample);
        return;
      }
      // Near a split? start dragging it.
      let hit = -1;
      for (let i = 0; i < this.splits.length; i++) {
        if (Math.abs(this.sampleToX(this.splits[i]) - x) < SPLIT_HIT_PX) {
          hit = i;
          break;
        }
      }
      if (hit >= 0) {
        this._dragging = { type: "split", index: hit };
      } else {
        this._dragging = { type: "scroll", x, startView: this.viewStart };
        // The user is taking control of the view; stop auto-scrolling.
        this.followPlayhead = false;
      }
      main.setPointerCapture(e.pointerId);
    });

    main.addEventListener("pointermove", (e) => {
      if (!this._dragging || !this.pcm) return;
      const rect = main.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (this._dragging.type === "split") {
        const s = Math.max(0, Math.min(this.pcm.length, this.xToSample(x)));
        const value = Math.round(s);
        this.splits[this._dragging.index] = value;
        this.splits.sort((a, b) => a - b);
        // Sorting can move the dragged split, so re-find it; otherwise the next
        // move writes to whichever split now sits at the old index.
        this._dragging.index = this.splits.indexOf(value);
        // `true` = mid-drag: the listener should do only the cheap label update.
        this.onSplitsChange(this.splits, true);
        this.draw();
      } else {
        const dSamples = ((x - this._dragging.x) / main.clientWidth) * this.viewLen;
        this.viewStart = this._dragging.startView - dSamples;
        this._clampView();
        this.draw();
      }
    });

    main.addEventListener("pointerup", (e) => {
      // The source can be cleared mid-drag; do not dereference a null pcm.
      if (!this.pcm) {
        this._dragging = null;
        return;
      }
      const finishedSplit = this._dragging && this._dragging.type === "split";
      if (this._dragging && this._dragging.type === "scroll") {
        const moved = Math.abs(e.clientX - this.main.getBoundingClientRect().left - this._dragging.x);
        if (moved < 3) {
          const rect = main.getBoundingClientRect();
          const s = this.xToSample(e.clientX - rect.left);
          this.onSeek(Math.max(0, Math.min(this.pcm.length - 1, Math.round(s))));
          // The user placed the cursor; following from here is expected.
          this.followPlayhead = true;
        }
      }
      this._dragging = null;
      // Drag over: now the expensive recomputes (clip list, scopes) are safe.
      if (finishedSplit) this.onSplitsChange(this.splits, false);
      this.onViewChange(this._zoomLabel());
    });

    // A cancelled pointer (touch scrolling, capture loss) must end the drag, or
    // the next hover keeps panning or dragging.
    const cancelDrag = () => {
      this._dragging = null;
    };
    main.addEventListener("pointercancel", cancelDrag);
    main.addEventListener("lostpointercapture", cancelDrag);

    this.overview.addEventListener("pointerdown", (e) => {
      if (!this.pcm) return;
      const rect = this.overview.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      const centre = frac * this.pcm.length;
      this.viewStart = centre - this.viewLen / 2;
      this._clampView();
      this.followPlayhead = true;
      this.draw();
      this.onViewChange(this._zoomLabel());
    });
  }

  _clampView() {
    const n = this.pcm.length;
    this.viewLen = Math.max(64, Math.min(n, this.viewLen));
    this.viewStart = Math.max(0, Math.min(n - this.viewLen, this.viewStart));
  }

  addSplit(sample) {
    this._hideCtxMenu();
    this.splits.push(Math.round(sample));
    this.splits.sort((a, b) => a - b);
    this.onSplitsChange(this.splits);
    this.draw();
  }

  removeSplit(index) {
    this._hideCtxMenu();
    this.splits.splice(index, 1);
    this.onSplitsChange(this.splits);
    this.draw();
  }

  clearSplits() {
    this._hideCtxMenu();
    this.splits = [];
    this.onSplitsChange(this.splits);
    this.draw();
  }
}
