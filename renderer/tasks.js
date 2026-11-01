/* ══════════════════════════════════════════════════════════════════════
 *  renderer/tasks.js —— 任务中心核心（任务态 / 产物 / 变更 diff / 三段式 / 恢复）
 *
 *  纯逻辑、零依赖、UMD（window.TaskService / Node module.exports）。
 *  设计要点：
 *   · 任务是一个可序列化 JSON（落盘即恢复），字段只增不改，向后兼容；
 *   · planner → executor → verifier 是一个显式状态机（advance），
 *     每次工具调用 / 工具结果 / 验证结果都是事件，状态转移可单测；
 *   · 产物（artifacts）按路径归并，带上「增/删行数 + 最近一次 diff」；
 *   · verifier 用「可验证证据」判定（测试退出码、诊断错误数、变更规模），
 *     不通过则回到 executing 并把原因写进 notes，供下一轮 prompt 注入。
 * ══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TaskService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var STAGES = ['idle', 'planning', 'executing', 'verifying', 'paused', 'done', 'failed', 'interrupted'];
    var MAX_DIFF_CHARS = 60000;

    function nowMs() { return Date.now(); }

    function uid(prefix) {
        return (prefix || 'task') + '-' + nowMs().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }

    function createTask(goal, opts) {
        opts = opts || {};
        var t = nowMs();
        return {
            id: opts.id || uid('task'),
            title: String(opts.title || goal || '未命名任务').slice(0, 80),
            goal: String(goal || ''),
            stage: 'planning',
            status: 'running',            // running | paused | done | failed
            attempts: 0,                  // verifier 不通过后回到执行的次数
            maxAttempts: opts.maxAttempts || 3,
            autoContinues: 0,             // 执行护栏中止后「自动发送继续」的次数（防无限续跑）
            maxAutoContinues: opts.maxAutoContinues || 3,
            lastAutoContinue: 0,          // 最近一次自动续跑的时间戳
            lastGuardReason: '',          // 最近一次护栏中止原因
            steps: [],
            artifacts: [],                // { path, kind, add, del, lastChangeAt, diff }
            notes: [],                    // 验证反馈 / 恢复提示（会注入 prompt 尾部）
            evidence: { tests: null, diagnostics: null, toolErrors: 0 },
            createdAt: t,
            updatedAt: t,
            startedAt: t,
            endedAt: null,
            lastError: '',
            resume: null                  // 恢复用：最近一次阶段 + 未完成步骤
        };
    }

    // ── 步骤 ──────────────────────────────────────────────
    function addStep(task, title, opts) {
        opts = opts || {};
        var step = {
            id: opts.id || uid('step'),
            title: String(title || '').slice(0, 120),
            status: 'pending',            // pending | running | done | failed | skipped
            note: ''
        };
        task.steps.push(step);
        touch(task);
        return step;
    }

    function setStep(task, stepId, status, note) {
        for (var i = 0; i < task.steps.length; i++) {
            if (task.steps[i].id === stepId) {
                task.steps[i].status = status;
                if (note != null) task.steps[i].note = String(note).slice(0, 300);
                touch(task);
                return task.steps[i];
            }
        }
        return null;
    }

    function nextPendingStep(task) {
        for (var i = 0; i < task.steps.length; i++) {
            if (task.steps[i].status === 'pending' || task.steps[i].status === 'running') return task.steps[i];
        }
        return null;
    }

    // ── 行级 diff（LCS）────────────────────────────────────
    function splitLines(s) { return String(s == null ? '' : s).split(/\r?\n/); }

    function lineDiff(before, after, opts) {
        opts = opts || {};
        var maxCells = opts.maxCells || 250000;     // 约 500×500 行
        var a = splitLines(before), b = splitLines(after);
        var add = 0, del = 0, i, j;
        // 超大文件：不做 LCS，直接给统计（避免卡死 UI）
        if (a.length * b.length > maxCells) {
            var prefix = 0;
            while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
            add = Math.max(0, b.length - prefix);
            del = Math.max(0, a.length - prefix);
            return {
                add: add, del: del, truncated: true,
                text: '@@ 文件过大，仅统计：+' + add + ' / -' + del + ' 行 @@'
            };
        }
        // LCS 动态规划
        var n = a.length, m = b.length;
        var dp = new Array(n + 1);
        for (i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
        for (i = n - 1; i >= 0; i--) {
            for (j = m - 1; j >= 0; j--) {
                dp[i][j] = (a[i] === b[j]) ? (dp[i + 1][j + 1] + 1) : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        var out = [], ctx = opts.context == null ? 2 : opts.context;
        i = 0; j = 0;
        while (i < n && j < m) {
            if (a[i] === b[j]) { out.push(' ' + a[i]); i++; j++; }
            else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('-' + a[i]); del++; i++; }
            else { out.push('+' + b[j]); add++; j++; }
        }
        while (i < n) { out.push('-' + a[i]); del++; i++; }
        while (j < m) { out.push('+' + b[j]); add++; j++; }
        // 折叠连续未改动的行（保留上下文），减少 diff 体积
        if (ctx >= 0) out = foldContext(out, ctx);
        var text = out.join('\n');
        var truncated = false;
        if (text.length > (opts.maxChars || MAX_DIFF_CHARS)) {
            text = text.slice(0, opts.maxChars || MAX_DIFF_CHARS);
            truncated = true;
        }
        return { add: add, del: del, truncated: truncated, text: text };
    }

    function foldContext(lines, ctx) {
        var keep = new Array(lines.length).fill(false);
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].charAt(0) !== ' ') {
                for (var k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true;
            }
        }
        var out = [], skipped = 0;
        for (var j = 0; j < lines.length; j++) {
            if (keep[j]) { if (skipped) { out.push('… 省略 ' + skipped + ' 行 …'); skipped = 0; } out.push(lines[j]); }
            else skipped++;
        }
        if (skipped) out.push('… 省略 ' + skipped + ' 行 …');
        return out;
    }

    // ── 产物 / 变更归集 ───────────────────────────────────
    function recordChange(task, filePath, before, after, opts) {
        opts = opts || {};
        var p = String(filePath || '');
        if (!p) return null;
        var d = lineDiff(before == null ? '' : before, after == null ? '' : after, opts);
        var art = null;
        for (var i = 0; i < task.artifacts.length; i++) {
            if (task.artifacts[i].path === p) { art = task.artifacts[i]; break; }
        }
        if (!art) {
            art = { path: p, kind: opts.kind || guessKind(p), add: 0, del: 0, changes: 0, diff: '', updatedAt: nowMs() };
            task.artifacts.push(art);
        }
        art.add += d.add;
        art.del += d.del;
        art.changes += 1;
        art.diff = String(d.text || '').slice(0, 20000);   // 落盘体积保护（完整统计已单独存）
        art.diffTruncated = !!d.truncated;
        art.updatedAt = nowMs();
        art.op = opts.op || 'modify';
        touch(task);
        return art;
    }

    function guessKind(p) {
        var s = String(p || '').toLowerCase();
        if (/\.(md|txt|rst)$/.test(s)) return 'doc';
        if (/\.(js|ts|jsx|tsx|py|go|java|rs|c|cpp|h|css|html)$/.test(s)) return 'code';
        if (/\.(json|ya?ml|toml|ini)$/.test(s)) return 'config';
        if (/\.(png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?)$/.test(s)) return 'binary';
        return 'file';
    }

    function touch(task) { task.updatedAt = nowMs(); }

    // ── 护栏自动续跑判定 ───────────────────────────────────
    // 执行护栏（createLoopGuard）中止后，是否自动发一条「继续」把对话推下去。
    // 只有「步数上限」是可继续的（模型只是这一轮想做的太多了）；重复调用 / 连续失败
    // 说明策略本身卡死，再续跑只是重复烧 token，必须人工介入。
    // meta: { kind: 'steps'|'repeat'|'error' }
    function shouldAutoContinue(task, meta) {
        meta = meta || {};
        var kind = meta.kind || 'steps';
        var max = (task && task.maxAutoContinues) || 3;
        if (kind !== 'steps') {
            return { ok: false, kind: kind, used: task ? (task.autoContinues || 0) : 0, max: max, reason: '护栏因「' + kind + '」中止，自动续跑无意义' };
        }
        if (!task) return { ok: false, kind: kind, used: 0, max: max, reason: '无任务上下文' };
        if (task.status === 'done' || task.status === 'failed') {
            return { ok: false, kind: kind, used: task.autoContinues || 0, max: max, reason: '任务已结束' };
        }
        if (task.stage === 'paused') {
            return { ok: false, kind: kind, used: task.autoContinues || 0, max: max, reason: '任务已暂停' };
        }
        var used = task.autoContinues || 0;
        if (used >= max) {
            return { ok: false, kind: kind, used: used, max: max, reason: '自动续跑已达上限 ' + max + ' 次，转人工' };
        }
        return { ok: true, kind: kind, used: used, max: max, reason: '' };
    }

    // ── 三段式状态机 ──────────────────────────────────────
    // event: { type:'plan', steps:[{id,title}] }
    //        { type:'tool', name, path?, before?, after? }
    //        { type:'toolResult', name, ok, isError, text? }
    //        { type:'verify', evidence:{tests,diagnostics,toolErrors} }
    //        { type:'interrupt' } / { type:'resume' } / { type:'pause' }
    function advance(task, event) {
        event = event || {};
        var type = event.type;

        if (type === 'plan') {
            if (Array.isArray(event.steps)) {
                event.steps.forEach(function (s) {
                    if (s && s.title && !task.steps.some(function (x) { return x.title === s.title; })) addStep(task, s.title);
                });
            }
            task.stage = 'planning';
            touch(task);
            return task;
        }

        if (type === 'tool') {
            if (task.stage === 'planning' || task.stage === 'interrupted' || task.stage === 'paused') {
                task.stage = 'executing';
            }
            if (task.stage === 'executing') {
                var running = nextPendingStep(task);
                if (running && running.status === 'pending') setStep(task, running.id, 'running');
            }
            if (event.path && (event.before !== undefined || event.after !== undefined)) {
                recordChange(task, event.path, event.before, event.after, { op: event.name });
            }
            touch(task);
            return task;
        }

        if (type === 'toolResult') {
            if (event.isError) task.evidence.toolErrors = (task.evidence.toolErrors || 0) + 1;
            // 测试结果直接当证据（run_tests / 明确的 npm test / tsc）
            var ev = evidenceFromToolResult(event.name, event.text, event.ok, event.isError);
            if (ev) {
                if (ev.tests) task.evidence.tests = ev.tests;
                if (ev.diagnostics) task.evidence.diagnostics = ev.diagnostics;
            }
            touch(task);
            return task;
        }

        if (type === 'verify') {
            var verdict = verdictFromEvidence(event.evidence || task.evidence, task);
            task.stage = 'verifying';
            task.lastVerdict = verdict;
            if (verdict.pass) {
                task.stage = 'done';
                task.status = 'done';
                task.endedAt = nowMs();
                task.steps.forEach(function (s) { if (s.status !== 'skipped') s.status = 'done'; });
            } else {
                task.attempts += 1;
                task.notes.push({
                    at: nowMs(),
                    stage: 'verifier',
                    text: '验证未通过：' + verdict.reasons.join('；') + (task.attempts >= task.maxAttempts ? '（已达重试上限，转人工）' : '')
                });
                if (task.attempts >= task.maxAttempts) {
                    task.stage = 'failed';
                    task.status = 'failed';
                    task.endedAt = nowMs();
                } else {
                    task.stage = 'executing';
                }
            }
            touch(task);
            return task;
        }

        if (type === 'guardAbort') {
            // 执行护栏中止 → 已决定自动发「继续」续跑：记一次账，保持任务 running/executing
            task.autoContinues = (task.autoContinues || 0) + 1;
            task.lastAutoContinue = nowMs();
            task.lastGuardReason = String(event.reason || '').slice(0, 300);
            task.notes.push({
                at: nowMs(),
                stage: 'guard',
                text: '执行护栏中止：' + task.lastGuardReason + '；已自动续跑（第 ' +
                    task.autoContinues + '/' + (task.maxAutoContinues || 3) + ' 次）'
            });
            task.stage = task.steps.length ? 'executing' : 'planning';
            task.status = 'running';
            task.resume = null;
            touch(task);
            return task;
        }

        if (type === 'pause') {
            task.stage = 'paused';
            task.status = 'paused';
            touch(task);
            return task;
        }

        if (type === 'interrupt') {
            task.stage = 'interrupted';
            task.status = 'paused';
            task.resume = {
                stage: 'executing',
                nextStep: (nextPendingStep(task) || {}).title || '',
                at: nowMs()
            };
            touch(task);
            return task;
        }

        if (type === 'resume') {
            task.stage = task.steps.length ? 'executing' : 'planning';
            task.status = 'running';
            // 人工「继续」= 新的续跑预算，重置自动续跑计数
            task.autoContinues = 0;
            task.notes.push({ at: nowMs(), stage: 'resume', text: '会话恢复：继续未完成的任务。' + (task.resume && task.resume.nextStep ? ('下一步：' + task.resume.nextStep) : '') });
            task.resume = null;
            touch(task);
            return task;
        }

        if (type === 'finish') {
            task.stage = event.ok === false ? 'failed' : 'done';
            task.status = event.ok === false ? 'failed' : 'done';
            task.endedAt = nowMs();
            touch(task);
            return task;
        }

        return task;
    }

    // 从工具结果里抽证据：run_tests 的输出 / tsc 诊断
    function evidenceFromToolResult(name, text, ok, isError) {
        var s = String(text || '');
        if (name === 'run_tests' || /(^|\s)(npm|pnpm|yarn)\s+(run\s+)?test/.test(s) || /tsc\s+--noEmit/.test(s)) {
            // 兼容两种写法：`12 passed / 3 failed` 与 `pass 12 / fail 3`
            var pick = function (re) { var m = re.exec(s); return m ? Number(m[1] || m[2] || 0) : 0; };
            var failed = pick(/(\d+)\s*(?:failed|失败)\b|(?:fail|failed|失败)\s*[:：]?\s*(\d+)/i);
            var passed = pick(/(\d+)\s*(?:passed|通过)\b|(?:pass|passed|通过)\s*[:：]?\s*(\d+)/i);
            var exitFail = /\bexit\s*[1-9]\d*\b/i.test(s) || (isError === true);
            if (exitFail && failed === 0) failed = 1;
            return { tests: { ok: !exitFail && failed === 0, failed: failed, passed: passed } };
        }
        if (name === 'run_shell' || name === 'run_node') {
            var errs = /\b(\d+)\s*(errors?|错误)\b/i.exec(s);
            if (errs) return { diagnostics: { errors: Number(errs[1]) } };
        }
        return null;
    }

    function verdictFromEvidence(ev, task) {
        ev = ev || {};
        var reasons = [];
        if (ev.tests && ev.tests.failed > 0) reasons.push('测试失败 ' + ev.tests.failed + ' 项');
        if (ev.diagnostics && ev.diagnostics.errors > 0) reasons.push('诊断错误 ' + ev.diagnostics.errors + ' 项');
        if (!reasons.length && ev.tests && ev.tests.ok && ev.tests.passed > 0) reasons.push('测试通过 ' + ev.tests.passed + ' 项');
        var changed = task && task.artifacts ? task.artifacts.length : 0;
        var pass = (ev.tests ? ev.tests.failed === 0 : true) &&
            (ev.diagnostics ? ev.diagnostics.errors === 0 : true);
        if (pass) reasons.unshift('验证通过' + (changed ? ('，涉及 ' + changed + ' 个文件') : ''));
        return { pass: pass, reasons: reasons, at: nowMs() };
    }

    // ── prompt 注入（只改对话尾部，保持前缀缓存命中）──────────
    function stageDirective(task) {
        if (!task) return '';
        var head = '\n\n【任务中心 · ' + task.title + '】阶段：' + task.stage +
            '（第 ' + (task.attempts + 1) + ' 次尝试）';
        if (task.stage === 'planning') {
            return head + '\n先用 todo_write 拆出 3-6 个可验证步骤，再开始执行；不要一步到位地写完整套代码。';
        }
        if (task.stage === 'executing') {
            var step = nextPendingStep(task);
            return head + '\n按计划逐步执行' + (step ? ('，当前步骤：' + step.title) : '') +
                '；每完成一步更新 todo。改动前先读文件，改完不要自行宣布成功，等验证。';
        }
        if (task.stage === 'verifying') {
            return head + '\n执行验证：优先 run_tests（或 tsc --noEmit / 项目自带 test 脚本），把结果作为证据；未通过要修到通过。';
        }
        if (task.stage === 'failed') {
            return head + '\n上一轮验证未通过且已达重试上限：先向用户说明失败原因与已尝试的修复，再询问下一步。';
        }
        return head;
    }

    function resumePrompt(task) {
        if (!task) return '';
        var lines = ['【中断恢复】上次任务未完成（' + task.stage + '），请继续。',
            '目标：' + task.goal];
        if (task.steps.length) {
            lines.push('步骤进度：' + task.steps.map(function (s) { return s.title + '[' + s.status + ']'; }).join('；'));
        }
        if (task.artifacts.length) {
            lines.push('已改动文件：' + task.artifacts.map(function (a) { return a.path + '(+' + a.add + '/-' + a.del + ')'; }).join('、'));
        }
        if (task.notes.length) {
            lines.push('最近反馈：' + task.notes.slice(-2).map(function (n) { return n.text; }).join(' / '));
        }
        return lines.join('\n');
    }

    // ── 汇总（面板/标题用）──────────────────────────────────
    function summarize(task) {
        if (!task) return '';
        var done = task.steps.filter(function (s) { return s.status === 'done'; }).length;
        var add = task.artifacts.reduce(function (n, a) { return n + (a.add || 0); }, 0);
        var del = task.artifacts.reduce(function (n, a) { return n + (a.del || 0); }, 0);
        return task.title + ' · ' + task.stage +
            (task.steps.length ? (' · 步骤 ' + done + '/' + task.steps.length) : '') +
            (task.artifacts.length ? (' · 产物 ' + task.artifacts.length + ' 个 (+' + add + '/-' + del + ')') : '');
    }

    function serialize(task) {
        var copy = JSON.parse(JSON.stringify(task));
        delete copy._dirty;
        return copy;
    }

    function deserialize(json) {
        if (!json || typeof json !== 'object') return null;
        var t = createTask(json.goal || json.title || '');
        Object.assign(t, json);
        t.steps = Array.isArray(json.steps) ? json.steps : [];
        t.artifacts = Array.isArray(json.artifacts) ? json.artifacts : [];
        t.notes = Array.isArray(json.notes) ? json.notes : [];
        t.evidence = json.evidence || { tests: null, diagnostics: null, toolErrors: 0 };
        // 旧任务文件没有自动续跑字段：补默认值（向后兼容）
        if (typeof t.autoContinues !== 'number') t.autoContinues = 0;
        if (typeof t.maxAutoContinues !== 'number' || t.maxAutoContinues <= 0) t.maxAutoContinues = 3;
        if (typeof t.lastAutoContinue !== 'number') t.lastAutoContinue = 0;
        if (typeof t.lastGuardReason !== 'string') t.lastGuardReason = '';
        return t;
    }

    return {
        STAGES: STAGES,
        createTask: createTask,
        addStep: addStep,
        setStep: setStep,
        nextPendingStep: nextPendingStep,
        lineDiff: lineDiff,
        recordChange: recordChange,
        guessKind: guessKind,
        advance: advance,
        shouldAutoContinue: shouldAutoContinue,
        verdictFromEvidence: verdictFromEvidence,
        evidenceFromToolResult: evidenceFromToolResult,
        stageDirective: stageDirective,
        resumePrompt: resumePrompt,
        summarize: summarize,
        serialize: serialize,
        deserialize: deserialize,
        uid: uid
    };
});
