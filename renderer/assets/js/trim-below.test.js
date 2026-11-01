/*!
 * trim-below.test.js — 回归测试：「删除某个工具对话之后的所有消息并继续」
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   A. 12-render.js · trimConversationAfterGroup()（卡片上的 ⏭️ 动作）
 *      ① 只保留指定工具分组（含该组的调用 + 全部结果），删除其后的所有消息；
 *      ② 生成中 / 仍有工具在 await → 拒绝（避免与流式追加打架、避免留下孤立 tool 消息）；
 *      ③ 该工具之后已无消息 / 不是工具组 → 提示且不改动；
 *      ④ 用户取消确认 → 不改动；
 *      ⑤ 默认（willContinue）→ 截断后调用 messageStore.continueRun()；
 *      ⑥ 任何一次成功截断都会落盘（historyStore.save）；
 *      ⑦ 「删除并继续」会把输入框里已写好的新内容（文字 + 图片）带进 continueRun()；
 *      ⑪-⑭ 多 tab 工具组：以「当前选中的 tab」为界（含同组后续 tab 的调用/结果），
 *           并把 tool_calls 裁到「有结果 / 边界调用」，不留悬空调用。
 *   B. 09-chat-store.js · continueRun({userText, images}) / _appendPendingUserInput()
 *      ⑧ 新输入作为一条 user 消息追加到截断处之后，再继续生成；
 *      ⑨ 多模态：文字 + 图片按 image_url 组装，且消费后清空输入框/附件；
 *      ⑩ 空对话 + 仅有新输入 → 不走 import，直接以输入开跑。
 * 运行： node renderer/assets/js/trim-below.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

/* ───────────────────────── A. 12-render.js ───────────────────────── */

function loadRender(stubs) {
    const src = fs.readFileSync(path.join(__dirname, '12-render.js'), 'utf8');
    // 注意：renderConversation 是脚本内部声明的函数，会「遮蔽」同名参数，
    // 因此先用 __qc 传入替身，再在函数体末尾把它赋给 renderConversation（函数声明绑定可写）。
    const body = src + '\n;renderConversation = __qc;' +
        '\n;return { trimConversationAfterGroup: trimConversationAfterGroup, groupMessages: groupMessages };';
    const fn = new Function(
        '__qc', 'window', 'document', 'navigator', 'globalThis',
        'messageStore', 'historyStore', 'snackbarStore', 'languageStore', 'settingStore',
        body
    );
    return fn(
        stubs.renderConversation, stubs.window, stubs.document, stubs.navigator, {},
        stubs.messageStore, stubs.historyStore, stubs.snackbarStore,
        { locale: 'zhHans' }, { avatarSize: 30 }
    );
}

function makeStubs(opts) {
    opts = opts || {};
    const calls = { render: 0, save: 0, info: [], warn: [], success: [], continueRun: [] };
    const messageStore = {
        generating: !!opts.generating,
        _runningToolId: opts.runningToolId || null,
        _toolTabActive: {},
        pendingImages: (opts.pendingImages || []).slice(),
        conversation: opts.conversation || [],
        continueRun: function (o) { calls.continueRun.push(o || {}); }
    };
    // 输入框：默认空；opts.input 可预置内容
    const inputEl = { value: opts.input || '' };
    const stubs = {
        window: { addEventListener: function () {}, confirm: function () { return opts.confirm !== false; }, scrollTo: function () {} },
        document: {
            getElementById: function (id) { return id === 'userInput' ? inputEl : null; },
            querySelectorAll: function () { return []; }, querySelector: function () { return null; },
            addEventListener: function () {}, documentElement: { scrollHeight: 0 }
        },
        navigator: { clipboard: { writeText: function () {} } },
        messageStore: messageStore,
        historyStore: { save: function () { calls.save++; } },
        snackbarStore: {
            showInfoMessage: function (m) { calls.info.push(m); },
            showWarningMessage: function (m) { calls.warn.push(m); },
            showSuccessMessage: function (m) { calls.success.push(m); }
        },
        renderConversation: function () { calls.render++; }
    };
    return { stubs: stubs, calls: calls, messageStore: messageStore, inputEl: inputEl };
}

// 典型对话：user / 工具组（assistant.tool_calls + tool 结果）/ assistant 总结 / user / 未完成的工具组
function baseConversation() {
    return [
        { role: 'user', content: '把 a.txt 读出来' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'hello' },
        { role: 'assistant', content: '文件内容是 hello' },
        { role: 'user', content: '再改一下 b.txt' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't2', function: { name: 'write_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't2', content: 'ok' },
        { role: 'assistant', content: '改好了' }
    ];
}

/* ───────────────────────── B. 09-chat-store.js ───────────────────────── */

function loadChatStore(stubs) {
    const src = fs.readFileSync(path.join(__dirname, '09-chat-store.js'), 'utf8');
    const body = src + '\n;return messageStore;';
    const fn = new Function(
        'document', 'importHistoryJsonData', 'snackbarStore', 'updateInputIcon', 'historyStore',
        'renderConversation', 'renderAttachBar', 'planStore', 'sessionLog', 'askUserStore', 'stickToBottom',
        body
    );
    return fn(
        stubs.document, stubs.importHistoryJsonData, stubs.snackbarStore, function () {},
        stubs.historyStore, stubs.renderConversation, function () {}, { clear: function () {} },
        null, { cancel: function () {} }, true
    );
}

function makeChatStubs(opts) {
    opts = opts || {};
    const calls = { import: 0, save: 0, render: 0, info: [], warn: [], success: [], error: [], start: 0, attachBar: 0 };
    const inputEl = { value: opts.input || '' };
    const stubs = {
        document: { getElementById: function (id) { return id === 'userInput' ? inputEl : null; } },
        snackbarStore: {
            showInfoMessage: function (m) { calls.info.push(m); },
            showWarningMessage: function (m) { calls.warn.push(m); },
            showSuccessMessage: function (m) { calls.success.push(m); },
            showErrorMessage: function (m) { calls.error.push(m); }
        },
        historyStore: { save: function () { calls.save++; } },
        renderConversation: function () { calls.render++; },
        importHistoryJsonData: function (data) {
            calls.import++;
            // 模拟真实 import：把导入内容替换成当前对话（深拷贝）
            stubs.__store.conversation = JSON.parse(JSON.stringify(data));
        }
    };
    return { stubs: stubs, calls: calls, inputEl: inputEl };
}

// 「当前选中的 tab」替身：卡片上 .tool-group-tabs .tool-tab.active 的 data-tab = "tg-<组>-<条目>"
function makeCard(tabId) {
    return {
        querySelector: function (sel) {
            if (sel.indexOf('.tool-tab.active') >= 0 && tabId) {
                return { getAttribute: function () { return tabId; } };
            }
            return null;
        }
    };
}

// 多 tab 工具组：assistant 一次请求两个工具（tab: call A / call B），随后两条 tool 结果（tab: result A / result B）
function multiTabConversation() {
    return [
        { role: 'user', content: '批量改两个文件' },
        { role: 'assistant', content: '', tool_calls: [
            { id: 'A', function: { name: 'read_file', arguments: '{"path":"a"}' } },
            { id: 'B', function: { name: 'read_file', arguments: '{"path":"b"}' } }
        ] },
        { role: 'tool', tool_call_id: 'A', content: 'aaa' },
        { role: 'tool', tool_call_id: 'B', content: 'bbb' },
        { role: 'assistant', content: '两个文件都读完了' },
        { role: 'user', content: '再总结一下' }
    ];
}

/* ───────────────────────── 测试主体 ───────────────────────── */

(async function main() {
    group('① 截断范围：只保留指定工具组（含调用 + 全部结果），删除其后所有消息');
    {
        const { stubs, calls, messageStore } = makeStubs({ conversation: baseConversation() });
        const R = loadRender(stubs);
        const groups = R.groupMessages(messageStore.conversation);
        eq(groups.map(g => g.group), ['user', 'tool', 'assistant', 'user', 'tool', 'assistant'], '分组结构符合预期');
        const r = R.trimConversationAfterGroup(1, false); // 第 2 组 = 第一个工具组
        eq(r, true, '返回 true');
        eq(messageStore.conversation.length, 3, '只保留到该工具组结束（3 条）');
        eq(messageStore.conversation.map(m => m.role), ['user', 'assistant', 'tool'], '尾部是工具结果，可直接继续');
        eq(calls.save, 1, '落盘一次（historyStore.save）');
        eq(calls.render, 1, '重绘一次');
        eq(calls.continueRun.length, 0, '未触发继续对话');
        ok(calls.success.length === 1, '提示「已删除 N 条」');
    }

    group('② 删除并继续（默认 willContinue，无新输入）');
    {
        const { stubs, calls, messageStore } = makeStubs({ conversation: baseConversation() });
        const R = loadRender(stubs);
        R.trimConversationAfterGroup(4, true); // 第 5 组 = 第二个工具组
        eq(messageStore.conversation.length, 7, '保留到第二个工具组结束（7 条）');
        await new Promise(r => setTimeout(r, 5));
        eq(calls.continueRun.length, 1, '截断后触发 continueRun');
        eq(calls.continueRun[0].userText, '', '没有新输入 → userText 为空');
        eq((calls.continueRun[0].images || []).length, 0, '没有新输入 → images 为空');
    }

    group('③ 生成中 → 拒绝');
    {
        const conv = baseConversation();
        const { stubs, calls, messageStore } = makeStubs({ conversation: conv, generating: true });
        const R = loadRender(stubs);
        eq(R.trimConversationAfterGroup(1, false), false, '返回 false');
        eq(messageStore.conversation.length, 8, '对话未被改动');
        eq(calls.save, 0, '未落盘');
        ok(calls.warn.length === 1, '给出「请先停止生成」提示');
    }

    group('④ 仍有工具在 await → 拒绝（避免迟到结果续成孤立 tool 消息）');
    {
        const { stubs, calls, messageStore } = makeStubs({ conversation: baseConversation(), runningToolId: 't2' });
        const R = loadRender(stubs);
        eq(R.trimConversationAfterGroup(1, false), false, '返回 false');
        eq(messageStore.conversation.length, 8, '对话未被改动');
        eq(calls.save, 0, '未落盘');
        ok(/仍有工具调用在执行/.test(calls.warn[0] || ''), '给出「工具执行中」提示');
    }

    group('⑤ 该工具之后已无消息 / 不是工具组 → 提示且不改动');
    {
        // 让对话「以工具组结尾」：再点删除就无事可做
        const conv = baseConversation().slice(0, 7); // 去掉末尾的 assistant「改好了」
        const { stubs, calls, messageStore } = makeStubs({ conversation: conv });
        const R = loadRender(stubs);
        const groups = R.groupMessages(messageStore.conversation);
        eq(groups.map(g => g.group), ['user', 'tool', 'assistant', 'user', 'tool'], '末组是工具组');
        eq(R.trimConversationAfterGroup(4, false), false, '最后一个工具组之后没有消息 → false');
        eq(R.trimConversationAfterGroup(2, false), false, '非工具分组（assistant）→ false');
        eq(messageStore.conversation.length, 7, '对话未被改动');
        eq(calls.save, 0, '未落盘');
        ok(/没有可删除的消息/.test(calls.info[0] || ''), '给出「没有可删除的消息」提示');
    }

    group('⑥ 用户取消确认 → 不改动');
    {
        const { stubs, calls, messageStore } = makeStubs({ conversation: baseConversation(), confirm: false });
        const R = loadRender(stubs);
        eq(R.trimConversationAfterGroup(1, false), false, '返回 false');
        eq(messageStore.conversation.length, 8, '对话未被改动');
        eq(calls.save, 0, '未落盘');
    }

    group('⑦ 「删除并继续」把输入框里的新内容带进 continueRun');
    {
        const { stubs, calls, messageStore, inputEl } = makeStubs({
            conversation: baseConversation(),
            input: '  顺便把 b.txt 的改动写成三点总结  ',
            pendingImages: ['data:image/png;base64,AAA']
        });
        const R = loadRender(stubs);
        eq(R.trimConversationAfterGroup(1, true), true, '返回 true');
        eq(messageStore.conversation.length, 3, '先截断（3 条）');
        await new Promise(r => setTimeout(r, 5));
        eq(calls.continueRun.length, 1, '触发 continueRun');
        eq(calls.continueRun[0].userText, '顺便把 b.txt 的改动写成三点总结', '文本去掉首尾空白后带入');
        eq(calls.continueRun[0].images, ['data:image/png;base64,AAA'], '图片附件一并带入');
        eq(inputEl.value, '  顺便把 b.txt 的改动写成三点总结  ', '点「删除并继续」不改写输入框（由 continueRun 消费时再清）');
    }

    group('⑧ continueRun：新输入追加为 user 消息后再继续生成');
    {
        const { stubs, calls, inputEl } = makeChatStubs({ input: '请把结果整理成三点' });
        const store = loadChatStore(stubs);
        stubs.__store = store;
        store.conversation = [
            { role: 'user', content: '读一下 a.txt' },
            { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 't1', content: 'hello' }
        ];
        store.pendingImages = [];
        let started = 0;
        store.startInference = async function () { started++; };
        await store.continueRun({ userText: '请把结果整理成三点', images: [] });
        eq(started, 1, '继续生成被触发一次');
        const last = store.conversation[store.conversation.length - 1];
        eq(last.role, 'user', '末尾是新的 user 消息');
        eq(last.content, '请把结果整理成三点', '内容 = 输入的新内容');
        eq(store.conversation.length, 4, '原 3 条 + 新输入 1 条');
        eq(inputEl.value, '', '输入框已被消费清空');
        ok(calls.save >= 1, '带入后落盘');
    }

    group('⑨ continueRun：文字 + 图片按 image_url 组装');
    {
        const { stubs } = makeChatStubs({});
        const store = loadChatStore(stubs);
        stubs.__store = store;
        store.conversation = [
            { role: 'user', content: '看看这张图' },
            { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 't1', content: 'ok' }
        ];
        store.pendingImages = ['data:image/png;base64,BBB'];
        store.startInference = async function () {};
        await store.continueRun({ userText: '照着这张图改', images: ['data:image/png;base64,BBB'] });
        const last = store.conversation[store.conversation.length - 1];
        eq(last.role, 'user', '末尾是 user 消息');
        eq(last.content, [
            { type: 'text', text: '照着这张图改' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }
        ], '多模态 content 结构正确');
        eq(store.pendingImages.length, 0, '待发送附件已清空');
    }

    group('⑩ continueRun：空对话 + 仅有新输入 → 不 import，直接开跑');
    {
        const { stubs, calls } = makeChatStubs({});
        const store = loadChatStore(stubs);
        stubs.__store = store;
        store.conversation = [];
        let started = 0;
        store.startInference = async function () { started++; };
        await store.continueRun({ userText: '从零开始写个 README', images: [] });
        eq(calls.import, 0, '未走 importHistoryJsonData');
        eq(started, 1, '直接开始生成');
        eq(store.conversation.length, 1, '对话里只有这条新输入');
        eq(store.conversation[0].role, 'user', '是 user 消息');
    }

    group('⑪ 多 tab 工具组：以「选中的结果 tab A」为界，同组后面的 tool B 一并删除');
    {
        const { stubs, calls, messageStore } = makeStubs({ conversation: multiTabConversation() });
        const R = loadRender(stubs);
        const groups = R.groupMessages(messageStore.conversation);
        eq(groups.map(g => g.group), ['user', 'tool', 'assistant', 'user'], '第 2 组 = 多 tab 工具组');
        const card = makeCard('tg-1-2');                // items: 0=callA 1=callB 2=resultA 3=resultB
        eq(R.trimConversationAfterGroup(1, true, card), true, '返回 true');
        eq(messageStore.conversation.map(m => m.role), ['user', 'assistant', 'tool'], '只保留到 result A（3 条）');
        eq(messageStore.conversation[2].tool_call_id, 'A', '留下的是 A 的结果');
        eq(messageStore.conversation[1].tool_calls.map(tc => tc.id), ['A'], 'tool_calls 裁到只含 A（不留悬空调用 B）');
        await new Promise(r => setTimeout(r, 5));
        eq(calls.continueRun.length, 1, '触发 continueRun');
    }

    group('⑫ 多 tab：以「调用 tab A」为界 → 只留 call A（继续时会重跑 A）');
    {
        const { stubs, messageStore } = makeStubs({ conversation: multiTabConversation() });
        const R = loadRender(stubs);
        R.trimConversationAfterGroup(1, false, makeCard('tg-1-0'));
        eq(messageStore.conversation.map(m => m.role), ['user', 'assistant'], '只保留到 assistant.tool_calls');
        eq(messageStore.conversation[1].tool_calls.map(tc => tc.id), ['A'], 'tool_calls 只留 A');
        ok(!messageStore.conversation.some(m => m.role === 'tool'), '所有 tool 结果（含 B）已删除');
    }

    group('⑬ 多 tab：以「结果 tab B（最后一个）」为界 → 等价整组之后');
    {
        const { stubs, messageStore } = makeStubs({ conversation: multiTabConversation() });
        const R = loadRender(stubs);
        R.trimConversationAfterGroup(1, false, makeCard('tg-1-3'));
        eq(messageStore.conversation.length, 4, '保留整组（4 条）');
        eq(messageStore.conversation[1].tool_calls.map(tc => tc.id), ['A', 'B'], 'tool_calls 保持完整');
    }

    group('⑭ 无 active tab / 卡片缺失 → 视为最后一个 tab');
    {
        const { stubs, messageStore } = makeStubs({ conversation: multiTabConversation() });
        const R = loadRender(stubs);
        R.trimConversationAfterGroup(1, false, makeCard(null));
        eq(messageStore.conversation.length, 4, '保留整组');
        R.trimConversationAfterGroup(0, false, null);   // 第 1 组是 user，非工具组
        eq(messageStore.conversation.length, 4, '非工具组不处理');
    }

    group('⑮ 新输入不会插进 tool 结果之间：先补执行工具 → 再追加 user 消息');
    {
        const { stubs } = makeChatStubs({});
        const store = loadChatStore(stubs);
        stubs.__store = store;
        store.conversation = [
            { role: 'user', content: '读一下 a.txt' },
            { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] }
        ];  // 停在「已请求工具、尚未执行」处
        let started = 0;
        store.startInference = async function () { started++; };
        // 替身：执行工具时把结果 push 进对话（与真实 runToolCalls 一致）
        const pushed = [];
        store.runToolCalls = async function (tcs) {
            const r = { role: 'tool', tool_call_id: tcs[0].id, content: 'hello' };
            store.conversation.push(r); pushed.push(r); return true;
        };
        await store.continueRun({ userText: '再总结一下', images: [] });
        eq(store.conversation.map(m => m.role), ['user', 'assistant', 'tool', 'user'],
            '顺序：assistant.tool_calls → tool 结果 → 新的 user');
        eq(store.conversation[2].tool_call_id, 't1', 'tool 结果仍紧跟其对应的调用');
        eq(store.conversation[2].content, 'hello', 'tool 结果内容未被改写');
        eq(store.conversation[3].content, '再总结一下', '新输入在最后（不插入 tool 之间）');
        eq(started, 1, '继续生成一次');
    }

    group('⑯ 已有 tool 消息在带入新输入后原样不变');
    {
        const { stubs } = makeChatStubs({});
        const store = loadChatStore(stubs);
        stubs.__store = store;
        store.conversation = [
            { role: 'user', content: '读一下 a.txt' },
            { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 't1', content: 'hello', _toolError: false }
        ];
        const before = JSON.stringify(store.conversation.filter(m => m.role === 'tool'));
        store.startInference = async function () {};
        await store.continueRun({ userText: '请继续', images: [] });
        const after = JSON.stringify(store.conversation.filter(m => m.role === 'tool'));
        eq(after, before, '原有的 tool 消息一条不多、一条不少、内容/字段不变');
        eq(store.conversation.filter(m => m.role === 'user').length, 2, '只多了一条新的 user 消息');
    }

    console.log('\n──────────────────────────────');
    console.log('trim-below.test: ' + pass + ' passed, ' + fail + ' failed');
    if (fail) process.exitCode = 1;
})();
