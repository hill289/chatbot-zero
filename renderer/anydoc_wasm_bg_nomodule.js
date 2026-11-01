// @iyulab/anydoc — 非模块方式初始化辅助（命名空间隔离版 v2）
// 依赖: anydoc_wasm_b64.js (window.__anydocWasmBase64) + 本文件 (window.__anydocWasm)
//
// 为什么要改成 IIFE + window.__anydocWasm:
//   wasm-bindgen 生成的 no-module 胶水代码会在「全局作用域」顶层声明一批
//   let/const/var（cachedTextDecoder、cachedTextEncoder、WASM_VECTOR_LEN、
//   numBytesDecoded、MAX_SAFARI_DECODE_BYTES、wasm …）。
//   本页面已先加载了另一份同类胶水 ripgrep_wasm_nomodule.js，它也声明了完全相同的
//   顶层名字，于是浏览器解析本文件时抛出:
//     Uncaught SyntaxError: Identifier 'cachedTextDecoder' has already been declared
//   结果整个脚本不执行，anydoc-init.js 里引用的 __wbg_String_... 等全局函数不存在，
//   随后报 ReferenceError: __wbg_String_8564e559799eccda is not defined。
//
//   本版本把所有内部声明收进 IIFE 的局部作用域，不再向全局写任何 let/const/var，
//   从根本上避免与 ripgrep_wasm_nomodule.js（或未来其它 wasm 胶水）冲突；
//   只把 anydoc-init.js 需要的最小 API 挂到 window.__anydocWasm 上。
(function (global) {
  // ---------------------------------------------------------------------------
  // WASM 实例句柄（由 anydoc-init.js 在 instantiate 成功后调用 setWasm 注入）
  // ---------------------------------------------------------------------------
  var wasm = null;

  function setWasm(exports) {
    wasm = exports;
  }

  // ---------------------------------------------------------------------------
  // Heap（externref 表）管理
  // ---------------------------------------------------------------------------
  var heap = new Array(1024).fill(undefined);
  heap.push(undefined, null, true, false);
  var heap_next = heap.length;

  function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];
    heap[idx] = obj;
    return idx;
  }

  function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
  }

  function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
  }

  function getObject(idx) { return heap[idx]; }

  // ---------------------------------------------------------------------------
  // WASM 内存视图（wasm 内存增长后自动重建）
  // ---------------------------------------------------------------------------
  let cachedDataViewMemory0 = null;
  function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
      cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
  }

  let cachedUint8ArrayMemory0 = null;
  function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
      cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
  }

  function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
  }

  // ---------------------------------------------------------------------------
  // 文本编解码
  // ---------------------------------------------------------------------------
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

  function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
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

  function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
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

  // ---------------------------------------------------------------------------
  // 错误处理（wasm 抛出的 JS 异常通过 __wbindgen_export3 注册）
  // ---------------------------------------------------------------------------
  function handleError(f, args) {
    try {
      return f.apply(this, args);
    } catch (e) {
      wasm.__wbindgen_export3(addHeapObject(e));
    }
  }

  // ---------------------------------------------------------------------------
  // anydoc_wasm_bg.wasm 导入函数（对应 anydoc_wasm.js __wbg_get_imports()）
  // 模块名: "./anydoc_wasm_bg.js"
  // ---------------------------------------------------------------------------
  function __wbg_String_8564e559799eccda(arg0, arg1) {
    const ret = String(getObject(arg1));
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  }

  function __wbg___wbindgen_throw_344f42d3211c4765(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  }

  function __wbg_from_13e323c65fc8f464(arg0) {
    const ret = Array.from(getObject(arg0));
    return addHeapObject(ret);
  }

  function __wbg_getRandomValues_cc7f052a444bb2ce() {
    return handleError(function (arg0, arg1) {
      globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments);
  }

  function __wbg_new_32b398fb48b6d94a() {
    const ret = new Array();
    return addHeapObject(ret);
  }

  function __wbg_new_b667d279fd5aa943(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
  }

  function __wbg_new_cd45aabdf6073e84(arg0) {
    const ret = new Uint8Array(getObject(arg0));
    return addHeapObject(ret);
  }

  function __wbg_new_da52cf8fe3429cb2() {
    const ret = new Object();
    return addHeapObject(ret);
  }

  function __wbg_set_6be42768c690e380(arg0, arg1, arg2) {
    getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
  }

  function __wbg_set_8535240470bf2500() {
    return handleError(function (arg0, arg1, arg2) {
      const ret = Reflect.set(getObject(arg0), getObject(arg1), getObject(arg2));
      return ret;
    }, arguments);
  }

  function __wbg_set_8a16b38e4805b298(arg0, arg1, arg2) {
    getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
  }

  function __wbindgen_cast_0000000000000001(arg0) {
    // Cast intrinsic for `F64 -> Externref`.
    const ret = arg0;
    return addHeapObject(ret);
  }

  function __wbindgen_cast_0000000000000002(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
    const ret = getArrayU8FromWasm0(arg0, arg1);
    return addHeapObject(ret);
  }

  function __wbindgen_cast_0000000000000003(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return addHeapObject(ret);
  }

  function __wbindgen_object_clone_ref(arg0) {
    const ret = getObject(arg0);
    return addHeapObject(ret);
  }

  function __wbindgen_object_drop_ref(arg0) {
    takeObject(arg0);
  }

  // ---------------------------------------------------------------------------
  // 对外暴露的最小 API（全部收进 window.__anydocWasm，不污染全局作用域）
  // anydoc-init.js 通过该对象完成实例化与解析，不再依赖裸全局函数名。
  // 注意: wasm / WASM_VECTOR_LEN 用 getter 暴露，保证拿到的是 IIFE 内的最新值。
  // ---------------------------------------------------------------------------
  var imports = {
    './anydoc_wasm_bg.js': {
      __wbg_String_8564e559799eccda: __wbg_String_8564e559799eccda,
      __wbg___wbindgen_throw_344f42d3211c4765: __wbg___wbindgen_throw_344f42d3211c4765,
      __wbg_from_13e323c65fc8f464: __wbg_from_13e323c65fc8f464,
      __wbg_getRandomValues_cc7f052a444bb2ce: __wbg_getRandomValues_cc7f052a444bb2ce,
      __wbg_new_32b398fb48b6d94a: __wbg_new_32b398fb48b6d94a,
      __wbg_new_b667d279fd5aa943: __wbg_new_b667d279fd5aa943,
      __wbg_new_cd45aabdf6073e84: __wbg_new_cd45aabdf6073e84,
      __wbg_new_da52cf8fe3429cb2: __wbg_new_da52cf8fe3429cb2,
      __wbg_set_6be42768c690e380: __wbg_set_6be42768c690e380,
      __wbg_set_8535240470bf2500: __wbg_set_8535240470bf2500,
      __wbg_set_8a16b38e4805b298: __wbg_set_8a16b38e4805b298,
      __wbindgen_cast_0000000000000001: __wbindgen_cast_0000000000000001,
      __wbindgen_cast_0000000000000002: __wbindgen_cast_0000000000000002,
      __wbindgen_cast_0000000000000003: __wbindgen_cast_0000000000000003,
      __wbindgen_object_clone_ref: __wbindgen_object_clone_ref,
      __wbindgen_object_drop_ref: __wbindgen_object_drop_ref,
    }
  };

  global.__anydocWasm = {
    setWasm: setWasm,
    get wasm() { return wasm; },
    get WASM_VECTOR_LEN() { return WASM_VECTOR_LEN; },
    passArray8ToWasm0: passArray8ToWasm0,
    getDataViewMemory0: getDataViewMemory0,
    takeObject: takeObject,
    getStringFromWasm0: getStringFromWasm0,
    imports: imports
  };
})(window);
