/*!
 * example-plugin.js — 第三方 / 自定义工具「可插拔注册」示例插件
 * -----------------------------------------------------------------------------
 * 演示：**不改工作台源码**，仅靠一个独立的 <script> 就能把自定义工具接进
 * AI Agent 工作台（renderer/index.html）的 LLM 工具调用循环。
 *
 * 启用方式（任选其一）：
 *   1) 在 renderer/index.html 的 </body> 前加一行：
 *        <script src="./tools/example-plugin.js"></script>
 *   2) 或在浏览器控制台里直接粘贴本文件内容执行；
 *   3) 也可以打开工作台右下角「🛠️ → 🔌 工具注册表」，点 🧪 载入内置示例。
 *
 * 插件通过 `window.registerTool(def)` 注册；注册表会自动：
 *   · 把工具映射进内置 MCP Server（服务键 `tool-registry`），模型立即可见可调用；
 *   · 失效 system+tools 前缀缓存（下一轮一次 miss），随后保持字节稳定。
 *
 * 卸载：调用 `window.__examplePluginUnload()`（按 tag 批量注销）。
 */
(function (root) {
  'use strict';

  var SOURCE = 'example-plugin';
  var TAG = 'example-plugin';

  function getRegistry() {
    return root && root.ToolRegistry ? root.ToolRegistry : null;
  }

  function shouldSkip() {
    // 允许用户用 <body data-disable-example-tools> 关闭自动注册
    return !!(root.document && root.document.body &&
      root.document.body.hasAttribute('data-disable-example-tools'));
  }

  function defineTools() {
    return [
      {
        name: 'plugin_word_count',
        description: '统计一段文本的字符数 / 单词数 / 行数（第三方插件示例，纯本地执行）。',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要统计的文本' }
          },
          required: ['text']
        },
        tags: [TAG],
        source: SOURCE,
        // ── 执行体：内联 JS（可持久化）──
        code: [
          "const s = args.text == null ? '' : String(args.text);",
          "return {",
          "  chars: s.length,",
          "  words: (s.trim().match(/\\S+/g) || []).length,",
          "  lines: s ? s.split(/\\r\\n|\\r|\\n/).length : 0",
          "};"
        ].join('\n')
      },
      {
        name: 'plugin_reverse_text',
        description: '把输入文本按 Unicode 码点反转（第三方插件示例）。',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: '要反转的文本' } },
          required: ['text']
        },
        tags: [TAG],
        source: SOURCE,
        code: "return Array.from(String(args.text == null ? '' : args.text)).reverse().join('');"
      },
      {
        name: 'plugin_http_get',
        description: '对指定 URL 发起 GET 请求并返回响应体（第三方插件示例：声明式 HTTP 执行体）。',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: '完整请求地址（含协议）' } },
          required: ['url']
        },
        tags: [TAG],
        source: SOURCE,
        // ── 执行体：声明式 HTTP（可持久化）──
        http: { url: '{url}', method: 'GET', headers: { 'Accept': 'application/json, text/plain, */*' } }
      },
      {
        name: 'plugin_using_handler',
        description: '演示「函数型 handler」执行体（第三方插件示例）：把秒数格式化为 时:分:秒。',
        inputSchema: {
          type: 'object',
          properties: { seconds: { type: 'number', description: '秒数' } },
          required: ['seconds']
        },
        tags: [TAG],
        source: SOURCE,
        // ── 执行体：函数 handler（可直接闭包引用插件内部状态；不随持久化保存）──
        handler: function (args) {
          var total = Math.max(0, Math.floor(Number(args.seconds) || 0));
          var h = Math.floor(total / 3600);
          var m = Math.floor((total % 3600) / 60);
          var s = total % 60;
          var pad = function (n) { return (n < 10 ? '0' : '') + n; };
          return pad(h) + ':' + pad(m) + ':' + pad(s);
        }
      }
    ];
  }

  function install() {
    var registry = getRegistry();
    if (!registry) {
      console.warn('[example-plugin] 未找到 window.ToolRegistry —— 请确保在 tool-registry.js 之后加载本插件');
      return false;
    }
    var result = registry.registerMany(defineTools(), { source: SOURCE, override: true });
    console.log('[example-plugin] 已注册 ' + result.registered.length + ' 个工具：' +
      result.registered.map(function (t) { return t.name; }).join(', '));
    if (result.errors.length) console.warn('[example-plugin] 失败：', result.errors);

    root.__examplePluginUnload = function () {
      var n = registry.unregisterByTag(TAG);
      console.log('[example-plugin] 已卸载 ' + n + ' 个工具');
      return n;
    };
    return true;
  }

  if (shouldSkip()) {
    console.log('[example-plugin] 检测到 data-disable-example-tools，跳过自动注册');
    return;
  }

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
