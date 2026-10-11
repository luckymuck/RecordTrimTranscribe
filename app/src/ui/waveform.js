// Canvas waveform viewer: overview + zoomable main view, playhead, and split markers.
// Concepts adapted from the AudioSplitter.html waveform viewer.
import { isValidSplit } from "../export/boundaries.js";

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

    // Delete controls live in their own layer: the split lines are canvas-drawn
    // and cannot be clicked, and this layer spans the waveform so the buttons
    // can sit at the bottom.
    this.toolsEl = document.createElement("div");
    this.toolsEl.className = "split-tools-layer";
    (playhead.parentElement || this.main.parentElement).appendChild(this.toolsEl);

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
   * for in-place edits like normalization. The zoom is kept too: normalizing
   * used to throw the user's view away (WF-9).
   */
  refreshData(pcm, sampleRate) {
    this._hideCtxMenu();
    const prevStart = this.viewStart;
    const prevLen = this.viewLen;
    this.pcm = pcm;
    this.sampleRate = sampleRate;
    this.duration = pcm.length / sampleRate;
    this._computePeaks();
    this.viewLen = Math.max(64, Math.min(prevLen || pcm.length, pcm.length));
    this.viewStart = Math.max(0, Math.min(pcm.length - this.viewLen, prevStart || 0));
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

  /**
   * Peak envelope, computed in slices so an hour-long file does not stall the
   * UI (WF-13). Uncomputed buckets stay NaN and the draws skip them, so the
   * envelope fills in progressively instead of showing a false flat line.
   */
  _computePeaks() {
    const n = this.pcm.length;
    this.bucket = Math.max(1, Math.ceil(n / MAX_BUCKETS));
    const nb = Math.ceil(n / this.bucket);
    this.mins = new Float32Array(nb).fill(NaN);
    this.maxs = new Float32Array(nb).fill(NaN);
    const token = (this._peaksToken = (this._peaksToken || 0) + 1);
    const perSlice = Math.max(1, Math.ceil(2e6 / this.bucket));
    let b = 0;
    const step = () => {
      // Superseded by a newer source, or the data went away.
      if (token !== this._peaksToken || !this.pcm) return;
      const until = Math.min(nb, b + perSlice);
      for (; b < until; b++) {
        const s = b * this.bucket;
        const e = Math.min(n, s + this.bucket);
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = s; i < e; i++) {
          const v = this.pcm[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        this.mins[b] = mn;
        this.maxs[b] = mx;
      }
      this.draw();
      if (b < nb) setTimeout(step, 0);
    };
    step();
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
    // The overview carries its own playhead marker, so it has to be repainted
    // when the cursor moves (WF-12). It is a small canvas; this is cheap.
    if (this.pcm) this._drawOverview();
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
    this._drawSplitTools();
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
      let mn = Infinity;
      let mx = -Infinity;
      let seen = false;
      for (let b = b0; b <= b1; b++) {
        const lo = this.mins[b];
        const hi = this.maxs[b];
        if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
        seen = true;
        if (lo < mn) mn = lo;
        if (hi > mx) mx = hi;
      }
      if (!seen) continue; // this slice of the envelope is not computed yet
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
    // Splits and playhead, so the overview shows where the cuts and the cursor
    // are without having to look at the main view (WF-12).
    ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    ctx.strokeStyle = "#ffb454";
    for (const s of this.splits) {
      const x = (s / this.pcm.length) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    if (this.playhead >= 0) {
      const px = (this.playhead / this.pcm.length) * w;
      ctx.strokeStyle = "#7c9cff";
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
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
        let mn = Infinity;
        let mx = -Infinity;
        let seen = false;
        for (let b = b0; b <= b1; b++) {
          const lo = this.mins[b];
          const hi = this.maxs[b];
          if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
          seen = true;
          if (lo < mn) mn = lo;
          if (hi > mx) mx = hi;
        }
        if (!seen) continue; // envelope slice not computed yet
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

  /**
   * Split labels. Reuses a pool of elements instead of rebuilding with
   * innerHTML on every redraw, culls labels outside the view, and skips labels
   * that would overlap the previous one (WF-11).
   */
  _drawLabels() {
    const pool = (this._labelPool = this._labelPool || []);
    if (!this.pcm || this.splits.length === 0) {
      for (const el of pool) if (el.isConnected) el.remove();
      return;
    }
    this._measureCtx.font = "10px ui-monospace, Consolas, monospace";
    const width = this.main.clientWidth;
    let used = 0;
    let prevRight = -Infinity;
    for (let i = 0; i < this.splits.length; i++) {
      const sx = this.sampleToX(this.splits[i]);
      if (sx < -40 || sx > width + 40) continue; // off screen
      const text = this.splitLabels[i] || "";
      const w = this._measureCtx.measureText(text).width + 14;
      let x = sx + 5;
      let flip = false;
      if (x + w > width - 2) {
        x = sx - 5;
        flip = true;
      }
      const left = flip ? x - w : x;
      if (left < prevRight + 2) continue; // would overlap the previous label
      prevRight = left + w;
      let label = pool[used];
      if (!label) {
        label = document.createElement("span");
        label.className = "split-label";
        pool.push(label);
      }
      used++;
      if (label._text !== text) {
        label._text = text;
        label.textContent = "";
        const [timePart, ...rest] = text.split("-");
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = timePart;
        label.appendChild(t);
        if (rest.length) label.appendChild(document.createTextNode("-" + rest.join("-")));
      }
      label.style.transform = flip ? "translateX(-100%)" : "";
      label.style.left = x + "px";
      if (!label.isConnected) this.labelsEl.appendChild(label);
    }
    for (let i = used; i < pool.length; i++) {
      if (pool[i].isConnected) pool[i].remove();
    }
  }

  /**
   * A small delete button at the lower left of each split line. The pool is
   * reused and off-screen splits are culled, like the labels.
   */
  _drawSplitTools() {
    const pool = (this._toolPool = this._toolPool || []);
    if (!this.pcm || this.splits.length === 0) {
      for (const el of pool) if (el.isConnected) el.remove();
      return;
    }
    const width = this.main.clientWidth;
    let used = 0;
    for (let i = 0; i < this.splits.length; i++) {
      const sx = this.sampleToX(this.splits[i]);
      if (sx < 0 || sx > width) continue;
      let btn = pool[used];
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "split-trash";
        btn.title = "Delete this split";
        btn.setAttribute("aria-label", "Delete this split");
        btn.innerHTML =
          '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></svg>';
        btn.addEventListener("click", () => {
          const index = this.splits.indexOf(Number(btn.dataset.sample));
          if (index >= 0) this.removeSplit(index);
        });
        pool.push(btn);
      }
      used++;
      btn.dataset.sample = String(this.splits[i]);
      btn.style.left = sx + "px";
      if (!btn.isConnected) this.toolsEl.appendChild(btn);
    }
    for (let i = used; i < pool.length; i++) {
      if (pool[i].isConnected) pool[i].remove();
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
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl+click on macOS is a right-click; it adds a split, so the native
        // menu must not appear over it (WF-10).
        e.preventDefault();
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

    // The overview is draggable: click or drag to bring that part of the
    // recording into view (WF-12).
    const overview = this.overview;
    const centreOn = (clientX) => {
      const rect = overview.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      this.viewStart = frac * this.pcm.length - this.viewLen / 2;
      this._clampView();
      this.followPlayhead = true;
      this.draw();
      this.onViewChange(this._zoomLabel());
    };
    overview.addEventListener("pointerdown", (e) => {
      if (!this.pcm) return;
      e.preventDefault();
      overview.setPointerCapture(e.pointerId);
      this._overviewDrag = true;
      centreOn(e.clientX);
    });
    overview.addEventListener("pointermove", (e) => {
      if (!this.pcm || !this._overviewDrag) return;
      centreOn(e.clientX);
    });
    const endOverviewDrag = () => {
      this._overviewDrag = false;
    };
    overview.addEventListener("pointerup", endOverviewDrag);
    overview.addEventListener("pointercancel", endOverviewDrag);
    overview.addEventListener("lostpointercapture", endOverviewDrag);
  }

  _clampView() {
    const n = this.pcm.length;
    this.viewLen = Math.max(64, Math.min(n, this.viewLen));
    this.viewStart = Math.max(0, Math.min(n - this.viewLen, this.viewStart));
  }

  /** Replace the split list wholesale (used by undo/redo). */
  setSplits(splits) {
    this._hideCtxMenu();
    this.splits = (splits || []).map((s) => Math.round(s)).sort((a, b) => a - b);
    this.onSplitsChange(this.splits);
    this.draw();
  }

  addSplit(sample) {
    this._hideCtxMenu();
    // WF-2: reject splits at the very start/end and duplicates, so the labels
    // and the clip list can never disagree about how many splits there are.
    const v = Math.round(sample);
    if (!isValidSplit(v, this.pcm ? this.pcm.length : 0)) return;
    if (this.splits.includes(v)) return;
    this.splits.push(v);
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
