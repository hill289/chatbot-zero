/*!
 * xlsx-fs-bridge.js — 让「浏览器构建」的 xlsx 在 almostnode(VFS) 里也能用文件级 API（纯逻辑）
 * =============================================================================
 * 背景：随包附带的 node_modules/xlsx/index.js 是**浏览器构建**，内部 Node fs 句柄被置空
 *      （源码片段：`var Je; if(typeof require!=='undefined') try{Je=undefined}catch(e){}`）。
 *      因此 XLSX.readFile / readFileSync / writeFile / writeFileSync 必抛
 *      "Cannot access file …" / "cannot save file …"，只有 XLSX.read(buffer) / XLSX.write() 可用。
 *      → run_node 里 `XLSX.readFile('/home/pyodide/x.xlsx')` 这类最自然的写法全部失败。
 *
 * 修复：把 xlsx 的「文件级 API」桥接到传入的 fs（在 almostnode 里就是 fs → VFS）：
 *      · readFile/readFileSync  = 先 fs.readFileSync，再 XLSX.read(bytes, {type:'buffer'})
 *      · writeFile/writeFileSync = 先 XLSX.write(wb, {type:'buffer'})，再 fs.writeFileSync
 *      其余 opts（bookType / cellDates / sheet …）原样保留，仅把 type 强制为 buffer。
 *
 * 设计要点：
 *   · 纯函数、幂等（重复调用不会二次包裹）；给定 XLSX 与 fs 即可，便于 node 单测。
 *   · 关键：bridgeXlsxFileApi.toString() 会被整体注入 almostnode 沙箱内执行
 *     —— `(FN_SOURCE)(require('xlsx'), require('fs'))`，因此函数体**不得**引用任何外部
 *     变量，只能用它自己的两个参数 XLSX / fsModule。
 *
 * UMD：浏览器挂 globalThis.PgpyXlsxFsBridge；Node 下 module.exports（供单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PgpyXlsxFsBridge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function bridgeXlsxFileApi(XLSX, fsModule) {
    if (!XLSX || typeof XLSX.read !== 'function' || typeof XLSX.write !== 'function') return false;
    if (XLSX.__pgpyFsBridged) return true;

    XLSX.readFile = XLSX.readFileSync = function (filename, opts) {
      var o = Object.assign({}, opts, { type: 'buffer' });
      return XLSX.read(fsModule.readFileSync(filename), o);
    };
    XLSX.writeFile = XLSX.writeFileSync = function (wb, filename, opts) {
      var o = Object.assign({}, opts, { type: 'buffer' });
      fsModule.writeFileSync(filename, XLSX.write(wb, o));
    };

    try { Object.defineProperty(XLSX, '__pgpyFsBridged', { value: true, enumerable: false, configurable: true }); }
    catch (_) { XLSX.__pgpyFsBridged = true; }
    return true;
  }

  return { bridgeXlsxFileApi: bridgeXlsxFileApi };
});
