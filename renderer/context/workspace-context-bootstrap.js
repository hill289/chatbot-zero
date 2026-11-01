/*!
 * workspace-context-bootstrap.js — 工作区上下文接线（零侵入）
 * =============================================================================
 * 依赖：
 *   · renderer/context/workspace-context.js → window.WorkspaceContext（纯逻辑）
 *   · renderer/tool-registry.js             → window.registerTool（working_directory 工具）
 *   · renderer/assets/js/08-ui-store.js     → agentStore.promptMessage 钩子
 *   · almostnode VirtualFS（nodeRuntime.vfs）读取 AGENTS.md / CLAUDE.md
 *
 * 做三件事：
 *   1) 每轮把「项目指令 + 工作目录 + 当前时间」注入到最后一条 user 消息尾部
 *      （不改 system+tools 前缀 → 前缀缓存不失效）；
 *   2) 注册 working_directory 工具：读取/切换当前会话工作目录；
 *   3) 暴露 window.WorkspaceContextBridge（enhance / config / buildBlock）。
 * =============================================================================
 */
(function () {
  'use strict';

  var CORE = (typeof window !== 'undefined' && window.WorkspaceContext) || null;
  if (!CORE) { try { console.warn('[workspace-context] workspace-context.js 未加载，跳过接线'); } catch (_) {} return; }

  var CFG = Object.assign({}, CORE.DEFAULTS);
  var DEFAULT_WORKDIR = '/home/pyodide';

  function currentWorkdir() {
    try {
      var wd = (typeof window !== 'undefined') ? window.__workingDirectory : null;
      return (typeof wd === 'string' && wd.trim()) ? wd.trim() : DEFAULT_WORKDIR;
    } catch (_) { return DEFAULT_WORKDIR; }
  }

  function normalizePath(p) {
    p = String(p == null ? '' : p).trim().replace(/\\/g, '/');
    if (!p) return currentWorkdir();
    if (p.charAt(0) !== '/') {
      var base = currentWorkdir().replace(/\/+$/, '');
      p = base + '/' + p.replace(/^\.?\//, '');
    }
    // 折叠 ./ 与重复斜杠
    p = p.replace(/\/+/g, '/');
    return p;
  }

  function readVfsText(path) {
    try {
      if (typeof nodeRuntime === 'undefined' || !nodeRuntime || !nodeRuntime.vfs) return null;
      var bytes = nodeRuntime.vfs.readFileSync(path);
      if (!bytes) return null;
      return new TextDecoder().decode(bytes);
    } catch (_) { return null; }
  }

  function readInstruction() {
    var wd = currentWorkdir().replace(/\/+$/, '') || '';
    var names = CFG.instructionNames && CFG.instructionNames.length ? CFG.instructionNames : CORE.DEFAULTS.instructionNames;
    for (var i = 0; i < names.length; i++) {
      var p = (wd || '') + '/' + names[i];
      var text = readVfsText(p);
      if (text != null && String(text).trim()) {
        return { name: names[i], path: p, text: text };
      }
    }
    return null;
  }

  function buildBlock() {
    if (!CFG.enabled) return '';
    var wd = currentWorkdir();
    var instr = readInstruction();
    return CORE.compose({
      agentsText: instr && instr.text,
      fileName: instr && instr.name,
      workingDirectory: wd,
      includeTime: CFG.includeTime,
      maxAgentsChars: CFG.maxAgentsChars,
      now: Date.now()
    });
  }

  // 只注入到最后一条「纯文本」user 消息；多模态消息不动（避免破坏 content 数组结构）
  function enhance(base, conversation) {
    if (!CFG.enabled) return Promise.resolve(base);
    try {
      var block = buildBlock();
      if (!block) return Promise.resolve(base);
      var messages = base.slice();
      for (var j = messages.length - 1; j >= 0; j--) {
        var m = messages[j];
        if (m && m.role === 'user') {
          if (typeof m.content !== 'string') return Promise.resolve(base);
          messages[j] = Object.assign({}, m, { content: block + '\n\n' + m.content });
          return Promise.resolve(messages);
        }
      }
    } catch (_) { /* 上下文注入失败绝不影响对话 */ }
    return Promise.resolve(base);
  }

  // ── working_directory 工具 ──────────────────────────────────────────────
  function toolWorkingDirectory(args) {
    args = args || {};
    if (args.path != null && String(args.path).trim() !== '') {
      var next = normalizePath(args.path);
      window.__workingDirectory = next;
      try {
        if (typeof window.__onWorkingDirectoryChange === 'function') window.__onWorkingDirectoryChange(next);
      } catch (_) {}
      return {
        working_directory: next,
        previous: currentWorkdir(),
        note: '后续 run_shell / run_tests 默认在该目录执行（相对路径以它为基准）。'
      };
    }
    return { working_directory: currentWorkdir() };
  }

  function registerTool() {
    if (typeof window.registerTool !== 'function') {
      setTimeout(registerTool, 100);
      return;
    }
    try {
      window.registerTool({
        name: 'working_directory',
        description: '读取或改变当前会话的工作目录（影响 run_shell / run_tests 的默认执行目录）。不传 path 时返回当前目录。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要切换到的工作目录（绝对路径，或相对当前工作目录的相对路径）。省略则只读取。' }
          },
          required: [],
          additionalProperties: false
        },
        handler: async function (args) { return toolWorkingDirectory(args); }
      }, { source: 'workspace-context', builtin: true, override: true });
    } catch (e) {
      try { console.warn('[workspace-context] 注册 working_directory 失败', e); } catch (_) {}
    }
  }

  window.WorkspaceContextBridge = {
    enhance: enhance,
    buildBlock: buildBlock,
    get workingDirectory() { return currentWorkdir(); },
    setWorkingDirectory: function (p) { return toolWorkingDirectory({ path: p }); },
    config: function (patch) {
      patch = patch || {};
      if (patch.enabled != null) CFG.enabled = !!patch.enabled;
      if (patch.includeTime != null) CFG.includeTime = !!patch.includeTime;
      if (patch.maxAgentsChars != null) CFG.maxAgentsChars = Number(patch.maxAgentsChars) || CFG.maxAgentsChars;
      if (Array.isArray(patch.instructionNames)) CFG.instructionNames = patch.instructionNames.slice();
      return { enabled: CFG.enabled, includeTime: CFG.includeTime, maxAgentsChars: CFG.maxAgentsChars, instructionNames: CFG.instructionNames.slice(), workingDirectory: currentWorkdir() };
    },
    tools: ['working_directory']
  };

  registerTool();
})();
