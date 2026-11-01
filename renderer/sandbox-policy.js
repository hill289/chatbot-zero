/*!
 * sandbox-policy.js — 命令沙箱策略引擎（L1）纯逻辑
 * =============================================================================
 * 对齐 dsh `sandbox/` 的「策略层」：在 approval（人的闸门）之前，先由机制判断
 * 一条 shell 命令的风险等级与决策：
 *   low      → allow   直接执行
 *   medium   → approve 需要逐次人工确认（如依赖安装）
 *   high     → approve 需要逐次人工确认，且不允许 allow-session 一次放行
 *   critical → deny    直接拒绝（返回可读理由，不中断整轮）
 *
 * 纯逻辑、零依赖、UMD（浏览器 window.SandboxPolicy / Node module.exports）。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SandboxPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = { allowNetwork: false, networkPolicy: 'approve' };

  var RANK = { low: 0, medium: 1, high: 2, critical: 3 };

  var CRITICAL = [
    { re: /\brm\s+(-[a-z-]*\s+)*-?[a-z]*[rf][a-z]*\s+(\/|~|\$HOME)(\s|$)/i, reason: '递归删除根目录/家目录' },
    { re: /\b(mkfs|fdisk|parted)\b|\bdd\b[^\n]*\bof=\/dev\//i, reason: '磁盘/分区写入' },
    { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: '关机/重启' },
    { re: /\bformat\s+[a-z]:/i, reason: '格式化磁盘' },
    { re: /\b(curl|wget|iwr|invoke-webrequest)\b[^\n]*([;|]\s*)(sh|bash|zsh|powershell|pwsh|iex|invoke-expression)\b/i, reason: '下载后直接执行' },
    { re: /\bpowershell(\.exe)?\b[^\n]*\s-(enc|encodedcommand)\b/i, reason: 'PowerShell 编码命令' },
    { re: /\b(sudo|runas|doas)\b|\breg\s+add\b|\bchmod\s+(-r\s+)?777\b/i, reason: '提权/注册表/危险权限' },
    { re: /\b(rm|del)\b[^\n]*\b(\.env|id_rsa|\.ssh|\.aws|credentials)\b/i, reason: '删除敏感文件' }
  ];

  var HIGH = [
    { re: /\bssh\b|\bscp\b|\brsync\b/i, reason: '远程传输' },
    { re: /~\/\.ssh|\.pem\b|id_rsa|\.npmrc\b|\.aws\/credentials|\/\.env\b|\bcredentials\.json\b/i, reason: '访问敏感文件' },
    { re: /\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f[a-z]*x\b/i, reason: '破坏性 git 操作' },
    { re: /\b(nc|ncat|socat|telnet)\b/i, reason: '原始网络工具' },
    { re: /(^|\s)(\/(etc|usr|bin|sbin|var|opt|root|home)\/[^\s]*|[A-Za-z]:\\\\?Windows\\\\?[^\s]*)/, reason: '访问工作区外的绝对路径' }
  ];

  var NETWORK = /\b(curl|wget|iwr|invoke-webrequest|Invoke-RestMethod)\b|\b(npm|pnpm|yarn)\s+(install|i|add|ci|update)\b|\b(pip|pip3)\s+install\b|\bgit\s+(clone|fetch|pull|push)\b/i;

  function rank(r) { return RANK[r] || 0; }
  function maxRank(a, b) { return rank(a) >= rank(b) ? a : b; }

  // 依赖安装默认加 --ignore-scripts（可用 ignoreScripts:false 关闭）
  function sanitizeCommand(command, opts) {
    var cmd = String(command == null ? '' : command);
    if (opts && opts.ignoreScripts === false) return cmd;
    return cmd.replace(/\b(npm|pnpm|yarn)\s+(install|i|add|ci)\b(?![^\n]*--ignore-scripts)/gi, function (m) {
      return m + ' --ignore-scripts';
    });
  }

  // classify(command, opts?) → { risk, decision, reasons, matched, sanitizedCommand }
  function classify(command, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var cmd = String(command == null ? '' : command);
    var reasons = [];
    var matched = [];
    var risk = 'low';

    function scan(list, level) {
      list.forEach(function (r) {
        if (r.re.test(cmd)) {
          reasons.push(r.reason);
          matched.push(String(r.re));
          risk = maxRank(risk, level);
        }
      });
    }
    scan(CRITICAL, 'critical');
    scan(HIGH, 'high');

    // 依赖安装：medium（可能执行 postinstall）
    if (/\b(npm|pnpm|yarn)\s+(install|i|add|ci)\b/i.test(cmd)) {
      risk = maxRank(risk, 'medium');
      reasons.push('依赖安装可能执行 postinstall 脚本');
    }

    // 网络访问：allowNetwork=false 时至少需要人工确认
    if (NETWORK.test(cmd) && !opts.allowNetwork) {
      risk = maxRank(risk, opts.networkPolicy === 'deny' ? 'critical' : 'high');
      reasons.push('包含网络访问（allowNetwork=false）');
    }

    var decision;
    if (risk === 'critical') decision = 'deny';
    else if (risk === 'high' || risk === 'medium') decision = 'approve';
    else decision = 'allow';

    return {
      risk: risk,
      decision: decision,
      reasons: reasons,
      matched: matched,
      sanitizedCommand: sanitizeCommand(cmd, opts)
    };
  }

  function denyMessage(command, verdict) {
    var rs = (verdict && verdict.reasons && verdict.reasons.length) ? verdict.reasons.join('；') : '命中危险命令策略';
    return '⛔ 沙箱策略拒绝执行：' + rs + '。\n命令：' + String(command || '').slice(0, 300) +
      '\n请换一种安全的做法（缩小范围 / 改用工具 / 先说明意图），不要原样重复同一调用。';
  }

  return {
    DEFAULTS: DEFAULTS,
    rank: rank,
    scanRisk: maxRank,
    sanitizeCommand: sanitizeCommand,
    classify: classify,
    denyMessage: denyMessage
  };
});
