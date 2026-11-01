// @iyulab/anydoc — 非模块方式初始化（v2：通过 window.__anydocWasm 命名空间 API 工作）
// 依赖:
//   1) anydoc_wasm_b64.js          -> window.__anydocWasmBase64 (base64 字符串)
//   2) anydoc_wasm_bg_nomodule.js  -> window.__anydocWasm (IIFE 命名空间版，
//      内部声明不写入全局，避免与 ripgrep_wasm_nomodule.js 等 wasm 胶水冲突)
// 流程: 解码 base64 → WebAssembly.instantiate → setWasm 注入句柄 → 暴露解析 API。
// 兼容接口保持不变: window.__undocParse / window.__anydocParse / window.__undocReady。
(function() {
  try {
    // --- 0. 读取隔离后的 wasm 胶水 API（不再直接依赖裸全局函数名）---
    var api = window.__anydocWasm;
    if (!api || typeof api.setWasm !== 'function' || !api.imports) {
      throw new Error('anydoc_wasm_bg_nomodule.js 未正确加载（window.__anydocWasm 缺失）');
    }

    // --- 1. 解码 base64 → Uint8Array ---
    var binaryStr = atob(window.__anydocWasmBase64);
    var len = binaryStr.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // --- 2. WASM 导入对象（由 anydoc_wasm_bg_nomodule.js 在 IIFE 内部组装）---
    var importObj = api.imports;

    WebAssembly.instantiate(bytes, importObj).then(function(result) {
      var instance = result.instance;
      api.setWasm(instance.exports);
      var wasm = api.wasm; // 快照：setWasm 之后实例句柄不再变化

      // 与 anydoc_wasm.js 中 __wbindgen_enum_Format 保持一致
      var FORMAT_ENUM = ["doc", "docx", "odt", "pdf", "ppt", "pptx", "rtf", "epub", "xlsx", "ods", "odp", "csv"];

      function isLikeNone(x) {
        return x === undefined || x === null;
      }

      // 格式编号编码: enum 下标 + 1；未识别/空 → 13（由 wasm 自行探测）
      function formatTag(format) {
        return isLikeNone(format) ? 13 : ((FORMAT_ENUM.indexOf(format) + 1 || 13) - 1);
      }

      function formatFromBytesImpl(bytes) {
        var ptr0 = api.passArray8ToWasm0(bytes, wasm.__wbindgen_export);
        var len0 = api.WASM_VECTOR_LEN;
        var ret = wasm.formatFromBytes(ptr0, len0);
        return FORMAT_ENUM[ret];
      }

      function toMarkdownBytesImpl(bytes, format) {
        var deferred3_0;
        var deferred3_1;
        try {
          var retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
          var ptr0 = api.passArray8ToWasm0(bytes, wasm.__wbindgen_export);
          var len0 = api.WASM_VECTOR_LEN;
          wasm.toMarkdownBytes(retptr, ptr0, len0, formatTag(format));
          var r0 = api.getDataViewMemory0().getInt32(retptr + 4 * 0, true);
          var r1 = api.getDataViewMemory0().getInt32(retptr + 4 * 1, true);
          var r2 = api.getDataViewMemory0().getInt32(retptr + 4 * 2, true);
          var r3 = api.getDataViewMemory0().getInt32(retptr + 4 * 3, true);
          var ptr2 = r0;
          var len2 = r1;
          if (r3) {
            ptr2 = 0; len2 = 0;
            throw api.takeObject(r2);
          }
          deferred3_0 = ptr2;
          deferred3_1 = len2;
          return api.getStringFromWasm0(ptr2, len2);
        } finally {
          wasm.__wbindgen_add_to_stack_pointer(16);
          wasm.__wbindgen_export4(deferred3_0, deferred3_1, 1);
        }
      }

      // 兼容原 window.__undocParse 的返回结构: { format(), toMarkdown(), toText() }
      function parse(bytes) {
        var format = formatFromBytesImpl(bytes);
        return {
          format: function() { return format; },
          toMarkdown: function() { return toMarkdownBytesImpl(bytes, format); },
          // anydoc 未单独暴露纯文本提取，兜底返回 Markdown（仅当 Markdown 为空时被调用）
          toText: function() { return toMarkdownBytesImpl(bytes, format); }
        };
      }

      window.__undocParse = parse;   // 保持 index.html 原有调用逻辑不变
      window.__anydocParse = parse;  // 新的规范命名
      window.__undocReady = true;
    }).catch(function(err) {
      console.error('[anydoc] WASM instantiate failed:', err);
      window.__undocReady = false;
    });
  } catch (err) {
    console.error('[anydoc] Init failed:', err);
    window.__undocReady = false;
  }
})();
