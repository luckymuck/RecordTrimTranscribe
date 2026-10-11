/* tslint:disable */
/* eslint-disable */

/**
 * A reusable input-to-output position map for one baked render.
 *
 * This makes speed-baked clip exports use the same map the audio render uses,
 * including the non-uniform class-aware plan.
 */
export class BakedMap {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Output sample position for the given input sample position.
     */
    map_position(position: number): number;
    constructor(samples: Float32Array, sample_rate: number, speed: number, class_aware: boolean);
}

/**
 * Input-to-output position map matching [`time_stretch_skip_silence`].
 *
 * Held as `(src_start, src_end, out_start, out_len)` per kept segment. The
 * output is contiguous across kept segments, so a position inside a skipped gap
 * maps to the shared boundary between its neighbours. Rates come from the same
 * `class_rate` the render uses, so boundaries and audio cannot disagree.
 */
export class SkipBakedMap {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Output sample position for the given input sample position.
     */
    map_position(position: number): number;
    constructor(samples: Float32Array, sample_rate: number, speed: number, class_aware: boolean, min_silence_s: number, keep_s: number);
}

/**
 * Causal, real-time time-scale modification for interactive playback.
 */
export class StreamStretcher {
    free(): void;
    [Symbol.dispose](): void;
    available_output(): number;
    /**
     * Signal that no more input will be pushed.
     */
    finish(): void;
    constructor(sample_rate: number, speed: number);
    /**
     * Take up to `max` rendered output samples.
     */
    pull(max: number): Float32Array;
    /**
     * Append input samples (mono, at the constructor's sample rate).
     */
    push(samples: Float32Array): void;
    reset(): void;
    set_speed(speed: number): void;
    /**
     * Jump the input cursor forward, discarding buffered input (skip a silence).
     */
    skip_to(input_pos: number): void;
    readonly speed: number;
}

/**
 * Summary of an analysis pass, returned as a small JSON object.
 */
export function analyze(samples: Float32Array, sample_rate: number): string;

/**
 * Silence runs longer than `min_silence_s`, as flat `[start, end, ...]` sample
 * positions. Boundaries are the raw detected silence edges; the caller insets
 * them by the speed-dependent keep.
 *
 * Runs on the `f32` samples directly so enabling skip-silence on a long
 * recording never materialises a full-length `f64` copy.
 */
export function silence_zones(samples: Float32Array, sample_rate: number, min_silence_s: number): Float64Array;

/**
 * Install a panic hook so a panic reports its message and location in the
 * browser console instead of trapping as "unreachable" (CORE-12).
 */
export function start(): void;

/**
 * Offline time-scale modification of a mono clip.
 *
 * `class_aware` uses an energy-based silence/speech segmentation to allocate the
 * speed budget (silence compresses harder, speech is protected); otherwise a
 * uniform ratio is used. Pitch is preserved in both cases.
 */
export function time_stretch(samples: Float32Array, sample_rate: number, speed: number, class_aware: boolean): Float32Array;

/**
 * Offline render with silence longer than `min_silence_s` cut down to a `keep_s`
 * pause, then the rest stretched to `speed`.
 *
 * Each kept segment is rendered on its own and concatenated. The joins land at
 * energy minima (that is what "silence" means), so no long crossfade is needed;
 * a short one (5 ms) is applied anyway so the seam cannot step.
 */
export function time_stretch_skip_silence(samples: Float32Array, sample_rate: number, speed: number, class_aware: boolean, min_silence_s: number, keep_s: number): Float32Array;

/**
 * Crate version, useful for cache-busting the WASM in the client.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_bakedmap_free: (a: number, b: number) => void;
    readonly __wbg_skipbakedmap_free: (a: number, b: number) => void;
    readonly __wbg_streamstretcher_free: (a: number, b: number) => void;
    readonly analyze: (a: number, b: number, c: number) => [number, number];
    readonly bakedmap_map_position: (a: number, b: number) => number;
    readonly bakedmap_new: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly silence_zones: (a: number, b: number, c: number, d: number) => [number, number];
    readonly skipbakedmap_map_position: (a: number, b: number) => number;
    readonly skipbakedmap_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly start: () => void;
    readonly streamstretcher_available_output: (a: number) => number;
    readonly streamstretcher_finish: (a: number) => void;
    readonly streamstretcher_new: (a: number, b: number) => number;
    readonly streamstretcher_pull: (a: number, b: number) => [number, number];
    readonly streamstretcher_push: (a: number, b: number, c: number) => void;
    readonly streamstretcher_reset: (a: number) => void;
    readonly streamstretcher_set_speed: (a: number, b: number) => void;
    readonly streamstretcher_skip_to: (a: number, b: number) => void;
    readonly streamstretcher_speed: (a: number) => number;
    readonly time_stretch: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly time_stretch_skip_silence: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly version: () => [number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
