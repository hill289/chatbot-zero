/*!
 * 32-prompt-queue.js — 前台输入队列（Super-agent 模块 4 · 全双工）
 * =============================================================================
 * 对齐优化方案 4.1「输入队列（全双工）」：把 generating 从「硬互斥」改为
 * 「忙时入队」，新用户输入在**当前推理步结束后**即被处理（不必等后台工具完成）。
 * 本文件只做队列数据结构（FIFO + 容量上限 + 排空），纯逻辑、可 Node 单测；
 * 何时入队/排空由 09-chat-store 决定（受开关控制，默认保持同步行为）。
 *
 * UMD：浏览器挂 globalThis.PromptQueue / Node 下 module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PromptQueue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createPromptQueue(opts) {
    opts = opts || {};
    var max = (typeof opts.max === 'number' && opts.max > 0) ? opts.max : 100;
    var now = (typeof opts.now === 'function') ? opts.now : function () { return Date.now(); };
    var seq = 0;
    var items = [];

    function enqueue(item) {
      var rec = { id: ++seq, item: item, at: now() };
      items.push(rec);
      var dropped = null;
      while (items.length > max) dropped = items.shift(); // 超容丢最旧
      return { id: rec.id, dropped: dropped ? dropped.item : null, size: items.length };
    }

    function dequeue() {
      var rec = items.shift();
      return rec ? rec.item : undefined;
    }
    function peek() { return items.length ? items[0].item : undefined; }
    function drain() { var out = items.map(function (r) { return r.item; }); items = []; return out; }
    function clear() { items = []; }
    function size() { return items.length; }
    function isEmpty() { return items.length === 0; }
    function list() { return items.map(function (r) { return { id: r.id, item: r.item, at: r.at }; }); }

    return { enqueue: enqueue, dequeue: dequeue, peek: peek, drain: drain, clear: clear, size: size, isEmpty: isEmpty, list: list, max: max };
  }

  return { createPromptQueue: createPromptQueue };
});
