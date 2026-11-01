    (function () {
      var cache = { xlsx: undefined, pptxgenjs: undefined };
      var resolveReady;
      window.__officeLibsReady = new Promise(function (res) { resolveReady = res; });

      // 等待两库就绪；超时后照样返回，避免运行时异常时编辑器初始化永久挂起
      window.__waitOfficeLibs = function (timeoutMs) {
        return Promise.race([
          window.__officeLibsReady,
          new Promise(function (res) { setTimeout(res, timeoutMs || 60000); })
        ]);
      };

      // 从 almostnode（浏览器内 Node.js）运行时 require 出已内置的 npm 包
      function requireFromRuntime(name) {
        var rt = null;
        try { rt = (typeof nodeRuntime !== 'undefined') ? nodeRuntime : null; } catch (_) { rt = null; }
        if (!rt || !rt.container) return undefined;
        try {
          var result = rt.container.execute(
            "module.exports = require('" + name + "');",
            '/tmp/__almostnode_pkg_' + name + '.js'
          );
          return result ? result.exports : undefined;
        } catch (err) {
          console.warn('[office] 从 almostnode 运行时加载 "' + name + '" 失败：', err);
          return undefined;
        }
      }

      // 按需取得库对象（带缓存）
      window.__officeLoadLib = function (name) {
        if (!(name in cache)) return undefined;
        if (!cache[name]) cache[name] = requireFromRuntime(name);
        return cache[name];
      };

      // 判断一个对象是否是「真正可用」的 xlsx 库（需要 read/util 等 API）
      function isRealXlsx(lib) {
        return !!lib && typeof lib.read === "function" && !!lib.utils;
      }

      // 兼容 ESM/CJS 互操作：真正的导出可能挂在 default 上
      function unwrapLib(mod) {
        if (mod && !isRealXlsx(mod) && mod.default && isRealXlsx(mod.default)) {
          return mod.default;
        }
        return mod;
      }

      function install() {
        var xlsx = unwrapLib(window.__officeLoadLib('xlsx'));
        var pptxgenjs = unwrapLib(window.__officeLoadLib('pptxgenjs'));
        // ⚠️ 这里不能用 if (xlsx && !window.XLSX) 判断：
        //   almostnode 容器执行 xlsx 的 UMD bundle 时，其尾部会运行
        //     if (typeof window!=="undefined" && !window.XLSX) window.XLSX = XLSX;
        //   此刻 bundle 内部的 XLSX 只是一个空对象 {}（真正的导出挂在 module.exports 上），
        //   于是页面上的 window.XLSX 被提前污染成一个没有 read/write/utils 的空壳。
        //   若再用「!window.XLSX」判断，就永远不会用真正的库覆盖它，
        //   最终表现为 “XLSX.read is not a function”。
        //   所以只有当现有 window.XLSX 不是真正的库时才覆盖。
        if (xlsx && !isRealXlsx(window.XLSX)) window.XLSX = xlsx;
        if (pptxgenjs && !window.PptxGenJS) window.PptxGenJS = pptxgenjs;
        // 两个库都必须是“可用”的（XLSX 要有 read/utils），否则不 resolve ready
        if (isRealXlsx(window.XLSX) && window.PptxGenJS) {
          try { resolveReady(true); } catch (_) {}
          return true;
        }
        return false;
      }
      window.__installOfficeLibs = install;

      // almostnode 容器创建是同步的，但 nodeRuntime 在后续 <script> 中定义；
      // 轮询等待运行时出现并注入库（幂等，最多约 60s）。
      var attempts = 0;
      (function poll() {
        if (install()) return;
        if (attempts++ < 1200) setTimeout(poll, 50);
      })();
    })();
