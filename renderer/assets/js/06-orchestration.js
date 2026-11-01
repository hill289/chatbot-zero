        // ══════════════════════════════════════════════════════════════
        // planStore —— 长任务的「计划记录」一等公民（防跑偏）
        //   · 单一事实来源：todo_write 写入；localStorage 持久化（跨刷新/跨会话保留）
        //   · 每轮把计划快照注入对话尾部（不动 system/tools → 前缀缓存不失效）
        //   · 上下文压缩、reopen_session 之后仍保留并强制重新注入
        //   · 记录最近一次执行护栏（loop guard）中止事件，下一轮提醒模型改变策略
        // ══════════════════════════════════════════════════════════════
        const planStore = {
            KEY: 'planStore',
            objective: '',
            steps: [],          // [{ content, status, activeForm }]
            updatedAt: 0,
            version: 0,         // 每次计划变化 +1（决定是否需要重新注入上下文）
            lastTrip: null,     // { reason, at } —— 最近一次护栏中止记录
            paused: false,      // 暂停把计划注入上下文（用户开关）
            expanded: false,    // 计划条是否展开步骤列表（用户开关）
            _injectedVersion: -1,

            init() {
                const saved = persist.load(this.KEY, null);
                if (saved && typeof saved === 'object') {
                    this.objective = typeof saved.objective === 'string' ? saved.objective : '';
                    this.steps = Array.isArray(saved.steps) ? saved.steps.filter(function (s) {
                        return s && typeof s.content === 'string';
                    }) : [];
                    this.updatedAt = Number(saved.updatedAt) || 0;
                    this.lastTrip = (saved.lastTrip && typeof saved.lastTrip === 'object') ? saved.lastTrip : null;
                    this.paused = !!saved.paused;
                    this.expanded = !!saved.expanded;
                    this.version = 1; // 载入后先注入一次，让模型「接上」既有计划
                }
                return this;
            },
            save() {
                persist.save(this.KEY, {
                    objective: this.objective,
                    steps: this.steps,
                    updatedAt: this.updatedAt,
                    lastTrip: this.lastTrip,
                    paused: this.paused,
                    expanded: this.expanded
                });
            },
            setObjective(text) {
                const t = (text == null ? '' : String(text)).trim();
                if (t && t !== this.objective) { this.objective = t.slice(0, 2000); this.bump(); }
            },
            setSteps(steps) {
                this.steps = Array.isArray(steps) ? steps.map(function (s) {
                    return { content: s.content, status: s.status, activeForm: s.activeForm || s.content };
                }) : [];
                this.updatedAt = Date.now();
                this.bump();
            },
            bump() {
                this.version++;
                this.save();
                try { renderPlanBar(); } catch (_) {}
            },
            hasActive() { return this.steps.length > 0; },
            progress() {
                const total = this.steps.length;
                const done = this.steps.filter(function (s) { return s.status === 'completed'; }).length;
                return { total: total, done: done };
            },
            clear() {
                this.steps = [];
                this.objective = '';
                this.lastTrip = null;
                this.updatedAt = Date.now();
                this.bump();
            },
            noteTrip(reason) {
                this.lastTrip = { reason: String(reason || ''), at: Date.now() };
                this.save();
            },
            clearTrip() { if (this.lastTrip) { this.lastTrip = null; this.save(); } },
            // 生成注入给模型的计划快照（简洁、可读）
            snapshotText() {
                const lines = [];
                if (this.objective) lines.push('目标: ' + this.objective);
                this.steps.forEach(function (s, i) {
                    const mark = s.status === 'completed' ? '[x]' : s.status === 'in_progress' ? '[>]' : '[ ]';
                    lines.push((i + 1) + '. ' + mark + ' ' + s.content);
                });
                const p = this.progress();
                if (p.total) lines.push('进度: ' + p.done + '/' + p.total + ' 已完成');
                if (this.lastTrip) {
                    lines.push('⚠️ 上一轮因疑似跑偏被「执行护栏」中止：' + this.lastTrip.reason + '（请勿重复，改用其它方式或先总结现状）');
                }
                return lines.join('\n');
            },
            // 需要时向对话尾部注入计划提醒；返回是否注入。
            // 只在计划版本变化（或强制）时注入，避免每轮重复刷屏。
            injectInto(conversation) {
                if (this.paused) return false; // 用户暂停了计划注入
                if (!Array.isArray(conversation) || conversation.length === 0) return false;
                if (!this.hasActive() && !this.lastTrip) return false;
                if (this._injectedVersion === this.version) return false;
                const body = this.snapshotText();
                if (!body) return false;
                // 移除上一轮注入的旧计划提醒（被本次取代），避免历史累积
                for (let i = conversation.length - 1; i >= 0; i--) {
                    const m = conversation[i];
                    if (m && m._sysNote && m._sysNoteKind === 'plan') conversation.splice(i, 1);
                }
                conversation.push({
                    role: 'user',
                    content: '<plan-reminder>\n（系统自动注入的计划快照；请始终围绕它推进，不要偏离目标。完成一步后调用 todo_write 更新状态）\n' + body + '\n</plan-reminder>',
                    _sysNote: true,
                    _sysNoteKind: 'plan',
                    _sysNoteText: '计划已同步到上下文（长任务防跑偏）\n' + body
                });
                this._injectedVersion = this.version;
                return true;
            },
            forceReinject() { this._injectedVersion = -1; },
            // 暂停 / 恢复「把计划注入上下文」。恢复时强制下一轮重新注入
            togglePaused() {
                this.paused = !this.paused;
                if (!this.paused) this.forceReinject();
                this.save();
                return this.paused;
            },
            setExpanded(v) { this.expanded = !!v; this.save(); },
            // 点击步骤 → 设为进行中（自动把其它进行中降回 pending；已在进行中则取消回 pending）。
            // 变更会 bump 版本 → 下一轮把更新后的计划重新注入上下文。
            setStepStatus(index, status) {
                const step = this.steps[index];
                if (!step) return;
                if (status === 'in_progress') {
                    const alreadyDoing = step.status === 'in_progress';
                    this.steps.forEach(function (s, i) {
                        if (i === index) s.status = alreadyDoing ? 'pending' : 'in_progress';
                        else if (s.status === 'in_progress') s.status = 'pending';
                    });
                } else {
                    step.status = status;
                }
                this.updatedAt = Date.now();
                this.bump();
            }
        };
        planStore.init();

        // 计划条 UI（输入框上方；无计划时隐藏）
        function renderPlanBar() {
            const bar = document.getElementById('planBar');
            if (!bar) return;
            if (!planStore.hasActive()) {
                bar.style.display = 'none';
                bar.innerHTML = '';
                return;
            }
            const p = planStore.progress();
            const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
            const stepLines = planStore.steps.map(function (s, i) {
                const mark = s.status === 'completed' ? '[x]' : s.status === 'in_progress' ? '[>]' : '[ ]';
                return (i + 1) + '. ' + mark + ' ' + s.content;
            }).join('\n');
            const trip = planStore.lastTrip
                ? '<span class="plan-trip" title="' + escapeHtml(planStore.lastTrip.reason || '') + '">⚠️ 护栏已中止过一轮</span>'
                : '';
            const obj = planStore.objective
                ? '<span class="plan-obj" title="' + escapeHtml(planStore.objective) + '">目标：' + escapeHtml(planStore.objective) + '</span>'
                : '';
            const paused = !!planStore.paused;
            const expanded = !!planStore.expanded;
            // 展开时的步骤清单
            let stepsHtml = '';
            if (expanded) {
                stepsHtml = planStore.steps.map(function (s, i) {
                    const mark = s.status === 'completed' ? '✔' : s.status === 'in_progress' ? '▶' : '○';
                    const cls = s.status === 'completed' ? 'done' : s.status === 'in_progress' ? 'doing' : 'todo';
                    const tip = s.status === 'in_progress' ? '点击取消「进行中」' : '点击设为「进行中」';
                    return '<div class="ps-item ' + cls + '" data-step-index="' + i + '" title="' + tip + '">' +
                        '<span class="ps-mark">' + mark + '</span>' +
                        '<span class="ps-text">' + (i + 1) + '. ' + escapeHtml(s.content) + '</span></div>';
                }).join('');
            }
            bar.style.display = 'flex';
            bar.classList.toggle('plan-paused', paused);
            bar.innerHTML =
                '<span class="plan-title" title="' + escapeHtml(stepLines) + '">🧭 计划' + (paused ? '（注入已暂停）' : '') + '</span>' +
                '<span class="plan-progress">' + p.done + '/' + p.total + '</span>' +
                '<span class="plan-track"><i style="width:' + pct + '%"></i></span>' +
                obj + trip +
                '<button class="plan-expand" title="' + (expanded ? '收起步骤列表' : '展开步骤列表') + '">' + (expanded ? '▾' : '▸') + '</button>' +
                '<button class="plan-pause" title="' + (paused ? '恢复把计划注入上下文' : '暂停把计划注入上下文') + '">' + (paused ? '▶' : '⏸') + '</button>' +
                '<button class="plan-clear" title="清除计划">✕</button>' +
                (expanded ? '<div class="plan-steps">' + (stepsHtml || '<div class="ps-item todo"><span class="ps-text">（暂无步骤）</span></div>') + '</div>' : '');
            const btnClear = bar.querySelector('.plan-clear');
            if (btnClear) btnClear.addEventListener('click', function () { planStore.clear(); renderPlanBar(); });
            const btnExpand = bar.querySelector('.plan-expand');
            if (btnExpand) btnExpand.addEventListener('click', function () { planStore.setExpanded(!planStore.expanded); renderPlanBar(); });
            const btnPause = bar.querySelector('.plan-pause');
            if (btnPause) btnPause.addEventListener('click', function () {
                const pausedNow = planStore.togglePaused();
                renderPlanBar();
                try { snackbarStore.showInfoMessage(pausedNow ? '已暂停把计划注入上下文' : '已恢复计划注入（下一轮生效）'); } catch (_) {}
            });
            // 点击某步 → 设为「进行中」（自动降级其它进行中；再点一次取消）
            bar.querySelectorAll('.plan-steps .ps-item[data-step-index]').forEach(function (el) {
                el.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    const idx = parseInt(el.getAttribute('data-step-index'), 10);
                    if (!isFinite(idx)) return;
                    planStore.setStepStatus(idx, 'in_progress');
                    renderPlanBar();
                });
            });
        }

        // ══════════════════════════════════════════════════════════════
        // createLoopGuard —— 执行护栏（防长任务跑偏 / 死循环 / 重复失败）
        //   · 步数上限：单次请求最多 N 轮工具调用
        //   · 重复调用：连续相同 (name+args) 达软阈值→提醒，硬阈值→中止
        //   · 重复失败：同一调用连续失败达上限→中止
        //   · 中止时保留计划，并记入 planStore.lastTrip 供下一轮提醒
        // ══════════════════════════════════════════════════════════════
        function createLoopGuard(opts) {
            // 阈值可覆盖：chatbotStore.loopGuard（可在配置 JSON / localStorage 里微调）
            let cfg = {};
            try { if (typeof chatbotStore !== 'undefined' && chatbotStore && chatbotStore.loopGuard) cfg = chatbotStore.loopGuard; } catch (_) {}
            const o = Object.assign({
                maxSteps: 30,      // 单轮最多工具调用轮次
                softRepeat: 3,     // 连续相同调用 ≥ 该值 → 提醒
                hardRepeat: 5,     // 连续相同调用 ≥ 该值 → 中止
                maxErrorRepeat: 3  // 同一调用连续失败 ≥ 该值 → 中止
            }, cfg, opts || {});
            return {
                opts: o,
                steps: 0,
                _lastSig: null,
                _repeat: 0,
                _lastErrSig: null,
                _errRepeat: 0,
                begin() {
                    this.steps = 0; this._lastSig = null; this._repeat = 0;
                    this._lastErrSig = null; this._errRepeat = 0;
                },
                sigOf(toolCalls) {
                    return (toolCalls || []).map(function (tc) {
                        const fn = (tc && tc.function) || {};
                        return (fn.name || '') + '|' + String(fn.arguments == null ? '' : fn.arguments);
                    }).join(' && ');
                },
                names(toolCalls) {
                    return (toolCalls || []).map(function (tc) {
                        return (tc && tc.function && tc.function.name) || '?';
                    }).join(', ');
                },
                // 执行「之前」判定：allow | nudge | stop
                inspect(toolCalls) {
                    if (this.steps >= o.maxSteps) {
                        return { action: 'stop', reason: '达到单轮工具调用上限（' + o.maxSteps + ' 轮），已自动中止以防长任务跑偏。' };
                    }
                    const sig = this.sigOf(toolCalls);
                    if (sig && sig === this._lastSig) this._repeat++; else { this._lastSig = sig; this._repeat = 1; }
                    if (this._repeat >= o.hardRepeat) {
                        return { action: 'stop', reason: '连续 ' + this._repeat + ' 次完全相同的工具调用（' + this.names(toolCalls) + '），疑似陷入循环，已自动中止。' };
                    }
                    if (this._repeat >= o.softRepeat) {
                        return { action: 'nudge', reason: '检测到重复调用（' + this.names(toolCalls) + '，第 ' + this._repeat + ' 次）' };
                    }
                    return { action: 'allow' };
                },
                // 执行「之后」累计：返回 true 表示「连续失败」已达上限、应中止
                commit(toolCalls, lastError) {
                    this.steps++;
                    const sig = this.sigOf(toolCalls);
                    if (lastError) {
                        if (sig === this._lastErrSig) this._errRepeat++; else { this._lastErrSig = sig; this._errRepeat = 1; }
                    } else {
                        this._lastErrSig = null; this._errRepeat = 0;
                    }
                    return this._errRepeat >= o.maxErrorRepeat;
                }
            };
        }

        async function delete_file(params) {
            const file_path = params["file_path"];
            const file_type = params["file_type"];

            if (typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready) {
                // Node mode: use almostnode FS
                const FS = nodeRuntime.FS;
                function deleteRecursive(dirPath) {
                    try {
                        const items = FS.readdir(dirPath);
                        for (const item of items) {
                            if (item === '.' || item === '..') continue;
                            const full = dirPath.endsWith('/') ? dirPath + item : dirPath + '/' + item;
                            const stat = FS.stat(full);
                            if (FS.isDir(stat.mode)) {
                                deleteRecursive(full);
                            } else {
                                FS.unlink(full);
                            }
                        }
                        FS.rmdir(dirPath);
                    } catch (e) {
                        // If rmdir fails (non-empty), recursively clean then retry
                        try {
                            const items = FS.readdir(dirPath);
                            for (const item of items) {
                                if (item === '.' || item === '..') continue;
                                const full = dirPath.endsWith('/') ? dirPath + item : dirPath + '/' + item;
                                try { FS.unlink(full); } catch (_) { deleteRecursive(full); }
                            }
                            FS.rmdir(dirPath);
                        } catch (_) {}
                    }
                }
                try {
                    if (file_type === 'folder') {
                        deleteRecursive(file_path);
                    } else {
                        FS.unlink(file_path);
                    }
                    await pgpySyncMount(false);
                    // 磁盘真实文件/目录的删除已由 vfs 唯一入口钩子(unlinkSync/rmdirSync)处理
                    const retcontent = "Deleted " + file_path + " successfully.";
                    return "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
                } catch (e) {
                    const retcontent = "Error deleting " + file_path + ": ";
                    return "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
                }
            }
            const retcontent = "Error deleting " + file_path + ": ";
            return "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
        }

