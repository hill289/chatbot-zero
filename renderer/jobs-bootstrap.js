/*!
 * jobs-bootstrap.js — 后台任务控制工具（job_list / job_output / job_kill）
 * 依赖：renderer/jobs.js（纯逻辑）、preload 注入的 window.shellAPI。
 */
(function () {
  'use strict';
  var CORE = (typeof window !== 'undefined' && window.JobService) || null;
  if (!CORE) { try { console.warn('[jobs] jobs.js 未加载，跳过接线'); } catch (_) {} return; }

  function api() { return (typeof window !== 'undefined') ? window.shellAPI : null; }

  function toolJobList() {
    var a = api();
    if (!a || typeof a.listJobs !== 'function') return { error: '后台任务需要 Electron 外壳（shellAPI 不可用）' };
    return Promise.resolve(a.listJobs({})).then(function (r) {
      if (!r || !r.ok) return { error: (r && r.error) || 'job_list 失败' };
      return { jobs: r.jobs || [], formatted: CORE.formatList(r.jobs || []) };
    });
  }

  function toolJobOutput(args) {
    args = args || {};
    var a = api();
    if (!a || typeof a.jobOutput !== 'function') return { error: '后台任务需要 Electron 外壳（shellAPI 不可用）' };
    if (!args.job_id) return { error: 'job_output 需要 job_id' };
    return Promise.resolve(a.jobOutput({
      jobId: args.job_id,
      offset: args.offset || 0,
      maxChars: args.max_chars || 20000
    })).then(function (r) {
      if (!r || !r.ok) return { error: (r && r.error) || 'job_output 失败' };
      return { job: r.job, nextOffset: r.nextOffset, hasMore: r.hasMore, formatted: CORE.formatOutput(r) };
    });
  }

  function toolJobKill(args) {
    args = args || {};
    var a = api();
    if (!a || typeof a.killJob !== 'function') return { error: '后台任务需要 Electron 外壳（shellAPI 不可用）' };
    if (!args.job_id) return { error: 'job_kill 需要 job_id' };
    return Promise.resolve(a.killJob({ jobId: args.job_id })).then(function (r) {
      return (r && r.ok) ? { killed: true, job_id: args.job_id } : { error: (r && r.error) || 'job_kill 失败' };
    });
  }

  var TOOLS = [
    {
      name: 'job_list',
      description: '列出后台任务（run_shell 传 run_in_background=true 启动）：id、命令、状态、退出码、输出字节数。',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      handler: function () { return toolJobList(); }
    },
    {
      name: 'job_output',
      description: '读取后台任务的输出（支持 offset 续读；返回 nextOffset / hasMore）。',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: '后台任务 id' },
          offset: { type: 'integer', description: '从输出字符偏移开始读（默认 0）' },
          max_chars: { type: 'integer', description: '本次最多返回字符数（默认 20000）' }
        },
        required: ['job_id'], additionalProperties: false
      },
      handler: function (args) { return toolJobOutput(args); }
    },
    {
      name: 'job_kill',
      description: '终止某个后台任务（整棵进程树）。',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string', description: '后台任务 id' } },
        required: ['job_id'], additionalProperties: false
      },
      handler: function (args) { return toolJobKill(args); }
    }
  ];

  function register() {
    if (typeof window.registerTool !== 'function') { setTimeout(register, 100); return; }
    try {
      if (typeof window.registerTools === 'function') window.registerTools(TOOLS, { source: 'jobs', builtin: true, override: true });
      else TOOLS.forEach(function (t) { window.registerTool(t, { source: 'jobs', builtin: true, override: true }); });
    } catch (e) { try { console.warn('[jobs] 注册失败', e); } catch (_) {} }
  }
  register();
})();
