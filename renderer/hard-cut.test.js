/*!
 * hard-cut.test.js — 硬切窗口（Hard-Cut Window）单元测试
 * 运行：node --test renderer/hard-cut.test.js
 *
 * 覆盖：token 估算 / 压力阈值 / 安全边界 / 工作状态抽取 / 交接渲染 /
 *       工作笔记（去重·检索·快照）/ 转录归档检索 / 事件折叠 / 片段定位。
 */
const test = require('node:test');
const assert = require('node:assert');
const HC = require('./assets/js/23-hard-cut.js');

const I = HC._internals;

function sampleConversation() {
  return [
    { role: 'user', content: '把工作台改成「硬切窗口」。记住：不要压缩上下文，必须保留原始目标。' },
    {
      role: 'assistant', content: '',
      tool_calls: [{
        id: 'c1', type: 'function',
        function: { name: 'read_file', arguments: '{"path":"renderer/assets/js/09-chat-store.js"}' }
      }]
    },
    { role: 'tool', tool_call_id: 'c1', content: '文件内容……' },
    { role: 'assistant', content: '已定位到压缩逻辑所在的函数。' },
    { role: 'user', content: '继续，注意绝对不要动 main.js 的端口配置。' }
  ];
}

/* ── token 估算 ────────────────────────────────────────────────────── */

test('countTokens：中文按字计、英文按词根计，且单调', () => {
  const cjk = HC.countTokens('你好世界，这是一段中文');
  const ascii = HC.countTokens('hello world');
  assert.ok(cjk > 0 && ascii > 0);
  assert.ok(HC.countTokens('中文'.repeat(100)) > HC.countTokens('中文'.repeat(10)));
  // 同样字符数，中文的 token 密度应高于英文
  assert.ok(HC.countTokens('中'.repeat(40)) > HC.countTokens('a'.repeat(40)));
});

test('estimateTokens：包含 tool_calls 的额外开销', () => {
  const conv = sampleConversation();
  const total = HC.estimateTokens(conv);
  assert.ok(total > 0);
  assert.ok(total > HC.estimateTokens(conv.slice(0, 1)));
});

/* ── 压力与触发 ────────────────────────────────────────────────────── */

test('shouldCut：达到配置比例即触发，且受 minMessages 约束', () => {
  HC.configure({ limitTokens: 120, ratio: 0.5, minMessages: 2, enabled: true });
  HC.resetUsage();
  const conv = sampleConversation();
  const p = HC.pressure(conv);
  assert.strictEqual(p.limit, 120);
  assert.ok(p.tokens > 0);
  // 阈值 60 tokens：样例对话明显超过
  assert.strictEqual(HC.shouldCut(conv), true);
  // 少于 minMessages 时不切
  assert.strictEqual(HC.shouldCut(conv.slice(0, 1)), false);
  // 关闭硬切后永不触发
  HC.configure({ enabled: false });
  assert.strictEqual(HC.shouldCut(conv), false);
  HC.configure({ enabled: true, limitTokens: 1048576, ratio: 0.85, minMessages: 4 });
});

test('pressure：有真实 usage 时以 prompt_tokens 为基准增量估算', () => {
  HC.configure({ limitTokens: 10000, ratio: 0.5, minMessages: 1 });
  const conv = sampleConversation();
  HC.noteUsage({ prompt_tokens: 6000 }, 3);
  const p = HC.pressure(conv);
  assert.strictEqual(p.basis, 'usage');
  assert.ok(p.tokens >= 6000, '应 >= 上次真实 prompt_tokens');
  assert.strictEqual(p.shouldCut, true); // 6000/10000 = 60% > 50%
  HC.resetUsage();
  assert.strictEqual(HC.pressure(conv).basis, 'estimate');
  HC.configure({ limitTokens: 1048576, ratio: 0.85, minMessages: 4 });
});

/* ── 安全边界 ──────────────────────────────────────────────────────── */

test('isSafeBoundary：tool 结果 / 待配对 tool_calls 不是安全切点', () => {
  assert.strictEqual(HC.isSafeBoundary([]), true);
  assert.strictEqual(HC.isSafeBoundary([{ role: 'user', content: 'x' }]), true);
  assert.strictEqual(HC.isSafeBoundary([{ role: 'assistant', content: 'done' }]), true);
  assert.strictEqual(HC.isSafeBoundary([{ role: 'tool', tool_call_id: 'c1', content: 'r' }]), false);
  assert.strictEqual(HC.isSafeBoundary([{
    role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }]
  }]), false);
});

/* ── 工作状态抽取 ──────────────────────────────────────────────────── */

test('extractConstraints：抓出「不要 / 必须 / 绝对」等硬约束', () => {
  const list = I.extractConstraints(sampleConversation());
  assert.ok(list.length >= 2);
  assert.ok(list.some((s) => s.includes('不要压缩上下文')));
  assert.ok(list.some((s) => s.includes('绝对不要动')));
});

test('extractFiles：从 tool_calls 参数中提取 path', () => {
  const files = I.extractFiles(sampleConversation());
  assert.deepStrictEqual(files, ['renderer/assets/js/09-chat-store.js']);
});

test('buildWorkingState：目标 / 最近指令 / 硬约束 / 文件 / 未完成计划', () => {
  HC.notes.clear();
  const plan = {
    objective: '',
    steps: [
      { content: '实现硬切核心', status: 'in_progress' },
      { content: '跑测试', status: 'pending' },
      { content: '写文档', status: 'completed' }
    ]
  };
  const st = HC.buildWorkingState({ conversation: sampleConversation(), plan, notes: HC.notes });
  assert.ok(st.objective.includes('硬切窗口'));
  assert.ok(st.latestInstruction.includes('继续'));
  assert.ok(st.constraints.length >= 1);
  assert.deepStrictEqual(st.files, ['renderer/assets/js/09-chat-store.js']);
  assert.strictEqual(st.todos.length, 2, 'completed 的步骤不应出现在未完成事项');
  assert.ok(st.stats.messages > 0);
});

test('buildWorkingState：计划里的 objective 优先于首条用户消息', () => {
  const plan = { objective: '计划记录里的目标', steps: [] };
  const st = HC.buildWorkingState({ conversation: sampleConversation(), plan, notes: HC.notes });
  assert.strictEqual(st.objective, '计划记录里的目标');
});

/* ── 交接文本 ──────────────────────────────────────────────────────── */

test('renderHandoff：包含工作状态三件套与历史指针', () => {
  const pointer = { sid: 's-abc', toSeq: 42, messages: 9, ts: Date.UTC(2024, 0, 1), title: '硬切窗口改造' };
  const st = HC.buildWorkingState({ conversation: sampleConversation(), plan: null, notes: HC.notes, pointer });
  const text = HC.renderHandoff(st, pointer);
  assert.ok(text.startsWith('<hard-cut-handoff>'));
  assert.ok(text.includes('【工作状态 / Working State】'));
  assert.ok(text.includes('【历史指针 / Transcript Pointer】'));
  assert.ok(text.includes('s-abc'));
  assert.ok(text.includes('search_transcript'));
  assert.ok(text.includes('read_transcript'));
  assert.ok(text.includes('目标：'));
  assert.ok(text.includes('硬约束'));
});

/* ── 工作笔记 ──────────────────────────────────────────────────────── */

test('notes：写入 / 去重 / 检索 / 快照 / 清空', () => {
  HC.notes.clear();
  const a = HC.notes.add('决定：所有压缩入口改为硬切', { kind: 'decision' });
  assert.ok(a && a.id);
  HC.notes.add('决定：所有压缩入口改为硬切', { kind: 'decision' }); // 重复
  assert.strictEqual(HC.notes.list().length, 1, '同样文本应去重');

  HC.notes.add('相关文件在 renderer/assets/js', { kind: 'fact', pinned: true });
  HC.notes.add('待办：补迁移文档', { kind: 'todo' });

  const hit = HC.notes.search('压缩');
  assert.strictEqual(hit.length, 1);
  assert.ok(hit[0].text.includes('硬切'));

  const snap = HC.notes.snapshot(5);
  assert.ok(snap.includes('相关文件'));
  assert.ok(snap.includes('待办'));

  HC.notes.clear();
  assert.strictEqual(HC.notes.list().length, 0);
});

/* ── 转录归档与检索（无 Electron 时的本地降级路径）────────────────── */

test('archive + transcripts.search：归档后可关键词检索', async () => {
  const conv = sampleConversation();
  const pointer = HC.archive(conv);
  assert.strictEqual(pointer.ok, true);
  assert.ok(pointer.localId, '无 sessionLog 时应降级为本地归档');

  const res = await HC.transcripts.search('端口配置', { limit: 5 });
  assert.strictEqual(res.ok, true);
  assert.ok(res.results.length >= 1);
  const formatted = HC.formatSearchResults(res);
  assert.ok(formatted.includes('端口配置') || formatted.includes('找到'));
});

test('foldTranscript：事件流 → 消息视图', () => {
  const msgs = I.foldTranscript([
    { type: 'session.create', sid: 's1' },
    { type: 'msg.append', msgs: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] },
    { type: 'msg.truncate', toLen: 1 },
    { type: 'msg.append', msgs: [{ role: 'assistant', content: 'c' }] }
  ]);
  assert.deepStrictEqual(msgs.map((m) => m.text), ['a', 'c']);
  assert.deepStrictEqual(msgs.map((m) => m.index), [1, 2]);
});

/* ── 片段定位 ──────────────────────────────────────────────────────── */

test('scoreText / makeSnippet：命中打分与窗口截取', () => {
  assert.ok(I.scoreText('这里提到端口配置和 main.js', ['端口', '端口']) > I.scoreText('无关内容', ['端口']));
  const snip = I.makeSnippet('a'.repeat(100) + '关键关键词' + 'b'.repeat(100), ['关键'], 40);
  assert.ok(snip.includes('关键'));
});
