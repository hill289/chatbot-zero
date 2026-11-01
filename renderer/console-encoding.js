/*!
 * console-encoding.js — 子进程控制台输出解码（Windows 中文乱码修复）
 *
 * 为什么需要它
 * ------------
 * Windows 上「同一条命令」的 stdout/stderr 往往混着两种编码：
 *   · node.exe / npm / tsc 这类程序直接往管道写 UTF-8；
 *   · cmd.exe 的**内建**消息（`'head' 不是内部或外部命令…`）、本地化错误 DLL、
 *     原生 EXE 的 stderr，走的是控制台 OEM 代码页（简体中文 = CP936/GBK）。
 * `chcp 65001` 只能改前者，改不动后者（这一点在 opencode 的
 * `smartDecodeOutput` 注释里已明确记录）。统一按 UTF-8 解，中文 cmd 消息就
 * 变成 `'head' �����ڲ����ⲿ���` 这种乱码。
 *
 * 策略（对齐 opencode：先严格 UTF-8，失败再按 GB18030 重解）
 * ----------------------------------------------------------
 *   1. 严格 UTF-8 解码成功 → 说明这段就是 UTF-8，原样返回；
 *   2. 失败且平台是 win32 → 按 GB18030（GBK 的超集）重解；
 *   3. 仍失败 → lossy UTF-8（保留结构，宁可有个别替换符也不丢整段输出）。
 *
 * 流式版本按「行」切分、逐行判定编码：GBK 的续字节范围（0x40–0x7E /
 * 0x80–0xFE）与 UTF-8 的续字节（0x80–0xBF）都不包含 0x0A / 0x0D，
 * 所以按换行切分不会劈坏多字节字符；按行判定又能避免「一段 GBK 把后面
 * 整段 UTF-8 连坐成乱码」（整段 sniff 的通病）。
 *
 * 该文件同时供主进程 require() 与渲染层 <script> 使用，因此不依赖 Buffer。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.PgpyConsoleEncoding = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  // 单段（无换行）缓冲上限：超过就强制吐出，避免超长单行把实时输出憋死
  const MAX_PENDING_BYTES = 64 * 1024;
  const REPLACEMENT = '\uFFFD';

  function guessPlatform() {
    try {
      if (typeof process !== 'undefined' && process && process.platform) return process.platform;
    } catch (_) { /* ignore */ }
    try {
      if (typeof navigator !== 'undefined' && /win/i.test(String(navigator.platform || navigator.userAgent || ''))) {
        return 'win32';
      }
    } catch (_) { /* ignore */ }
    return 'linux';
  }

  function toBytes(chunk) {
    if (!chunk) return new Uint8Array(0);
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof ArrayBuffer !== 'undefined' && chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView && ArrayBuffer.isView(chunk)) {
      return new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength);
    }
    if (typeof chunk === 'string') {
      // 兜底：调用方误传了字符串。按内码逐字节还原，至少不崩。
      const out = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) out[i] = chunk.charCodeAt(i) & 0xff;
      return out;
    }
    return new Uint8Array(0);
  }

  function makeDecoder(label, fatal) {
    const TD = typeof TextDecoder === 'function' ? TextDecoder : null;
    if (!TD) return null;
    try { return new TD(label, { fatal: !!fatal }); } catch (_) { return null; }
  }

  /** 严格解码；失败（非法字节 / 编码不支持）返回 null。 */
  function decodeStrict(bytes, label) {
    const dec = makeDecoder(label, true);
    if (!dec) return null;
    try { return dec.decode(bytes); } catch (_) { return null; }
  }

  function decodeLossy(bytes) {
    const dec = makeDecoder('utf-8', false);
    if (dec) {
      try { return dec.decode(bytes); } catch (_) { /* fall through */ }
    }
    // 最后兜底（无 TextDecoder 的极端环境）：按 latin1 直出，保证不抛错
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /**
   * 解码一段（通常是一行）控制台字节。
   * @returns {{ text: string, mode: 'utf-8'|'gb18030'|'lossy' }}
   */
  function decodeSegment(bytes, platform) {
    bytes = toBytes(bytes);
    if (bytes.length === 0) return { text: '', mode: 'utf-8' };

    const utf8 = decodeStrict(bytes, 'utf-8');
    if (utf8 !== null) return { text: utf8, mode: 'utf-8' };

    // 纯 ASCII 的 GBK 串在严格 UTF-8 下本就成功，走不到这里；
    // 走到这里说明确有非 UTF-8 字节，Windows 上按 GB18030 兜底。
    if ((platform || guessPlatform()) === 'win32') {
      const gb = decodeStrict(bytes, 'gb18030');
      if (gb !== null) return { text: gb, mode: 'gb18030' };
    }

    return { text: decodeLossy(bytes), mode: 'lossy' };
  }

  /**
   * 解码整块缓冲区（非流式）。等价于 opencode 的 smartDecodeOutput：
   * 严格 UTF-8 → win32 下 GB18030 → lossy UTF-8。
   */
  function decodeConsoleBuffer(chunk, platform) {
    return decodeSegment(chunk, platform).text;
  }

  function concatBytes(a, b) {
    if (!a || a.length === 0) return b;
    if (!b || b.length === 0) return a;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  /**
   * 流式解码器：喂 Buffer/Uint8Array，按换行切段并逐段判定编码。
   * @param {{ platform?: string, onText?: (text: string) => void }} [opts]
   */
  function createConsoleStreamDecoder(opts) {
    opts = opts || {};
    const platform = opts.platform || guessPlatform();
    const onText = typeof opts.onText === 'function' ? opts.onText : function () {};
    let pending = new Uint8Array(0);
    let fallbackSegments = 0;
    let lastMode = 'utf-8';

    function emitSegment(bytes) {
      const d = decodeSegment(bytes, platform);
      lastMode = d.mode;
      if (d.mode === 'lossy') fallbackSegments++;
      if (d.text) onText(d.text);
    }

    function push(chunk) {
      const bytes = toBytes(chunk);
      if (bytes.length) pending = concatBytes(pending, bytes);
      if (pending.length === 0) return;

      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        const b = pending[i];
        if (b !== 0x0a && b !== 0x0d) continue;
        // CRLF 作为一段处理；单独的 CR（进度条）也立刻吐出
        if (b === 0x0d && i + 1 < pending.length && pending[i + 1] === 0x0a) i++;
        emitSegment(pending.subarray(start, i + 1));
        start = i + 1;
      }
      if (start > 0) pending = pending.slice(start);

      // 超长单行：切在最近的 ASCII 边界上，保证不劈坏多字节字符
      if (pending.length > MAX_PENDING_BYTES) {
        let cut = -1;
        const floor = Math.max(0, pending.length - MAX_PENDING_BYTES);
        for (let i = pending.length - 1; i >= floor; i--) {
          if (pending[i] < 0x80) { cut = i + 1; break; }
        }
        if (cut <= 0) cut = pending.length; // 整段非 ASCII（多为二进制）：整体吐出，交给 lossy 兜底
        emitSegment(pending.subarray(0, cut));
        pending = pending.slice(cut);
      }
    }

    function flush() {
      if (pending.length === 0) return;
      const bytes = pending;
      pending = new Uint8Array(0);
      emitSegment(bytes);
    }

    return {
      push: push,
      flush: flush,
      get platform() { return platform; },
      get pendingBytes() { return pending.length; },
      get lastMode() { return lastMode; },
      /** 取走「既非 UTF-8 也非 GB18030」的段落数（用于生成 encodingHint）。 */
      takeFallbackCount: function () { const n = fallbackSegments; fallbackSegments = 0; return n; },
    };
  }

  return {
    MAX_PENDING_BYTES: MAX_PENDING_BYTES,
    guessPlatform: guessPlatform,
    decodeSegment: decodeSegment,
    decodeConsoleBuffer: decodeConsoleBuffer,
    // 与 opencode 命名对齐（主进程/单测都可用）
    smartDecodeOutput: decodeConsoleBuffer,
    createConsoleStreamDecoder: createConsoleStreamDecoder,
    _internal: { toBytes: toBytes, decodeStrict: decodeStrict, decodeLossy: decodeLossy, REPLACEMENT: REPLACEMENT },
  };
});
