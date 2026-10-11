/* @ts-self-types="./fasttalk_core.d.ts" */

/**
 * A reusable input-to-output position map for one baked render.
 *
 * This makes speed-baked clip exports use the same map the audio render uses,
 * including the non-uniform class-aware plan.
 */
export class BakedMap {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BakedMapFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_bakedmap_free(ptr, 0);
    }
    /**
     * Output sample position for the given input sample position.
     * @param {number} position
     * @returns {number}
     */
    map_position(position) {
        const ret = wasm.bakedmap_map_position(this.__wbg_ptr, position);
        return ret;
    }
    /**
     * @param {Float32Array} samples
     * @param {number} sample_rate
     * @param {number} speed
     * @param {boolean} class_aware
     */
    constructor(samples, sample_rate, speed, class_aware) {
        const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.bakedmap_new(ptr0, len0, sample_rate, speed, class_aware);
        this.__wbg_ptr = ret;
        BakedMapFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) BakedMap.prototype[Symbol.dispose] = BakedMap.prototype.free;

/**
 * Input-to-output position map matching [`time_stretch_skip_silence`].
 *
 * Held as `(src_start, src_end, out_start, out_len)` per kept segment. The
 * output is contiguous across kept segments, so a position inside a skipped gap
 * maps to the shared boundary between its neighbours. Rates come from the same
 * `class_rate` the render uses, so boundaries and audio cannot disagree.
 */
export class SkipBakedMap {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SkipBakedMapFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_skipbakedmap_free(ptr, 0);
    }
    /**
     * Output sample position for the given input sample position.
     * @param {number} position
     * @returns {number}
     */
    map_position(position) {
        const ret = wasm.skipbakedmap_map_position(this.__wbg_ptr, position);
        return ret;
    }
    /**
     * @param {Float32Array} samples
     * @param {number} sample_rate
     * @param {number} speed
     * @param {boolean} class_aware
     * @param {number} min_silence_s
     * @param {number} keep_s
     */
    constructor(samples, sample_rate, speed, class_aware, min_silence_s, keep_s) {
        const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.skipbakedmap_new(ptr0, len0, sample_rate, speed, class_aware, min_silence_s, keep_s);
        this.__wbg_ptr = ret;
        SkipBakedMapFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) SkipBakedMap.prototype[Symbol.dispose] = SkipBakedMap.prototype.free;

/**
 * Causal, real-time time-scale modification for interactive playback.
 */
export class StreamStretcher {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        StreamStretcherFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_streamstretcher_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    available_output() {
        const ret = wasm.streamstretcher_available_output(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Signal that no more input will be pushed.
     */
    finish() {
        wasm.streamstretcher_finish(this.__wbg_ptr);
    }
    /**
     * @param {number} sample_rate
     * @param {number} speed
     */
    constructor(sample_rate, speed) {
        const ret = wasm.streamstretcher_new(sample_rate, speed);
        this.__wbg_ptr = ret;
        StreamStretcherFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Take up to `max` rendered output samples.
     * @param {number} max
     * @returns {Float32Array}
     */
    pull(max) {
        const ret = wasm.streamstretcher_pull(this.__wbg_ptr, max);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Append input samples (mono, at the constructor's sample rate).
     * @param {Float32Array} samples
     */
    push(samples) {
        const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.streamstretcher_push(this.__wbg_ptr, ptr0, len0);
    }
    reset() {
        wasm.streamstretcher_reset(this.__wbg_ptr);
    }
    /**
     * @param {number} speed
     */
    set_speed(speed) {
        wasm.streamstretcher_set_speed(this.__wbg_ptr, speed);
    }
    /**
     * Jump the input cursor forward, discarding buffered input (skip a silence).
     * @param {number} input_pos
     */
    skip_to(input_pos) {
        wasm.streamstretcher_skip_to(this.__wbg_ptr, input_pos);
    }
    /**
     * @returns {number}
     */
    get speed() {
        const ret = wasm.streamstretcher_speed(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) StreamStretcher.prototype[Symbol.dispose] = StreamStretcher.prototype.free;

/**
 * Summary of an analysis pass, returned as a small JSON object.
 * @param {Float32Array} samples
 * @param {number} sample_rate
 * @returns {string}
 */
export function analyze(samples, sample_rate) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.analyze(ptr0, len0, sample_rate);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Consonant boost: a high-shelf above `corner_hz` plus light high-band
 * compression (S-4). `amount` (0..1) scales the compression.
 * @param {Float32Array} samples
 * @param {number} sample_rate
 * @param {number} corner_hz
 * @param {number} gain_db
 * @param {number} amount
 * @returns {Float32Array}
 */
export function consonant_boost(samples, sample_rate, corner_hz, gain_db, amount) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.consonant_boost(ptr0, len0, sample_rate, corner_hz, gain_db, amount);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Rumble/hum high-pass, applied to the source before stretching (S-5).
 * @param {Float32Array} samples
 * @param {number} sample_rate
 * @param {number} cutoff_hz
 * @returns {Float32Array}
 */
export function highpass(samples, sample_rate, cutoff_hz) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.highpass(ptr0, len0, sample_rate, cutoff_hz);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Silence runs longer than `min_silence_s`, as flat `[start, end, ...]` sample
 * positions. Boundaries are the raw detected silence edges; the caller insets
 * them by the speed-dependent keep.
 *
 * Runs on the `f32` samples directly so enabling skip-silence on a long
 * recording never materialises a full-length `f64` copy.
 * @param {Float32Array} samples
 * @param {number} sample_rate
 * @param {number} min_silence_s
 * @returns {Float64Array}
 */
export function silence_zones(samples, sample_rate, min_silence_s) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.silence_zones(ptr0, len0, sample_rate, min_silence_s);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * Soft limiter to `ceiling_db` (S-13).
 * @param {Float32Array} samples
 * @param {number} sample_rate
 * @param {number} ceiling_db
 * @returns {Float32Array}
 */
export function soft_limiter(samples, sample_rate, ceiling_db) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.soft_limiter(ptr0, len0, sample_rate, ceiling_db);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Install a panic hook so a panic reports its message and location in the
 * browser console instead of trapping as "unreachable" (CORE-12).
 */
export function start() {
    wasm.start();
}

/**
 * Offline time-scale modification of a mono clip.
 *
 * `class_aware` uses an energy-based silence/speech segmentation to allocate the
 * speed budget (silence compresses harder, speech is protected); otherwise a
 * uniform ratio is used. Pitch is preserved in both cases.
 * @param {Float32Array} samples
 * @param {number} sample_rate
 * @param {number} speed
 * @param {boolean} class_aware
 * @returns {Float32Array}
 */
export function time_stretch(samples, sample_rate, speed, class_aware) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.time_stretch(ptr0, len0, sample_rate, speed, class_aware);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Offline render with silence longer than `min_silence_s` cut down to a `keep_s`
 * pause, then the rest stretched to `speed`.
 *
 * Each kept segment is rendered on its own and concatenated. The joins land at
 * energy minima (that is what "silence" means), so no long crossfade is needed;
 * a short one (5 ms) is applied anyway so the seam cannot step.
 * @param {Float32Array} samples
 * @param {number} sample_rate
 * @param {number} speed
 * @param {boolean} class_aware
 * @param {number} min_silence_s
 * @param {number} keep_s
 * @returns {Float32Array}
 */
export function time_stretch_skip_silence(samples, sample_rate, speed, class_aware, min_silence_s, keep_s) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.time_stretch_skip_silence(ptr0, len0, sample_rate, speed, class_aware, min_silence_s, keep_s);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Crate version, useful for cache-busting the WASM in the client.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./fasttalk_core_bg.js": import0,
    };
}

const BakedMapFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_bakedmap_free(ptr, 1));
const SkipBakedMapFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_skipbakedmap_free(ptr, 1));
const StreamStretcherFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_streamstretcher_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('fasttalk_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
