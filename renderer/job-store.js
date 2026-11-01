/* ══════════════════════════════════════════════════════════════════════
 *  renderer/job-store.js —— 后台任务落盘 / 续跑（主进程使用，纯 Node 可单测）
 *
 *  为什么需要：run:start 的 job 原来只活在内存 Map 里，关窗即丢 ——
 *  输出看不到、状态不知道、长任务白跑。这里把「记录 + 输出」都落到
 *  <APP_DIR>/jobs/ 下：
 *    <id>.json      任务记录（命令 / 工作区 / 状态 / 起止时间 / 偏移）
 *    <id>.out.log   stdout（追加）
 *    <id>.err.log   stderr（追加）
 *  重启后：
 *    · 上次仍在 running 的任务标记为 interrupted（进程已随应用退出）；
 *    · job_list / job_output 可继续读取历史输出（按字符偏移切片）；
 *    · job_resume 用原命令在原工作区重新执行，输出继续追加到同一任务下的新 attempt。
 * ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 8 * 1024 * 1024; // 单流日志上限，超出后截断追加（保头部）

function safeId(id) {
    return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

function createJobStore(opts) {
    opts = opts || {};
    const dir = opts.dir;
    if (!dir) throw new Error('job-store: dir required');
    const fsp = opts.fs || fs;
    fsp.mkdirSync(dir, { recursive: true });

    const recordFile = (id) => path.join(dir, safeId(id) + '.json');
    const logFile = (id, stream) => path.join(dir, safeId(id) + (stream === 'stderr' ? '.err.log' : '.out.log'));

    function save(record) {
        if (!record || !record.id) return null;
        const f = recordFile(record.id);
        const tmp = f + '.tmp';
        const data = JSON.stringify(record, null, 2);
        fsp.writeFileSync(tmp, data, { mode: 0o600 });
        fsp.renameSync(tmp, f);
        return record;
    }

    function read(id) {
        try { return JSON.parse(fsp.readFileSync(recordFile(id), 'utf8')); }
        catch (_) { return null; }
    }

    function remove(id) {
        [recordFile(id), logFile(id, 'stdout'), logFile(id, 'stderr')].forEach((f) => {
            try { fsp.unlinkSync(f); } catch (_) {}
        });
    }

    function list() {
        let names = [];
        try { names = fsp.readdirSync(dir); } catch (_) { return []; }
        const out = [];
        names.forEach((name) => {
            if (!/\.json$/.test(name)) return;
            const rec = read(name.replace(/\.json$/, ''));
            if (rec && rec.id) out.push(rec);
        });
        out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        return out;
    }

    function append(id, stream, text) {
        if (!text) return 0;
        const f = logFile(id, stream);
        try {
            const st = fsp.existsSync(f) ? fsp.statSync(f) : null;
            if (st && st.size > MAX_LOG_BYTES) {
                // 超限：只保留头部，后续内容丢弃但记录 truncated 标记在 record 里维护
                return 0;
            }
            fsp.appendFileSync(f, String(text), { mode: 0o600 });
            return String(text).length;
        } catch (_) { return 0; }
    }

    function readAll(id, stream) {
        try { return fsp.readFileSync(logFile(id, stream), 'utf8'); }
        catch (_) { return ''; }
    }

    function slice(id, stream, offset, maxChars) {
        const all = readAll(id, stream);
        const off = Math.max(0, Number(offset) || 0);
        const max = Math.max(0, Number(maxChars) || 20000);
        const part = all.slice(off, off + max);
        return { text: part, nextOffset: off + part.length, hasMore: all.length > off + part.length, total: all.length };
    }

    // 启动时：上次仍是 running 的任务 → interrupted（进程随应用退出，不可能还活着）
    function markInterrupted(now) {
        const list0 = list();
        const touched = [];
        list0.forEach((rec) => {
            if (rec.status === 'running' || rec.status === 'starting') {
                rec.status = 'interrupted';
                rec.endedAt = rec.endedAt || null;
                rec.interruptedAt = now || Date.now();
                rec.hint = '应用关闭导致任务中断，可用 job_resume 续跑（同命令同工作区）。';
                save(rec);
                touched.push(rec);
            }
        });
        return touched;
    }

    return { dir, save, read, list, remove, append, readAll, slice, markInterrupted, recordFile, logFile };
}

module.exports = { createJobStore, MAX_LOG_BYTES };
