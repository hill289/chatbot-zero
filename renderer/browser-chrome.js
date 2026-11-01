// 浏览器 chrome（标签栏 + 地址栏）的前端逻辑。
// 通过 contextBridge 暴露的 window.browser 与主进程通信。
(function () {
  'use strict';

  var api = window.browser;
  if (!api) {
    document.body.textContent = 'browser API 未注入';
    return;
  }

  var tabsEl = document.getElementById('tabs');
  var addressEl = document.getElementById('address');
  var backEl = document.getElementById('back');
  var forwardEl = document.getElementById('forward');
  var reloadEl = document.getElementById('reload');
  var homeEl = document.getElementById('home');
  var devtoolsEl = document.getElementById('devtools');
  var newTabEl = document.getElementById('newtab');

  var state = { tabs: [], activeId: null };
  var editing = false; // 用户正在编辑地址栏时不覆盖其内容

  function activeTab() {
    for (var i = 0; i < state.tabs.length; i++) {
      if (state.tabs[i].id === state.activeId) return state.tabs[i];
    }
    return null;
  }

  function render() {
    // 标签
    tabsEl.textContent = '';
    state.tabs.forEach(function (t) {
      var tab = document.createElement('div');
      tab.className = 'tab' + (t.id === state.activeId ? ' active' : '');
      tab.title = t.title || t.url || '';

      var fav = document.createElement('span');
      fav.className = 'fav';
      fav.textContent = t.loading ? '◌' : '🌐';
      tab.appendChild(fav);

      var title = document.createElement('span');
      title.className = 'title';
      title.textContent = t.title || t.url || '新标签页';
      tab.appendChild(title);

      var close = document.createElement('span');
      close.className = 'close';
      close.textContent = '✕';
      // 用 mousedown 而非 click：点标签时会在 mousedown 阶段触发标签栏整条重绘，
      // 原元素被销毁后 click 不再派发，导致「关闭」失效。
      close.addEventListener('mousedown', function (e) {
        if (e.button === 0) {
          e.stopPropagation(); // 阻止冒泡到 tab，避免先激活再关闭
          api.closeTab(t.id);
        }
      });
      tab.appendChild(close);

      tab.addEventListener('mousedown', function (e) {
        if (e.button === 1) { e.preventDefault(); api.closeTab(t.id); return; } // 中键关闭
        if (e.button === 0) api.activateTab(t.id);
      });

      tabsEl.appendChild(tab);
    });

    // 工具栏
    var a = activeTab();
    if (!editing) addressEl.value = a ? (a.url || '') : '';
    backEl.disabled = !(a && a.canGoBack);
    forwardEl.disabled = !(a && a.canGoForward);
    var loading = !!(a && a.loading);
    reloadEl.textContent = loading ? '✕' : '⟳';
    reloadEl.title = loading ? '停止' : '刷新 (Ctrl+R)';
  }

  // ── 事件 ──
  addressEl.addEventListener('focus', function () { editing = true; addressEl.select(); });
  addressEl.addEventListener('blur', function () { editing = false; });
  addressEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var v = addressEl.value.trim();
      if (v) api.navigate(v);
      addressEl.blur();
    } else if (e.key === 'Escape') {
      editing = false;
      var a = activeTab();
      addressEl.value = a ? (a.url || '') : '';
      addressEl.blur();
    }
  });

  backEl.addEventListener('click', function () { api.back(); });
  forwardEl.addEventListener('click', function () { api.forward(); });
  reloadEl.addEventListener('click', function () {
    var a = activeTab();
    if (a && a.loading) api.stop(); else api.reload();
  });
  homeEl.addEventListener('click', function () { api.home(); });
  devtoolsEl.addEventListener('click', function () { api.devtools(); });
  newTabEl.addEventListener('click', function () { api.newTab(); });

  // ── 主进程 → chrome ──
  api.onState(function (s) { state = s || state; render(); });
  api.onFocusAddress(function () {
    editing = true;
    addressEl.focus();
    addressEl.select();
  });

  api.getState().then(function (s) {
    if (s) { state = s; render(); }
  });
})();
