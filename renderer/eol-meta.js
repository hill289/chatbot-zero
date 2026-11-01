/*!
 * eol-meta.js — 文本「原样」保真（EOL / BOM / 末尾换行 / 编码）
 * =============================================================================
 * 问题：用户拖入的文件是**磁盘原始字节**，AI 在虚拟 FS 里改写时统一写 UTF-8 + LF。
 * 于是「只改了三行」的文件写回磁盘后可能整篇变 LF、丢掉 BOM、被编码器改成 UTF-16
 * 反过来，git 里一片红；而审核界面的 diff 是按 \r?\n 切行的，EOL 差异根本看不见——
 * 审核结论与交付内容不一致。
 *
 * 做法：在「改动前基线」（= 拖入时的原始字节）上抽取一份文本风格档案（profile），
 * 写回前把 AI 产出的字节按档案还原：换行风格、BOM、末尾换行、编码。
 *
 * 安全约束（宁可不改，也不许改坏）：
 *   1) 非文本 / 非法 UTF-8 / 含替换符 → detect() 返回 null → 调用方原样写回；
 *   2) 换行风格混合 → 不猜，原样写回；
 *   3) 还原结果与输入字节完全一致时返回同一份字节（幂等，不制造无意义写入）。
 *
 * UMD：浏览器挂 globalThis.EolMeta；Node 下 module.exports（供 eol-meta.test.js）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.EolMeta = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var REPLACEMENT = '\uFFFD';
  var SAMPLE = 1024;          // 二进制判定采样字节数
  var CTRL_RATIO = 0.30;      // 不可打印字符占比阈值

  // ── 字节归一 ────────────────────────────────────────────────
  function toBytes(x) {
    if (x == null) return null;
    if (typeof x === 'string') return new TextEncoder().encode(x);
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x.buffer instanceof ArrayBuffer) {
      return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength != null ? x.byteLength : x.buffer.byteLength);
    }
    return null;
  }

  function startsWith(u8, arr) {
    if (u8.length < arr.length) return false;
    for (var i = 0; i < arr.length; i++) if (u8[i] !== arr[i]) return false;
    return true;
  }

  // ── 编码探测 ────────────────────────────────────────────────
  // 'utf8bom' | 'utf16le' | 'utf16be' | 'utf8' | 'binary'
  function detectEncoding(u8) {
    if (!u8 || !u8.length) return 'utf8';
    if (startsWith(u8, [0xEF, 0xBB, 0xBF])) return 'utf8bom';
    if (startsWith(u8, [0xFF, 0xFE])) return 'utf16le';
    if (startsWith(u8, [0xFE, 0xFF])) return 'utf16be';
    if (looksBinary(u8)) return 'binary';
    return 'utf8';
  }

  // 无 BOM 时判断「不像文本」：含 NUL，或不可打印控制符占比过高
  function looksBinary(u8) {
    var n = Math.min(u8.length, SAMPLE);
    var bad = 0;
    for (var i = 0; i < n; i++) {
      var b = u8[i];
      if (b === 0) return true;
      var printable = (b >= 0x20 && b !== 0x7F) || b === 0x09 || b === 0x0A || b === 0x0D;
      if (!printable && b < 0x80) bad++;
    }
    return n > 0 && (bad / n) > CTRL_RATIO;
  }

  // ── 解码 / 编码 ─────────────────────────────────────────────
  // 严格 UTF-8：含非法序列 → 返回 null（调用方据此放弃改写）
  function decodeUtf8Strict(u8) {
    var body = u8;
    if (startsWith(u8, [0xEF, 0xBB, 0xBF])) body = u8.subarray(3);
    try {
      if (typeof TextDecoder === 'function') {
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
      }
    } catch (_) { return null; }
    // 无 TextDecoder 的降级：手写 UTF-8 解码，遇非法返回 null
    return decodeUtf8Manual(body);
  }

  function decodeUtf8Manual(u8) {
    var out = '';
    var i = 0;
    while (i < u8.length) {
      var b = u8[i++];
      if (b < 0x80) { out += String.fromCharCode(b); continue; }
      var need, cp;
      if ((b & 0xE0) === 0xC0) { need = 1; cp = b & 0x1F; }
      else if ((b & 0xF0) === 0xE0) { need = 2; cp = b & 0x0F; }
      else if ((b & 0xF8) === 0xF0) { need = 3; cp = b & 0x07; }
      else return null;
      if (i + need > u8.length) return null;
      for (var k = 0; k < need; k++) {
        var c = u8[i++];
        if ((c & 0xC0) !== 0x80) return null;
        cp = (cp << 6) | (c & 0x3F);
      }
      if (cp > 0x10FFFF) return null;
      if (cp > 0xFFFF) {
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else {
        out += String.fromCharCode(cp);
      }
    }
    return out;
  }

  function decodeUtf16(u8, little) {
    var body = u8;
    if (little && startsWith(u8, [0xFF, 0xFE])) body = u8.subarray(2);
    if (!little && startsWith(u8, [0xFE, 0xFF])) body = u8.subarray(2);
    var n = body.length >> 1;
    var codes = new Array(n);
    for (var i = 0; i < n; i++) {
      var lo = little ? body[2 * i] : body[2 * i + 1];
      var hi = little ? body[2 * i + 1] : body[2 * i];
      codes[i] = lo | (hi << 8);
    }
    var out = '';
    for (var j = 0; j < codes.length; j += 8192) {
      out += String.fromCharCode.apply(null, codes.slice(j, j + 8192));
    }
    return out;
  }

  function decode(u8, enc) {
    var b = toBytes(u8);
    if (!b) return null;
    if (enc === 'utf16le') return decodeUtf16(b, true);
    if (enc === 'utf16be') return decodeUtf16(b, false);
    return decodeUtf8Strict(b);
  }

  function encode(text, enc) {
    if (enc === 'utf16le' || enc === 'utf16be') {
      var little = enc === 'utf16le';
      var out = new Uint8Array(2 + text.length * 2);
      out[0] = little ? 0xFF : 0xFE;
      out[1] = little ? 0xFE : 0xFF;
      for (var i = 0; i < text.length; i++) {
        var code = text.charCodeAt(i);
        out[2 + 2 * i] = little ? (code & 0xFF) : (code >> 8);
        out[3 + 2 * i] = little ? (code >> 8) : (code & 0xFF);
      }
      return out;
    }
    var body = new TextEncoder().encode(text);
    if (enc === 'utf8bom') {
      var withBom = new Uint8Array(body.length + 3);
      withBom[0] = 0xEF; withBom[1] = 0xBB; withBom[2] = 0xBF;
      withBom.set(body, 3);
      return withBom;
    }
    return body;
  }

  // ── 换行 / 末尾换行 ─────────────────────────────────────────
  function detectEol(text) {
    var crlf = 0, lf = 0, cr = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else { cr++; }
      } else if (c === 10) {
        lf++;
      }
    }
    var mixed = (crlf > 0 && (lf > 0 || cr > 0)) || (lf > 0 && cr > 0);
    var eol = 'lf';
    if (crlf >= lf && crlf >= cr && crlf > 0) eol = 'crlf';
    else if (cr > lf && cr >= crlf) eol = 'cr';
    return { eol: eol, mixed: mixed, crlf: crlf, lf: lf, cr: cr };
  }

  function normalizeNewlines(text) {
    return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function endsWithNewline(text) {
    return /(\r\n|\n|\r)$/.test(String(text));
  }

  // ── 档案抽取 ────────────────────────────────────────────────
  // 返回 null 表示「不适合做字节级还原」（二进制 / 非法编码 / 混合换行）
  function detect(input) {
    var u8 = toBytes(input);
    if (!u8 || !u8.length) return null;
    var enc = detectEncoding(u8);
    if (enc === 'binary') return null;
    var text = decode(u8, enc);
    if (text == null) return null;
    if (text.indexOf(REPLACEMENT) !== -1) return null;   // 非 UTF-8 文本（如 GBK），不碰
    var e = detectEol(text);
    if (e.mixed) return null;                            // 换行风格混合，不猜
    return {
      enc: enc,
      eol: e.eol,
      mixed: false,
      finalNewline: endsWithNewline(text),
      byteLength: u8.length,
      newlineCount: e.crlf + e.lf + e.cr
    };
  }

  // ── 按档案还原 ──────────────────────────────────────────────
  function applyProfile(text, meta) {
    var t = normalizeNewlines(text);
    if (meta.eol === 'crlf') t = t.replace(/\n/g, '\r\n');
    else if (meta.eol === 'cr') t = t.replace(/\n/g, '\r');
    if (meta.finalNewline === false) {
      t = t.replace(/(\r\n|\n|\r)$/, '');      // 只去掉多出来的那一个
    } else if (meta.finalNewline === true) {
      var nl = meta.eol === 'crlf' ? '\r\n' : (meta.eol === 'cr' ? '\r' : '\n');
      if (!endsWithNewline(t)) t += nl;
    }
    return t;
  }

  /**
   * 把「AI 产出的字节」按「参考字节」的文本风格还原。
   * @param {Uint8Array|ArrayBuffer|string} current 待写回的字节
   * @param {{enc,eol,finalNewline,mixed}} meta 由 detect(参考字节) 得到
   * @returns {Uint8Array} 还原后的字节；无法安全还原时原样返回入参字节
   */
  function restoreBytes(current, meta) {
    var u8 = toBytes(current);
    if (!u8 || !meta || meta.mixed) return u8;
    // 当前字节：先按 UTF-8 严格解码（AI 写的是 UTF-8），失败则按其自带 BOM 的编码解
    var enc = detectEncoding(u8);
    var text = (enc === 'utf16le' || enc === 'utf16be') ? decode(u8, enc) : decodeUtf8Strict(u8);
    if (text == null) return u8;
    if (text.indexOf(REPLACEMENT) !== -1) return u8;
    var fixed = applyProfile(text, meta);
    var out = encode(fixed, meta.enc || 'utf8');
    return out;
  }

  // ── 字节工具 ────────────────────────────────────────────────
  function sameBytes(a, b) {
    var x = toBytes(a), y = toBytes(b);
    if (!x || !y) return false;
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  /**
   * 规范化字节：去掉 BOM、把 \r\n / \r 统一成 \n、按 UTF-8 重新编码。
   * 用于「跨换行风格」比较——磁盘上是 CRLF、虚拟 FS 里是 LF 时，
   * 两份内容其实相同，逐字节比会误判成「磁盘被改过」。
   * 非文本（二进制 / 非法编码）原样返回。
   */
  function canonicalBytes(input) {
    var u8 = toBytes(input);
    if (!u8) return null;
    var enc = detectEncoding(u8);
    if (enc === 'binary') return u8;
    var text = decode(u8, enc);
    if (text == null || text.indexOf(REPLACEMENT) !== -1) return u8;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return new TextEncoder().encode(normalizeNewlines(text));
  }

  // 两份内容在「忽略换行风格差异」后是否相同（文本）/ 完全相同（二进制）
  function sameText(a, b) {
    var x = canonicalBytes(a), y = canonicalBytes(b);
    if (!x || !y) return false;
    return sameBytes(x, y);
  }

  // 规范化哈希：换行风格不同的同一份内容得到同一个哈希
  function canonicalHash(input) {
    return hash(canonicalBytes(input));
  }

  // FNV-1a 32 位 + 字节长度：用于「磁盘有没有被外部改过」的快速比对
  function hash(input) {
    var u8 = toBytes(input);
    if (!u8) return { size: 0, h: '0' };
    var h = 0x811c9dc5;
    for (var i = 0; i < u8.length; i++) {
      h ^= u8[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return { size: u8.length, h: h.toString(16) };
  }

  function sameHash(a, b) {
    if (!a || !b) return false;
    return a.size === b.size && String(a.h) === String(b.h);
  }

  return {
    toBytes: toBytes,
    detectEncoding: detectEncoding,
    decode: decode,
    encode: encode,
    detectEol: detectEol,
    normalizeNewlines: normalizeNewlines,
    endsWithNewline: endsWithNewline,
    detect: detect,
    applyProfile: applyProfile,
    restoreBytes: restoreBytes,
    sameBytes: sameBytes,
    canonicalBytes: canonicalBytes,
    sameText: sameText,
    canonicalHash: canonicalHash,
    hash: hash,
    sameHash: sameHash
  };
});
