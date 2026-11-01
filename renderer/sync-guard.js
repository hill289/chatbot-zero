/*!
 * sync-guard.js — 写回前的磁盘状态判定（纯逻辑）
 * =============================================================================
 * 把「这块磁盘内容还是不是我们开始改之前的样子」这件事从 UI/IO 里剥出来，
 * 只做判断、不碰文件系统，便于单测（见 sync-guard.test.js）。
 *
 * 判定顺序（先准后粗）：
 *   1) 有「改动前基线」→ 逐字节比较，最准，不受哈希碰撞影响；
 *   2) 只有指纹（大小 + FNV-1a）→ 指纹相同视为未变；
 *   3) 两者都没有 → unknown（放行，但不等于「校验通过」）。
 *
 * UMD：浏览器挂 globalThis.SyncGuard；Node 下 module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SyncGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SAME = 'same';
  var CHANGED = 'changed';
  var MISSING = 'missing';
  var UNKNOWN = 'unknown';

  function defaultEol() {
    if (typeof EolMeta !== 'undefined' && EolMeta) return EolMeta;
    try { return require('./eol-meta.js'); } catch (_) { return null; }
  }

  function toBytes(x) {
    if (x == null) return null;
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
    return null;
  }

  /**
   * @param {object} o
   * @param {boolean} o.diskExists 磁盘上还有这个文件吗（stat 成功且是文件）
   * @param {*} o.diskBytes        磁盘当前字节（读不到给 null）
   * @param {*} [o.refBytes]       改动前基线字节（没有给 null）
   * @param {object} [o.fp]        拖入时记录的指纹 { size, h }
   * @param {object} [o.Eol]       注入 EolMeta（便于测试；默认取全局/require）
   * @returns {{ state: string, reason: string }}
   */
  function decide(o) {
    o = o || {};
    var Eol = o.Eol || defaultEol();
    if (o.diskExists === false) return { state: MISSING, reason: 'disk-missing' };

    var disk = toBytes(o.diskBytes);
    if (!disk) return { state: UNKNOWN, reason: 'disk-unreadable' };

    var ref = toBytes(o.refBytes);
    if (ref && Eol && Eol.sameBytes) {
      // 先逐字节比（最严格）；不等再比「忽略换行风格」的规范化内容——
      // 基线取自虚拟 FS（AI 写的是 LF），磁盘原文件可能是 CRLF，
      // 这种差异不是「磁盘被改过」，不能误报冲突。
      if (Eol.sameBytes(disk, ref)) return { state: SAME, reason: 'baseline-bytes-equal' };
      if (Eol.sameText && Eol.sameText(disk, ref)) return { state: SAME, reason: 'baseline-text-equal' };
      return { state: CHANGED, reason: 'baseline-bytes-differ' };
    }

    if (o.fp && Eol && Eol.hash) {
      var cur = (Eol.canonicalHash || Eol.hash)(disk);
      return (cur.h === o.fp.h && cur.size === o.fp.size)
        ? { state: SAME, reason: 'fingerprint-equal' }
        : { state: CHANGED, reason: 'fingerprint-differ' };
    }

    return { state: UNKNOWN, reason: 'no-baseline-no-fingerprint' };
  }

  // 需要用户确认才能覆盖的状态
  function needsConfirm(state) { return state === CHANGED; }

  // 可以安全写回（含「磁盘上没了，写回等于重建」与「无从判断，放行」）
  function allowsWrite(state) { return state !== CHANGED; }

  return {
    SAME: SAME, CHANGED: CHANGED, MISSING: MISSING, UNKNOWN: UNKNOWN,
    decide: decide,
    needsConfirm: needsConfirm,
    allowsWrite: allowsWrite
  };
});
