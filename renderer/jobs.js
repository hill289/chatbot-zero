/*!
 * jobs.js — 后台任务（Background Jobs）纯逻辑
 * =============================================================================
 * 对齐 dsh 的 `jobs/`：run_shell(run_in_background) 启动任务后返回 job_id，
 * 之后用 job_list / job_output / job_kill 读取与终止。
 * 纯逻辑、零依赖、UMD（window.JobService / Node module.exports）。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.JobService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = { maxChars: 20000 };

  function statusOf(job) {
    if (!job) return 'missing';
    if (job.status) return job.status;
    if (job.running) return 'running';
    return (job.exitCode === 0) ? 'exited' : 'failed';
  }

  function formatDuration(ms) {
    ms = Math.max(0, Number(ms) || 0);
    if (ms < 1000) return ms + 'ms';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
    var m = Math.floor(s / 60);
    var rs = Math.round(s % 60);
    return m + 'm' + rs + 's';
  }

  function truncateOutput(text, maxChars) {
    text = String(text == null ? '' : text);
    maxChars = Number(maxChars) || DEFAULTS.maxChars;
    if (text.length <= maxChars) return { text: text, truncated: false, omitted: 0 };
    return { text: text.slice(0, maxChars), truncated: true, omitted: text.length - maxChars };
  }

  function formatList(jobs) {
    if (!jobs || !jobs.length) return '当前没有后台任务。用 run_shell(run_in_background=true) 启动。';
    var lines = ['后台任务（' + jobs.length + '）：'];
    jobs.forEach(function (j) {
      var st = statusOf(j);
      var dur = formatDuration((j.endedAt || Date.now()) - (j.startedAt || Date.now()));
      lines.push(j.id + ' [' + st + '] ' + (j.command || '') +
        ' — ' + dur + (j.exitCode != null ? ('，exit ' + j.exitCode) : '') +
        '，out ' + (j.stdoutBytes != null ? j.stdoutBytes : 0) + 'B / err ' + (j.stderrBytes != null ? j.stderrBytes : 0) + 'B');
    });
    return lines.join('\n');
  }

  function formatOutput(res, opts) {
    res = res || {};
    var j = res.job || {};
    var st = statusOf(j);
    var head = 'Job ' + j.id + ' [' + st + '] ' + (j.command || '') +
      (j.exitCode != null ? (' — exit ' + j.exitCode) : '') +
      (res.nextOffset != null ? ('（offset=' + res.nextOffset + (res.hasMore ? '，还有更多' : '') + '）') : '');
    var parts = [head];
    if (res.stdout) parts.push('\n[stdout]\n' + res.stdout);
    if (res.stderr) parts.push('\n[stderr]\n' + res.stderr);
    if (!res.stdout && !res.stderr) parts.push('\n（暂无输出）');
    if (res.capped) parts.push('\n（输出超过上限，后续内容已丢弃）');
    return parts.join('\n');
  }

  return {
    DEFAULTS: DEFAULTS,
    statusOf: statusOf,
    formatDuration: formatDuration,
    truncateOutput: truncateOutput,
    formatList: formatList,
    formatOutput: formatOutput
  };
});
