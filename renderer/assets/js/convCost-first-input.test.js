/*!
 * convCost-first-input.test.js — 回归测试：本页累计下面显示「本轮对话的第一条输入框消息」
 * -----------------------------------------------------------------------------
 * 覆盖 10-prefix-cache.js · updateConvCost() / firstUserInputText()：
 *   ① 第一条 user 消息（本轮首条输入）渲染在本页累计行「下面」，且带 📝 标签；
 *   ② 任务中心注入的阶段指令块（【任务中心…】）被剥离，不属于输入框消息；
 *   ③ 跳过系统交接种子（硬切 / note）与压缩摘要，取第一条真实用户输入；
 *   ④ 多模态首条（text + image_url）只取文本；
 *   ⑤ 空对话 → 统计条隐藏；
 *   ⑥ HTML 转义：用户文本里的标签不被原样注入 innerHTML；
 *   ⑦ 有累计用量时，成本行与首条输入同时显示；
 *   ⑧ 长文本不截断：完整保留在 DOM、不追加省略号，默认折叠为单行并带 ▼；
 *   ⑨ 点 ▼ 展开全文（▲ / pre-wrap），再点 ▲ 收起（▼ / nowrap）。
 * 运行： node renderer/assets/js/convCost-first-input.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }
function group(t) { console.log('\n▶ ' + t); }

function makeCostEl() {
    const el = { style: {}, innerHTML: '', title: '', _handlers: {} };
    el.addEventListener = function (type, fn) { el._handlers[type] = fn; };
    el.dispatch = function (type, ev) { if (el._handlers[type]) el._handlers[type](ev); };
    return el;
}
// 模拟点击「展开/收起」箭头
function clickToggle(el) {
    el.dispatch('click', {
        target: { closest: function (sel) { return sel === '.conv-first-input-toggle' ? {} : null; } }
    });
}

function loadPrefix(opts) {
    opts = opts || {};
    const src = fs.readFileSync(path.join(__dirname, '10-prefix-cache.js'), 'utf8');
    const body = src + '\n;return { updateConvCost: updateConvCost, firstUserInputText: firstUserInputText };';
    const el = opts.el || makeCostEl();
    const doc = { getElementById: function (id) { return id === 'convCost' ? el : null; } };
    const messageStore = {
        conversation: opts.conversation || [],
        convUsage: opts.convUsage || { hit: 0, miss: 0, out: 0 }
    };
    const chatbotStore = { model: 'deepseek-chat', cacheMode: true };
    const HardCut = opts.HardCut || {
        pressure: function () { return null; },              // 默认无上下文占用 → ctx=null
        config: function () { return { ratio: 0.85 }; },
        resetUsage: function () {}
    };
    const persist = { load: function () { return {}; }, save: function () {} };
    const escapeHtml = function (s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };
    const fn = new Function(
        'window', 'document', 'messageStore', 'chatbotStore', 'HardCut', 'persist',
        'agentStore', 'mcpStore', 'escapeHtml', body
    );
    const api = fn({}, doc, messageStore, chatbotStore, HardCut, persist, { columns: [] }, {}, escapeHtml);
    return { api: api, el: el, messageStore: messageStore };
}

(function main() {
    group('① 第一条 user 消息渲染在本页累计行「下面」');
    {
        const conv = [
            { role: 'user', content: '这是用户敲进输入框的第一句话' },
            { role: 'assistant', content: '好的，收到' }
        ];
        const { api, el } = loadPrefix({ conversation: conv });
        api.updateConvCost();
        ok(el.style.display === 'block', '统计条显示');
        ok(el.innerHTML.indexOf('💰 本页累计') >= 0, '含本页累计成本行');
        ok(el.innerHTML.indexOf('📝 本轮首条输入：') >= 0, '含「本轮首条输入」标签');
        ok(el.innerHTML.indexOf('这是用户敲进输入框的第一句话') >= 0, '含首条输入正文');
        ok(el.innerHTML.indexOf('💰 本页累计') < el.innerHTML.indexOf('📝 本轮首条输入'),
            '首条输入在「本页累计」之后（下面）');
        ok(el.innerHTML.indexOf('好的，收到') < 0, '不把 assistant 消息当输入');
    }

    group('② 任务中心注入块被剥离');
    {
        const conv = [{
            role: 'user',
            content: '把按钮改成蓝色\n\n【任务中心 · 改颜色】阶段：executing（第 1 次尝试）\n按计划逐步执行；每完成一步更新 todo。'
        }];
        const { api, el } = loadPrefix({ conversation: conv });
        api.updateConvCost();
        ok(el.innerHTML.indexOf('把按钮改成蓝色') >= 0, '保留用户正文');
        ok(el.innerHTML.indexOf('任务中心') < 0, '剥离【任务中心…】注入块');
        ok(el.innerHTML.indexOf('按计划逐步执行') < 0, '剥离阶段指令正文');
    }

    group('③ 跳过系统交接种子 / 压缩摘要，取第一条真实输入');
    {
        const conv = [
            { role: 'user', content: '✂️ 已切换窗口：旧对话归档…', _sysNote: true, _hardCut: true, _sysNoteKind: 'hardcut' },
            { role: 'user', content: '<compaction-summary>\n较早对话摘要…\n</compaction-summary>' },
            { role: 'user', content: '真正意义上的第一条输入' },
            { role: 'user', content: '后面的第二条' }
        ];
        const { api, el } = loadPrefix({ conversation: conv });
        api.updateConvCost();
        ok(el.innerHTML.indexOf('真正意义上的第一条输入') >= 0, '取到第一条真实输入');
        ok(el.innerHTML.indexOf('已切换窗口') < 0, '不含交接种子');
        ok(el.innerHTML.indexOf('较早对话摘要') < 0, '不含压缩摘要');
        ok(el.innerHTML.indexOf('后面的第二条') < 0, '只显示第一条，不含后续输入');
    }

    group('④ 多模态首条（text + image）只取文本');
    {
        const conv = [{
            role: 'user',
            content: [
                { type: 'text', text: '照着这张图改样式' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
            ]
        }];
        const { api, el } = loadPrefix({ conversation: conv });
        api.updateConvCost();
        ok(el.innerHTML.indexOf('照着这张图改样式') >= 0, '取到文本部分');
    }

    group('⑤ 空对话 → 统计条隐藏');
    {
        const { api, el } = loadPrefix({ conversation: [] });
        api.updateConvCost();
        ok(el.style.display === 'none', '无对话 / 无用量 → display:none');
    }

    group('⑥ HTML 转义：用户文本里的标签不会被原样注入');
    {
        const conv = [{ role: 'user', content: '<img src=x onerror=alert(1)>' }];
        const { api, el } = loadPrefix({ conversation: conv });
        api.updateConvCost();
        ok(el.innerHTML.indexOf('<img src=x') < 0, '原始 <img 标签未被注入');
        ok(el.innerHTML.indexOf('&lt;img') >= 0, '尖括号已转义');
    }

    group('⑦ 有累计用量时，成本行与首条输入同时显示');
    {
        const conv = [{ role: 'user', content: '第一条输入内容' }];
        const { api, el } = loadPrefix({ conversation: conv, convUsage: { hit: 1000, miss: 500, out: 200 } });
        api.updateConvCost();
        ok(el.innerHTML.indexOf('缓存命中') >= 0, '含缓存命中统计');
        ok(el.innerHTML.indexOf('📝 本轮首条输入：') >= 0, '同时含首条输入');
    }

    group('⑧ 长文本不截断：完整保留、不追加省略号，默认折叠单行并带 ▼');
    {
        const long = '很长的第一条输入内容'.repeat(60); // 远超 200 字，且本身不含省略号
        const { api, el } = loadPrefix({ conversation: [{ role: 'user', content: long }] });
        api.updateConvCost();
        ok(el.innerHTML.indexOf(long) >= 0, '完整文本全部渲染（未截断）');
        ok(el.innerHTML.indexOf('…') < 0, '代码不再追加省略号');
        ok(el.innerHTML.indexOf('conv-first-input-toggle') >= 0, '存在展开箭头按钮');
        ok(el.innerHTML.indexOf('▼') >= 0, '默认显示折叠箭头 ▼');
        ok(el.innerHTML.indexOf('white-space:nowrap') >= 0, '默认折叠为单行');
    }

    group('⑨ 点 ▼ 展开全文，再点 ▲ 收起');
    {
        const long = 'X'.repeat(300);
        const { api, el } = loadPrefix({ conversation: [{ role: 'user', content: long }] });
        api.updateConvCost();
        ok(el.innerHTML.indexOf('white-space:nowrap') >= 0, '初始折叠（单行省略）');
        clickToggle(el);
        ok(el.innerHTML.indexOf('white-space:pre-wrap') >= 0, '展开后换行显示全文');
        ok(el.innerHTML.indexOf('▲') >= 0, '箭头变为 ▲');
        ok(el.innerHTML.indexOf(long) >= 0, '展开后仍完整包含全文');
        clickToggle(el);
        ok(el.innerHTML.indexOf('white-space:nowrap') >= 0, '再次点击收起');
        ok(el.innerHTML.indexOf('▼') >= 0, '箭头恢复 ▼');
    }

    console.log('\n──────────────────────────────');
    console.log('convCost-first-input.test: ' + pass + ' passed, ' + fail + ' failed');
    if (fail) process.exitCode = 1;
})();
