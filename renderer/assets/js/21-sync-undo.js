/*!
 * 21-sync-undo.js — ⟲ 撤销上次写回（Sync Checkpoint & Undo）
 * -----------------------------------------------------------------------------
 * 「🔁 同步」会把虚拟 FS 的改动按字节覆盖磁盘真实文件（15-pgpy-runtime.js 的
 * pgpySyncPaths）。本模块在每次同步完成时，把本轮每个文件「同步前」的字节基线
 * 打包成一个「批次（batch）」存进 IndexedDB；之后点「⟲ 撤销写回」即可把磁盘
 * 与虚拟 FS 一起回退到点同步之前的状态。
 *
 * 语义（与方案一致）：
 *   · 撤销前先弹「确认清单」，逐文件列出将「还原/移除/跳过」及原因，用户确认后才动盘；
 *   · write  项（vfs 改动覆盖了原文件） → 用同步前字节覆盖回磁盘 + 写回 vfs；
 *            同步前基线为「新文件」（null）→ 撤销 = 删除磁盘文件 + 删除 vfs 条目；
 *   · delete 项（vfs 删除 → 同步删了真实文件） → 用同步前字节重建磁盘 + 重建 vfs 条目；
 *   · create 项（新增文件被复制进真实目录）   → 删除磁盘文件 + 删除 vfs 条目；
 *   · mkdir 出来的新目录不回退（无内容、递归删除风险大）；
 *   · 撤销前用「同步后哈希（postHash）」校验磁盘现状：被外部改过的文件一律跳过，
 *     宁可不撤也不覆盖（计入「冲突」汇报）。
 *
 * 重做（方案 A，⟳ 重做写回）：
 *   · 撤销「动手那一刻」磁盘正是同步后的版本，就地抓取字节作为重做基线（post），
 *     零额外读盘；撤销成功的批次不再删除，改标 undone 保留。
 *   · 重做前用「撤销后状态哈希（preHash）」校验磁盘现状，被外部改过的文件跳过；
 *     仅对「撤销时真正执行过」的项生效（undoAction=restore|remove）。
 *   · 重做完成后批次标 redoDone 并清空 post，释放 IndexedDB 空间。
 *
 * 设计约束（与仓库一致）：
 *   1) 零构建、经典 <script> 顺序加载（本文件在 15-pgpy-runtime.js 之后加载）；
 *   2) 批次落库失败时如实提示「本次写回不可撤销」，绝不假装有保险；
 *   3) 逐项撤销、逐项标 done 落库（幂等：中途崩溃后重跑只处理未 done 项）；
 *   4) 纯逻辑（批次构造 / 回退决策 / 汇总 / 裁剪）与 DOM、IndexedDB 分离，可 node 单测。
 *
 * UMD：浏览器挂 globalThis.SyncUndo；Node 下 module.exports（供单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SyncUndo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // 一、常量与工具
  // ══════════════════════════════════════════════════════════════════

  var MAX_PRE_BYTES = 20 * 1024 * 1024; // 单文件同步前基线上限（超出 → 该项标记不可撤销）
  var MAX_BATCHES = 10;                  // 只保留最近 N 个批次
  var IDB_NAME = 'pgpy-sync-undo';
  var IDB_STORE = 'batches';

  function toBytes(data) {
    if (data == null) return null;
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    try { return new TextEncoder().encode(String(data)); } catch (_) { return null; }
  }

  function hexOf(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) {
      var h = u8[i].toString(16);
      s += h.length === 1 ? '0' + h : h;
    }
    return s;
  }

  // 内容哈希（同步前/后一致性校验用）：优先 SHA-1（crypto.subtle），
  // 无 subtle 的退化环境用 FNV-1a 32 位 + 长度（仍足以发现内容变化）。
  function sha1(bytes) {
    var u8 = toBytes(bytes);
    if (!u8) u8 = new Uint8Array(0);
    try {
      if (typeof crypto !== 'undefined' && crypto && crypto.subtle && crypto.subtle.digest) {
        var buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        return crypto.subtle.digest('SHA-1', buf).then(function (d) {
          return 'sha1:' + hexOf(new Uint8Array(d));
        }, function () { return fnv(u8); });
      }
    } catch (_) {}
    return Promise.resolve(fnv(u8));
  }

  function fnv(u8) {
    var h = 0x811c9dc5;
    for (var i = 0; i < u8.length; i++) {
      h ^= u8[i];
      h = (h * 0x01000193) >>> 0;
    }
    return 'fnv:' + h.toString(16) + ':' + u8.length;
  }

  // ══════════════════════════════════════════════════════════════════
  // 二、纯逻辑（无 DOM / 无 IndexedDB，可单测）
  // ══════════════════════════════════════════════════════════════════

  // 归一化一个撤销项：
  //   { real, vPath, kind(write|delete|create), pre, preKnown, preHash,
  //     post, postKnown, postHash, undoAction, done, undoable, redoable, redoDone }
  //   · 同步前基线（pre）超大 → 不入批次内容，仅保留标记（undoable:false），撤销时如实跳过；
  //   · delete 项没有「同步后内容」（文件已被删除）→ postHash 留空，校验逻辑按「应不存在」处理；
  //   · 重做基线（post = 同步后字节）在「撤销那一刻」就地捕获（此时磁盘正是同步后的版本），
  //     同样有 MAX_PRE_BYTES 上限，超出则标 redoable:false 不落库；
  //   · preHash 记录「撤销完成后磁盘应有的内容哈希」，作为重做前的冲突校验基线；
  //   · undoAction 记录撤销时真正执行的动作（restore|remove），重做只对真正动过的项生效。
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var real = String(raw.real || '').trim();
    var vPath = String(raw.vPath || '').trim();
    if (!real || !vPath) return null;
    var kind = raw.kind === 'delete' ? 'delete' : (raw.kind === 'create' ? 'create' : 'write');
    var pre = raw.pre == null ? null : toBytes(raw.pre);
    var preKnown = raw.preKnown !== undefined ? !!raw.preKnown : (raw.pre != null);
    var undoable = true;
    if ((kind === 'write' || kind === 'delete') && preKnown && pre && pre.length > MAX_PRE_BYTES) {
      undoable = false; // 基线太大，不落库
      pre = null;
    }
    var post = raw.post == null ? null : toBytes(raw.post);
    var postKnown = raw.postKnown !== undefined ? !!raw.postKnown : (raw.post != null);
    var redoable = true;
    if (post && post.length > MAX_PRE_BYTES) {
      redoable = false; // 重做基线太大，不落库
      post = null;
      postKnown = false;
    }
    return {
      real: real,
      vPath: vPath,
      kind: kind,
      pre: pre,
      preKnown: preKnown,
      preHash: raw.preHash || null,
      post: post,
      postKnown: postKnown,
      postHash: raw.postHash || null,
      undoAction: (raw.undoAction === 'restore' || raw.undoAction === 'remove') ? raw.undoAction : null,
      done: !!raw.done,
      undoable: undoable,
      redoable: redoable,
      redoDone: !!raw.redoDone
    };
  }

  // 造一个撤销项（异步算「同步后」哈希）：postBytes 为本次写回磁盘的字节；
  // delete 项 postBytes 为空 → postHash = null（撤销时校验磁盘「应不存在」）。
  function makeItem(raw) {
    var item = normalizeItem(raw);
    if (!item) return Promise.resolve(null);
    if (raw && raw.postBytes != null) {
      var pb = toBytes(raw.postBytes);
      if (pb) return sha1(pb).then(function (h) { item.postHash = h; return item; });
    }
    return Promise.resolve(item);
  }

  // 把一轮同步的全部撤销项打包成一个批次
  function buildBatch(items, note, now) {
    var list = (Array.isArray(items) ? items : []).filter(Boolean);
    var ts = typeof now === 'number' ? now : Date.now();
    return { batchId: ts, at: ts, note: String(note || ''), items: list };
  }

  // 回退决策：根据「项的类型 + 磁盘现状（是否存在 + 内容哈希）」决定动作。
  //   restore = 用同步前基线回写磁盘/vfs；remove = 删除（撤销新增）；skip = 不动。
  function planItemAction(item, diskState) {
    if (!item) return { action: 'skip', reason: 'invalid' };
    var disk = diskState || {};
    var exists = !!disk.exists;
    var hash = disk.hash || null;
    if (item.kind === 'create') {
      if (!exists) return { action: 'skip', reason: 'already-absent' };
      if (item.postHash && hash && hash !== item.postHash) return { action: 'skip', reason: 'external-modified' };
      return { action: 'remove' };
    }
    if (item.kind === 'delete') {
      // 同步把文件删了；现在磁盘上又有文件 → 被外部重建过，不覆盖
      if (exists) return { action: 'skip', reason: 'external-recreated' };
      return { action: 'restore' };
    }
    // write：磁盘内容 = 同步后内容（或文件已不在）才允许回退；被外部改过 → 跳过
    if (exists && item.postHash && hash && hash !== item.postHash) return { action: 'skip', reason: 'external-modified' };
    return { action: 'restore' };
  }

  // 汇总撤销结果：{ restored, removed, skipped, conflicts, oversized, errors }
  function summarizeUndo(results) {
    var s = { restored: 0, removed: 0, skipped: 0, conflicts: 0, oversized: 0, errors: 0 };
    var list = Array.isArray(results) ? results : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r) continue;
      if (r.action === 'restore') s.restored++;
      else if (r.action === 'remove') s.removed++;
      else if (r.action === 'error') s.errors++;
      else if (r.action === 'skip' || r.action === 'done-skip') {
        s.skipped++;
        if (r.reason === 'external-modified' || r.reason === 'external-recreated') s.conflicts++;
        if (r.reason === 'oversized') s.oversized++;
      }
    }
    return s;
  }

  // 重做回退决策：撤销完成后磁盘应与「撤销留下的结果」一致（用 preHash 校验），
  // 不一致视为被外部改动 → 跳过，绝不覆盖。
  //   · 只对「撤销时真正执行过的项」生效（undoAction = restore|remove）；
  //   · write / create → reapply-write（写回同步后字节 post）；delete → reapply-delete（再删一次）；
  //   · 重做基线缺失/超大 → skip(no-post-baseline)，不冒险。
  function planRedoAction(item, diskState) {
    if (!item) return { action: 'skip', reason: 'invalid' };
    var disk = diskState || {};
    var exists = !!disk.exists;
    var hash = disk.hash || null;
    if (item.redoDone) return { action: 'skip', reason: 'already-redone' };
    if (item.undoAction !== 'restore' && item.undoAction !== 'remove') return { action: 'skip', reason: 'not-undone' };
    if (item.kind === 'delete') {
      // 撤销时重建了文件；重做 = 再删一次。要求文件仍在且内容仍是撤销时写回的 pre
      if (!exists) return { action: 'skip', reason: 'external-modified' };
      if (item.preHash && hash && hash !== item.preHash) return { action: 'skip', reason: 'external-modified' };
      return { action: 'reapply-delete' };
    }
    // write / create → 重做 = 写回同步后字节（post）
    if (item.postKnown === false || !item.post) return { action: 'skip', reason: 'no-post-baseline' };
    if (item.undoAction === 'restore') {
      // 撤销把 pre 写回了磁盘：现在磁盘应存在且等于 pre
      if (!exists) return { action: 'skip', reason: 'external-modified' };
      if (item.preHash && hash && hash !== item.preHash) return { action: 'skip', reason: 'external-modified' };
    } else { // undoAction === 'remove'：撤销把文件删了，现在应不存在
      if (exists) return { action: 'skip', reason: 'external-recreated' };
    }
    return { action: 'reapply-write' };
  }

  // 汇总重做结果：{ restored, removed, skipped, conflicts, noBaseline, errors }
  function summarizeRedo(results) {
    var s = { restored: 0, removed: 0, skipped: 0, conflicts: 0, noBaseline: 0, errors: 0 };
    var list = Array.isArray(results) ? results : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r) continue;
      if (r.action === 'reapply-write') s.restored++;
      else if (r.action === 'reapply-delete') s.removed++;
      else if (r.action === 'error') s.errors++;
      else if (r.action === 'skip' || r.action === 'done-skip') {
        s.skipped++;
        if (r.reason === 'external-modified' || r.reason === 'external-recreated') s.conflicts++;
        if (r.reason === 'no-post-baseline') s.noBaseline++;
      }
    }
    return s;
  }

  // 裁剪批次：保留最近 max 个（batchId 降序），返回 { keep, drop }
  function trimBatches(batches, max) {
    var list = (Array.isArray(batches) ? batches : []).slice();
    list.sort(function (a, b) { return ((b && b.batchId) || 0) - ((a && a.batchId) || 0); });
    var n = typeof max === 'number' ? max : MAX_BATCHES;
    return { keep: list.slice(0, n), drop: list.slice(n) };
  }

  // 批次的人读描述：「写回 3 个，新增 1 个」
  function describeBatch(batch) {
    if (!batch || !Array.isArray(batch.items)) return '';
    var w = 0, d = 0, c = 0;
    for (var i = 0; i < batch.items.length; i++) {
      var it = batch.items[i];
      if (!it) continue;
      if (it.kind === 'create') c++;
      else if (it.kind === 'delete') d++;
      else w++;
    }
    var parts = [];
    if (w > 0) parts.push('写回 ' + w + ' 个');
    if (d > 0) parts.push('删除 ' + d + ' 个');
    if (c > 0) parts.push('新增 ' + c + ' 个');
    return parts.join('，');
  }

  // ══════════════════════════════════════════════════════════════════
  // 三、批次存储（IndexedDB；不可用时抛错 → 调用方如实降级）
  // ══════════════════════════════════════════════════════════════════

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        var req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'batchId' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      } catch (_) { resolve(null); }
    });
    return dbPromise;
  }

  function idbAll() {
    return openDb().then(function (db) {
      if (!db) return [];
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readonly');
          var r = tx.objectStore(IDB_STORE).getAll();
          r.onsuccess = function () { resolve(Array.isArray(r.result) ? r.result : []); };
          r.onerror = function () { resolve([]); };
        } catch (_) { resolve([]); }
      });
    });
  }

  function idbPut(batch) {
    return openDb().then(function (db) {
      if (!db) throw new Error('IndexedDB 不可用');
      return new Promise(function (resolve, rej) {
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(batch);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { rej(tx.error); };
        } catch (e) { rej(e); }
      });
    });
  }

  function idbDelete(batchId) {
    return openDb().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(batchId);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (_) { resolve(); }
      });
    });
  }

  // 存一个批次（含裁剪：只留最近 MAX_BATCHES 个）
  function saveBatch(batch) {
    if (!batch || typeof batch !== 'object' || !batch.batchId) {
      return Promise.reject(new Error('无效批次'));
    }
    return idbPut(batch).then(function () {
      return idbAll();
    }).then(function (all) {
      var t = trimBatches(all, MAX_BATCHES);
      var drops = (t.drop || []).map(function (b) { return b.batchId; });
      if (drops.length === 0) return batch;
      var p = Promise.resolve();
      for (var i = 0; i < drops.length; i++) {
        (function (id) { p = p.then(function () { return idbDelete(id); }); })(drops[i]);
      }
      return p.then(function () { return batch; });
    });
  }

  // 最近一个批次（未撤销完的最新批次；全部撤销后会被删除）
  function lastBatch() {
    return idbAll().then(function (all) {
      var t = trimBatches(all, MAX_BATCHES);
      return (t.keep && t.keep[0]) || null;
    });
  }

  // 最近一个「还能撤销」的批次：尚未标记 undone 的最新批次
  function lastUndoBatch() {
    return idbAll().then(function (all) {
      var t = trimBatches(all, MAX_BATCHES);
      var list = t.keep || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && !list[i].undone) return list[i];
      }
      return null;
    });
  }

  // 最近一个「可以重做」的批次：已撤销（undone）且尚未重做（!redoDone）的最新批次
  function lastRedoBatch() {
    return idbAll().then(function (all) {
      var t = trimBatches(all, MAX_BATCHES);
      var list = t.keep || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].undone && !list[i].redoDone) return list[i];
      }
      return null;
    });
  }

  function listBatches() {
    return idbAll().then(function (all) {
      var t = trimBatches(all, MAX_BATCHES);
      return t.keep || [];
    });
  }

  function removeBatch(batchId) {
    return idbDelete(batchId);
  }

  var api = {
    MAX_PRE_BYTES: MAX_PRE_BYTES,
    MAX_BATCHES: MAX_BATCHES,
    toBytes: toBytes,
    sha1: sha1,
    normalizeItem: normalizeItem,
    makeItem: makeItem,
    buildBatch: buildBatch,
    planItemAction: planItemAction,
    planRedoAction: planRedoAction,
    summarizeUndo: summarizeUndo,
    summarizeRedo: summarizeRedo,
    trimBatches: trimBatches,
    describeBatch: describeBatch,
    saveBatch: saveBatch,
    lastBatch: lastBatch,
    lastUndoBatch: lastUndoBatch,
    lastRedoBatch: lastRedoBatch,
    listBatches: listBatches,
    removeBatch: removeBatch,
    __pure: {
      toBytes: toBytes,
      normalizeItem: normalizeItem,
      buildBatch: buildBatch,
      planItemAction: planItemAction,
      planRedoAction: planRedoAction,
      summarizeUndo: summarizeUndo,
      summarizeRedo: summarizeRedo,
      trimBatches: trimBatches,
      describeBatch: describeBatch,
      MAX_PRE_BYTES: MAX_PRE_BYTES,
      MAX_BATCHES: MAX_BATCHES
    }
  };

  // ══════════════════════════════════════════════════════════════════
  // 四、浏览器编排（DOM / vfs / fileAPI；仅浏览器环境挂载全局函数）
  // ══════════════════════════════════════════════════════════════════
  if (root && typeof document !== 'undefined') {

    // 15-pgpy-runtime.js 的全局符号（经典 script 的全局词法作用域，可直接引用；
    // 任何一项缺失都静默降级，不影响主程序）
    function fsObj() {
      try { return (typeof nodeRuntime !== 'undefined' && nodeRuntime && nodeRuntime.FS) ? nodeRuntime.FS : null; }
      catch (_) { return null; }
    }
    function fsExists(p) {
      var FS = fsObj();
      if (!FS) return false;
      try { FS.stat(p); return true; } catch (_) { return false; }
    }
    function fsWriteFile(p, bytes) {
      var FS = fsObj();
      if (!FS) return;
      var segs = String(p).split('/');
      segs.pop();
      var dir = '';
      for (var i = 0; i < segs.length; i++) {
        if (!segs[i]) continue;
        dir += '/' + segs[i];
        try { if (FS.mkdirTree) FS.mkdirTree(dir); } catch (_) {}
      }
      FS.writeFile(p, new Uint8Array(bytes));
    }
    function fsUnlink(p) {
      var FS = fsObj();
      if (!FS) return;
      FS.unlink(p);
    }
    function notifyOk(msg) {
      try { if (typeof snackbarStore !== 'undefined' && snackbarStore.showSuccessMessage) { snackbarStore.showSuccessMessage(msg); return; } } catch (_) {}
      try { var st = document.getElementById('pgpyStatus'); if (st) { st.className = 'pgpy-status-badge pgpy-success'; st.textContent = msg; } } catch (_) {}
    }
    function notifyErr(msg) {
      try { if (typeof snackbarStore !== 'undefined' && snackbarStore.showErrorMessage) { snackbarStore.showErrorMessage(msg); return; } } catch (_) {}
      try { var st = document.getElementById('pgpyStatus'); if (st) { st.className = 'pgpy-status-badge pgpy-error'; st.textContent = msg; } } catch (_) {}
    }

    // ── 动作 → 人读标签（用于确认清单）──
    function pgpyActionMeta(action, reason) {
      switch (action) {
        case 'restore': return { label: '↩ 还原旧版', style: 'color:#2563eb;font-weight:600;' };
        case 'remove': return { label: '🗑 移除文件', style: 'color:#dc2626;font-weight:600;' };
        case 'reapply-write': return { label: '⟳ 恢复最新版', style: 'color:#2563eb;font-weight:600;' };
        case 'reapply-delete': return { label: '⟳ 再次删除', style: 'color:#dc2626;font-weight:600;' };
        default:
          if (reason === 'oversized') return { label: '⚠ 跳过（过大未备份）', style: 'color:#b45309;' };
          if (reason === 'external-modified') return { label: '⚠ 跳过（外部已修改）', style: 'color:#b45309;' };
          if (reason === 'external-recreated') return { label: '⚠ 跳过（已被外部重建）', style: 'color:#b45309;' };
          if (reason === 'no-post-baseline') return { label: '⚠ 跳过（无重做基线）', style: 'color:#b45309;' };
          if (reason === 'already-absent' || reason === 'already-redone') return { label: '✓ 跳过（无需处理）', style: 'color:#059669;' };
          if (reason === 'done') return { label: '✓ 已处理', style: 'color:#6b7280;' };
          if (reason === 'not-undone') return { label: '— 未撤销过', style: 'color:#9ca3af;' };
          return { label: '跳过', style: 'color:#6b7280;' };
      }
    }

    // ── 通用确认清单（就地构建 DOM，纯文本写入，避免文件名注入）──
    //   opt = { title, subtitle, rows:[{name, real, label, style}], confirmText, confirmStyle }
    //   返回 Promise<boolean>：确认 true / 取消 false
    function pgpyShowSyncConfirm(opt) {
      return new Promise(function (resolve) {
        var o = opt || {};
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay open';
        overlay.style.cssText = 'z-index:10000;align-items:center;justify-content:center;';

        var card = document.createElement('div');
        card.className = 'modal-card';
        card.style.cssText = 'width:640px;max-width:92vw;background:#fff;border-radius:8px;' +
          'box-shadow:0 12px 40px rgba(0,0,0,.35);overflow:hidden;animation:modalIn .18s ease;';

        var head = document.createElement('div');
        head.style.cssText = 'padding:16px 18px 8px;';
        var h = document.createElement('div');
        h.textContent = o.title || '';
        h.style.cssText = 'font-size:16px;font-weight:700;color:#111827;';
        var sub = document.createElement('div');
        sub.textContent = o.subtitle || '';
        sub.style.cssText = 'margin-top:6px;font-size:12.5px;line-height:1.5;color:#6b7280;';
        head.appendChild(h); head.appendChild(sub);

        var list = document.createElement('div');
        list.style.cssText = 'max-height:44vh;overflow:auto;border-top:1px solid #eef0f3;border-bottom:1px solid #eef0f3;margin-top:6px;';
        var rows = Array.isArray(o.rows) ? o.rows : [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i] || {};
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px 18px;border-bottom:1px solid #f3f4f6;font-size:13px;';
          var nameEl = document.createElement('div');
          nameEl.textContent = r.name || '';
          nameEl.title = r.real || r.name || '';
          nameEl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
            'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#374151;';
          var actEl = document.createElement('div');
          actEl.textContent = r.label || '';
          actEl.style.cssText = 'flex:none;font-size:12px;white-space:nowrap;' + (r.style || '');
          row.appendChild(nameEl); row.appendChild(actEl); list.appendChild(row);
        }

        var foot = document.createElement('div');
        foot.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;';
        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:1px solid #d1d5db;background:#fff;color:#374151;font-size:13px;cursor:pointer;';
        var okBtn = document.createElement('button');
        okBtn.textContent = o.confirmText || '确认';
        okBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:none;color:#fff;font-size:13px;cursor:pointer;' +
          (o.confirmStyle || 'background:#2563eb;');
        foot.appendChild(cancelBtn); foot.appendChild(okBtn);

        card.appendChild(head); card.appendChild(list); card.appendChild(foot);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        var done = false;
        function finish(val) {
          if (done) return;
          done = true;
          try { overlay.remove(); } catch (_) {}
          try { document.removeEventListener('keydown', onKey, true); } catch (_) {}
          resolve(val);
        }
        function onKey(e) {
          if (e.key === 'Escape') { e.preventDefault(); finish(false); }
          else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        }
        cancelBtn.addEventListener('click', function () { finish(false); });
        okBtn.addEventListener('click', function () { finish(true); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) finish(false); });
        try { document.addEventListener('keydown', onKey, true); } catch (_) {}
        try { okBtn.focus(); } catch (_) {}
      });
    }

    // ── 预览：算出每个文件在本次撤销中会被怎么处理（读盘算哈希，与真实执行一致）──
    async function pgpyPreviewUndo(batch) {
      var rows = [];
      var items = (batch && Array.isArray(batch.items)) ? batch.items : [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item) continue;
        var base = { name: item.vPath || item.real, real: item.real };
        if (item.done) { rows.push(Object.assign(base, { action: 'done-skip', reason: 'done' })); continue; }
        if (item.undoable === false) { rows.push(Object.assign(base, { action: 'skip', reason: 'oversized' })); continue; }
        var disk = { exists: false, hash: null };
        try {
          var cur = api.toBytes(await root.fileAPI.read(item.real));
          if (cur) { disk.exists = true; disk.hash = await sha1(cur); }
        } catch (_) { disk.exists = false; }
        var plan = planItemAction(item, disk);
        rows.push(Object.assign(base, { action: plan.action, reason: plan.reason }));
      }
      return rows;
    }

    async function pgpyPreviewRedo(batch) {
      var rows = [];
      var items = (batch && Array.isArray(batch.items)) ? batch.items : [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item) continue;
        var base = { name: item.vPath || item.real, real: item.real };
        if (item.redoDone) { rows.push(Object.assign(base, { action: 'done-skip', reason: 'done' })); continue; }
        var disk = { exists: false, hash: null };
        try {
          var cur = api.toBytes(await root.fileAPI.read(item.real));
          if (cur) { disk.exists = true; disk.hash = await sha1(cur); }
        } catch (_) { disk.exists = false; }
        var plan = planRedoAction(item, disk);
        rows.push(Object.assign(base, { action: plan.action, reason: plan.reason }));
      }
      return rows;
    }

    function pgpyToConfirmRows(preview) {
      return preview.map(function (p) {
        var m = pgpyActionMeta(p.action, p.reason);
        return { name: p.name, real: p.real, label: m.label, style: m.style };
      });
    }

    // 刷新「⟲ 撤销写回」按钮可用性与提示
    function pgpyRefreshUndoButton() {
      var btn = null;
      try { btn = document.getElementById('pgpyUndoSyncBtn'); } catch (_) {}
      if (btn) {
        lastUndoBatch().then(function (b) {
          btn.disabled = !b;
          btn.title = b
            ? ('撤销上次写回：' + (b.note || describeBatch(b)) + '（' + new Date(b.at).toLocaleString() + '）')
            : '没有可撤销的写回批次';
        }).catch(function () { btn.disabled = true; });
      }
      pgpyRefreshRedoButton();
    }
    root.pgpyRefreshUndoButton = pgpyRefreshUndoButton;

    // 刷新「⟳ 重做写回」按钮可用性与提示
    function pgpyRefreshRedoButton() {
      var btn = null;
      try { btn = document.getElementById('pgpyRedoSyncBtn'); } catch (_) {}
      if (!btn) return;
      lastRedoBatch().then(function (b) {
        btn.disabled = !b;
        btn.title = b
          ? ('重做上次写回：' + (b.note || describeBatch(b)) + '（撤销于 ' + new Date(b.undoneAt || b.at).toLocaleString() + '）')
          : '没有可重做的写回批次';
      }).catch(function () { btn.disabled = true; });
    }
    root.pgpyRefreshRedoButton = pgpyRefreshRedoButton;

    // 撤销最近一次写回批次：磁盘与虚拟 FS 一起回退到「点同步之前」
    async function pgpyUndoLastSync() {
      if (!root.fileAPI) { notifyErr('当前环境不支持写回磁盘（请在 Electron 应用中打开）。'); return; }
      var batch = null;
      try { batch = await lastUndoBatch(); } catch (_) { batch = null; }
      if (!batch) { notifyOk('没有可撤销的写回批次'); return; }

      // ① 确认清单：先读盘推演每个文件的处理方式，让用户看清再动手
      var preview = await pgpyPreviewUndo(batch);
      var actionable = preview.filter(function (p) { return p.action === 'restore' || p.action === 'remove'; }).length;
      var skipped = preview.length - actionable;
      if (actionable === 0) { notifyOk('没有文件需要回退' + (skipped ? '（' + skipped + ' 个已跳过）' : '')); return; }
      var go = await pgpyShowSyncConfirm({
        title: '⟲ 撤销上次写回',
        subtitle: '将把下列真实磁盘文件回退到「点同步之前」，操作会立即改写磁盘：' +
          (skipped ? '（另有 ' + skipped + ' 个文件将跳过）' : ''),
        rows: pgpyToConfirmRows(preview),
        confirmText: '确认撤销（' + actionable + ' 个文件）',
        confirmStyle: 'background:#dc2626;'
      });
      if (!go) { notifyOk('已取消撤销'); return; }

      // ② 执行撤销（重新读盘校验，防止预览后磁盘又变）
      var results = [];
      var items = Array.isArray(batch.items) ? batch.items : [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item) continue;
        if (item.done) { results.push({ item: item, action: 'done-skip', reason: 'done' }); continue; }
        if (item.undoable === false) { results.push({ item: item, action: 'skip', reason: 'oversized' }); continue; }

        // 磁盘现状：读得到 → 存在（顺便算哈希）；读失败 → 视为不存在
        var disk = { exists: false, hash: null };
        var cur = null;
        try {
          cur = api.toBytes(await root.fileAPI.read(item.real));
          if (cur) { disk.exists = true; disk.hash = await sha1(cur); }
        } catch (_) { disk.exists = false; }

        var plan = planItemAction(item, disk);
        if (plan.action === 'skip') { results.push({ item: item, action: 'skip', reason: plan.reason }); continue; }

        try {
          // 撤销前先抓「同步后」字节作为重做基线（此刻磁盘正是同步后的版本，零额外读盘）
          var postBytes = null, postKnown = false;
          if (disk.exists && cur && cur.length <= MAX_PRE_BYTES) { postBytes = new Uint8Array(cur); postKnown = true; }
          // 同步前无基线（pre=null）的 write → 撤销实为删除
          var effAction = (plan.action === 'restore' && !item.pre) ? 'remove' : plan.action;
          var preHash = (effAction === 'restore' && item.pre) ? await sha1(item.pre) : null;

          if (effAction === 'remove') {
            // 撤销「新增」/ 撤销「同步前不存在」：删磁盘文件 + 删 vfs 条目
            await root.fileAPI.remove(item.real);
            try { if (fsExists(item.vPath)) fsUnlink(item.vPath); } catch (_) {}
          } else {
            // restore：用同步前基线回写磁盘 + 写回 vfs
            await root.fileAPI.writeBytes(item.real, item.pre);
            try { fsWriteFile(item.vPath, item.pre); } catch (_) {}
            // delete 项撤销后真实路径映射已被删过，需重建（否则后续同步解析不到）
            try { if (typeof pgpySetRealPath === 'function') pgpySetRealPath(item.vPath, item.real); } catch (_) {}
          }
          // 回退后磁盘 = vfs = 原版：清掉过期基线与待同步标记，让对比/待同步状态归零
          try { if (typeof pgpyBaselineDelete === 'function') await pgpyBaselineDelete([item.vPath]); } catch (_) {}
          try {
            if (typeof pgpyPendingSync !== 'undefined' && pgpyPendingSync && pgpyPendingSync[item.real]) {
              delete pgpyPendingSync[item.real];
              if (typeof pgpySavePendingSync === 'function') pgpySavePendingSync();
            }
          } catch (_) {}

          // 记录重做基线 + 撤销后状态（仅成功后才落标记，保证重做只作用于真正动过的项）
          item.post = postBytes; item.postKnown = postKnown;
          item.preHash = preHash; item.undoAction = effAction;
          item.redoDone = false; item.done = true;
          results.push({ item: item, action: effAction });
          try { await saveBatch(batch); } catch (_) {} // 幂等进度落库：中途崩溃后重跑只处理未 done 项
        } catch (err) {
          results.push({ item: item, action: 'error', reason: String((err && err.message) || err) });
        }
      }

      var hasError = false, changed = false;
      for (var j = 0; j < results.length; j++) {
        if (!results[j]) continue;
        if (results[j].action === 'error') hasError = true;
        if (results[j].action === 'restore' || results[j].action === 'remove') changed = true;
      }
      // 有实际回退 → 批次标 undone 保留（作为重做素材）；未动任何文件且无错 → 删除空批次；有错则留待重试
      if (changed) { batch.undone = true; batch.undoneAt = Date.now(); try { await saveBatch(batch); } catch (_) {} }
      else if (!hasError) { try { await removeBatch(batch.batchId); } catch (_) {} }

      var s = summarizeUndo(results);
      var notes = [];
      if (s.restored > 0) notes.push('还原 ' + s.restored + ' 个');
      if (s.removed > 0) notes.push('移除 ' + s.removed + ' 个');
      var tail = [];
      if (s.conflicts > 0) tail.push(s.conflicts + ' 个因外部修改跳过');
      if (s.oversized > 0) tail.push(s.oversized + ' 个文件过大未备份');
      if (s.errors > 0) tail.push(s.errors + ' 个失败');
      var msg = '↩️ 已撤销上次写回' + (notes.length ? '（' + notes.join('，') + '）' : '（无文件需要还原）')
        + (tail.length ? '：' + tail.join('，') : '')
        + (changed ? ' · 可点 ⟳ 重做恢复' : '');
      if (s.errors > 0) notifyErr(msg); else notifyOk(msg);

      // 刷新 UI 状态
      try { pgpyUpdateSyncButton(); } catch (_) {}
      try { if (fsObj() && typeof listNodeFiles === 'function') listNodeFiles(); } catch (_) {}
      pgpyRefreshUndoButton();
    }
    root.pgpyUndoLastSync = pgpyUndoLastSync;

    // 重做上次写回：把磁盘与虚拟 FS 恢复为「撤销前的最新版本」（方案 A）
    async function pgpyRedoSync() {
      if (!root.fileAPI) { notifyErr('当前环境不支持写回磁盘（请在 Electron 应用中打开）。'); return; }
      var batch = null;
      try { batch = await lastRedoBatch(); } catch (_) { batch = null; }
      if (!batch) { notifyOk('没有可重做的写回批次'); return; }

      // ① 确认清单
      var preview = await pgpyPreviewRedo(batch);
      var actionable = preview.filter(function (p) { return p.action === 'reapply-write' || p.action === 'reapply-delete'; }).length;
      var skipped = preview.length - actionable;
      if (actionable === 0) { notifyOk('没有文件需要重做' + (skipped ? '（' + skipped + ' 个已跳过）' : '')); return; }
      var go = await pgpyShowSyncConfirm({
        title: '⟳ 重做上次写回',
        subtitle: '将把下列真实磁盘文件恢复为「撤销前的最新版本」，操作会立即改写磁盘：' +
          (skipped ? '（另有 ' + skipped + ' 个文件将跳过）' : ''),
        rows: pgpyToConfirmRows(preview),
        confirmText: '确认重做（' + actionable + ' 个文件）',
        confirmStyle: 'background:#2563eb;'
      });
      if (!go) { notifyOk('已取消重做'); return; }

      // ② 执行重做（重新读盘校验，防止预览后磁盘又变）
      var results = [];
      var items = Array.isArray(batch.items) ? batch.items : [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item) continue;
        if (item.redoDone) { results.push({ item: item, action: 'done-skip', reason: 'done' }); continue; }
        var disk = { exists: false, hash: null };
        try {
          var cur = api.toBytes(await root.fileAPI.read(item.real));
          if (cur) { disk.exists = true; disk.hash = await sha1(cur); }
        } catch (_) { disk.exists = false; }
        var plan = planRedoAction(item, disk);
        if (plan.action === 'skip') { results.push({ item: item, action: 'skip', reason: plan.reason }); continue; }
        try {
          if (plan.action === 'reapply-write') {
            await root.fileAPI.writeBytes(item.real, item.post);
            try { fsWriteFile(item.vPath, item.post); } catch (_) {}
            try { if (typeof pgpySetRealPath === 'function') pgpySetRealPath(item.vPath, item.real); } catch (_) {}
          } else { // reapply-delete
            await root.fileAPI.remove(item.real);
            try { if (fsExists(item.vPath)) fsUnlink(item.vPath); } catch (_) {}
          }
          // 重做后磁盘 = 同步后内容：清理基线/待同步标记，与撤销时保持一致
          try { if (typeof pgpyBaselineDelete === 'function') await pgpyBaselineDelete([item.vPath]); } catch (_) {}
          try {
            if (typeof pgpyPendingSync !== 'undefined' && pgpyPendingSync && pgpyPendingSync[item.real]) {
              delete pgpyPendingSync[item.real];
              if (typeof pgpySavePendingSync === 'function') pgpySavePendingSync();
            }
          } catch (_) {}
          item.redoDone = true;
          results.push({ item: item, action: plan.action });
          try { await saveBatch(batch); } catch (_) {}
        } catch (err) {
          results.push({ item: item, action: 'error', reason: String((err && err.message) || err) });
        }
      }

      var hasError = false;
      for (var j = 0; j < results.length; j++) { if (results[j] && results[j].action === 'error') { hasError = true; break; } }
      if (!hasError) {
        // 重做完成：批次标记 redoDone，并清空重做基线释放 IndexedDB 空间
        batch.redoDone = true; batch.redoDoneAt = Date.now();
        for (var k = 0; k < items.length; k++) { if (items[k]) { items[k].post = null; items[k].postKnown = false; } }
        try { await saveBatch(batch); } catch (_) {}
      }

      var s = summarizeRedo(results);
      var notes = [];
      if (s.restored > 0) notes.push('恢复最新版 ' + s.restored + ' 个');
      if (s.removed > 0) notes.push('再次删除 ' + s.removed + ' 个');
      var tail = [];
      if (s.conflicts > 0) tail.push(s.conflicts + ' 个因外部修改跳过');
      if (s.noBaseline > 0) tail.push(s.noBaseline + ' 个无重做基线');
      if (s.errors > 0) tail.push(s.errors + ' 个失败');
      var msg = '⟳ 已重做上次写回' + (notes.length ? '（' + notes.join('，') + '）' : '（无文件需要恢复）')
        + (tail.length ? '：' + tail.join('，') : '');
      if (s.errors > 0) notifyErr(msg); else notifyOk(msg);

      try { pgpyUpdateSyncButton(); } catch (_) {}
      try { if (fsObj() && typeof listNodeFiles === 'function') listNodeFiles(); } catch (_) {}
      pgpyRefreshUndoButton();
    }
    root.pgpyRedoSync = pgpyRedoSync;

    // 启动时刷新按钮状态（脚本在 body 内加载，DOM 已就绪）
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { pgpyRefreshUndoButton(); });
      } else {
        pgpyRefreshUndoButton();
      }
    } catch (_) {}
  }

  return api;
});
