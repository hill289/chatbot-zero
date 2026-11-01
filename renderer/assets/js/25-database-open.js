/* ══════════════════════════════════════════════════════════════════════
 *  内嵌 PostgreSQL：从工作台打开数据库视图（新标签页，自动连接，无端口）。
 *  index.html 顶部「🐘 PostgreSQL」按钮的 onclick 指向 openPostgresDatabase()。
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  function openPostgresDatabase() {
    try {
      if (window.databaseAPI && typeof window.databaseAPI.open === 'function') {
        return window.databaseAPI.open();
      }
      // 纯浏览器预览（无 Electron preload）时降级提示
      if (window.console) console.warn('[database] 内嵌 PostgreSQL 仅在桌面应用外壳中可用');
    } catch (e) {
      if (window.console) console.warn('[database] 打开数据库失败：', e);
    }
  }
  window.openPostgresDatabase = openPostgresDatabase;
})();
