
/**
 * Filter directory files based on configuration
 *
 * This function filters a list of file paths based on directory search configuration,
 * including file type filters, ignore patterns, depth limits, and hidden file settings.
 *
 * # Arguments
 * * `config` - JSON string of DirectorySearchConfig object
 * * `file_paths` - JSON string of array of file path strings
 *
 * # Returns
 * JSON string of array of FilePathEntry objects (filtered and annotated with depth)
 * @param {string} config
 * @param {string} file_paths
 * @returns {string}
 */
function filter_directory_files(config, file_paths) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(config, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(file_paths, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.filter_directory_files(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Simple grep function that returns files containing the pattern
 *
 * This is a convenience wrapper around `search()` with `output_format: "files_only"`.
 *
 * # Arguments
 * * `pattern` - The search pattern
 * * `files` - JSON string of array of FileEntry objects
 * * `options` - Optional JSON string of SearchOptions (pass null for default options)
 *   Supported options:
 *   - `case_insensitive`: boolean - Case-insensitive search (default: false)
 *   - `word_boundary`: boolean - Word boundary matching (default: false)
 *   - `fixed_strings`: boolean - Fixed string matching (default: false)
 *
 * # Returns
 * JSON string of array of file paths that contain the pattern
 *
 * # Examples
 * ```javascript
 * // Default search (case-sensitive)
 * grep("hello", filesJson, null);
 *
 * // Case-insensitive search
 * grep("hello", filesJson, JSON.stringify({ case_insensitive: true }));
 *
 * // Word boundary matching
 * grep("main", filesJson, JSON.stringify({ word_boundary: true }));
 *
 * // Combined options
 * grep("hello", filesJson, JSON.stringify({
 *   case_insensitive: true,
 *   word_boundary: true
 * }));
 * ```
 * @param {string} pattern
 * @param {string} files
 * @param {string | null} [options]
 * @returns {string}
 */
function grep(pattern, files, options) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(pattern, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(files, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(options) ? 0 : passStringToWasm0(options, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len2 = WASM_VECTOR_LEN;
        const ret = wasm.grep(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Command-line style grep function that parses arguments like "grep -i pattern"
 *
 * # Arguments
 * * `args` - JSON string of array of command line arguments, e.g., ["grep", "-i", "pattern"]
 * * `files` - JSON string of array of FileEntry objects
 *
 * # Returns
 * JSON string of array of file paths that contain the pattern
 *
 * # Example
 * ```javascript
 * const result = grep_cmd(
 *   JSON.stringify(["grep", "-i", "hello"]),
 *   JSON.stringify(files)
 * );
 * ```
 * @param {string} args
 * @param {string} files
 * @returns {string}
 */
function grep_cmd(args, files) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(args, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(files, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.grep_cmd(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Search for a pattern in a list of files
 *
 * # Arguments
 * * `pattern` - The search pattern (regex or literal string)
 * * `files` - JSON string of array of FileEntry objects
 * * `options` - Optional JSON string of SearchOptions (pass null or empty string for default)
 *
 * # Returns
 * JSON string of SearchResult or array of file paths (depending on output_format)
 * @param {string} pattern
 * @param {string} files
 * @param {string | null} [options]
 * @returns {string}
 */
function search(pattern, files, options) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(pattern, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(files, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(options) ? 0 : passStringToWasm0(options, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len2 = WASM_VECTOR_LEN;
        const ret = wasm.search(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Search for a pattern in a directory
 *
 * This function searches for a pattern in files within a directory structure.
 * It applies directory configuration filters and returns detailed search results
 * including line numbers.
 *
 * # Arguments
 * * `pattern` - The search pattern (regex or literal string)
 * * `config` - JSON string of DirectorySearchConfig object
 * * `files` - JSON string of array of FileEntry objects (files should be pre-filtered)
 * * `options` - Optional JSON string of SearchOptions (pass null for default)
 *
 * # Returns
 * JSON string of SearchResult with matches including line numbers
 *
 * # Example
 * ```javascript
 * const config = {
 *   root_path: "/project",
 *   max_depth: 5,
 *   file_types: ["*.js", "*.ts"],
 *   ignore_patterns: ["node_modules", "*.log"]
 * };
 *
 * const files = [
 *   { path: "/project/src/main.js", content: "function main() {}" }
 * ];
 *
 * const result = search_directory(
 *   "function",
 *   JSON.stringify(config),
 *   JSON.stringify(files),
 *   JSON.stringify({ case_insensitive: true })
 * );
 * ```
 * @param {string} pattern
 * @param {string} config
 * @param {string} files
 * @param {string | null} [options]
 * @returns {string}
 */
function search_directory(pattern, config, files, options) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(pattern, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(config, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(files, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        var ptr3 = isLikeNone(options) ? 0 : passStringToWasm0(options, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len3 = WASM_VECTOR_LEN;
        const ret = wasm.search_directory(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
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
        "./ripgrep_wasm_bg.js": import0,
    };
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory = null;
function getUint8ArrayMemory() {
    if (cachedUint8ArrayMemory === null || cachedUint8ArrayMemory.byteLength === 0) {
        cachedUint8ArrayMemory = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory();

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
        const view = getUint8ArrayMemory().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
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
    return cachedTextDecoder.decode(getUint8ArrayMemory().subarray(ptr, ptr + len));
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

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

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
        module_or_path = new URL('ripgrep_wasm_bg.wasm', window.__ripgrepWasmUrl);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

window.__ripgrepInit=__wbg_init;window.__ripgrepInitSync=initSync;

// --- ripgrep-wasm: instantiate from base64 (no fetch, file:// safe) + expose search wrapper ---
(function(){
  try {
    var binaryStr = atob(window.__ripgrepWasmBase64);
    var len = binaryStr.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) { bytes[i] = binaryStr.charCodeAt(i); }
    window.__ripgrepInitSync({ module: bytes });
    window.__ripgrepSearch = function(pattern, filesJson, optionsJson) {
      var opt = (optionsJson === null || optionsJson === undefined) ? null : optionsJson;
      return search(pattern, filesJson, opt);
    };
    window.__ripgrepReady = true;
  } catch (err) {
    console.error("[ripgrep] WASM init failed:", err);
    window.__ripgrepReady = false;
  }
})();
