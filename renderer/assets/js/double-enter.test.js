/*!
 * double-enter.test.js — 回归测试：「连续两次 Enter 发送」偶发失效
 * -----------------------------------------------------------------------------
 * 覆盖 09-chat-store.js · messageStore.handleKeydown()：
 *   ① 正常输入 + 连按两次 Enter（间隔 300ms）→ 发送一次；
 *   ② 两次回车间隔远超原来的 800ms 窗口（模拟 6s）→ 仍然发送
 *      （靠「光标在末尾且末行为空行」判定，不再依赖时间窗口）；
 *   ③ 中文输入法：上屏用的回车（isComposing / keyCode 229）不发送，
 *      但它记为「第一次回车」，紧接的下一次回车即可发送；
 *   ④ 部分输入法 compositionend 先于 keydown：刚上屏的那次回车同样不发送，
 *      随后的回车发送；
 *   ⑤ Shift+Enter 只换行、不发送、不参与配对；
 *   ⑥ 空输入连按两次 Enter 不发送（也不吞掉换行）；
 *   ⑦ 生成中（generating=true）按 Enter 只换行、不发送、不 preventDefault；
 *   ⑧ 中间敲了其他键 → 打断配对；
 *   ⑨ 三连回车只发送一次；
 *   ⑩ 仅有图片附件（无文字）时连按两次 Enter 也发送；
 *   ⑪ 粘贴的多行文本（以换行结尾）不会一次 Enter 就误发，仍需两次。
 * 运行： node renderer/assets/js/double-enter.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

/* ─────────────── 加载 09-chat-store.js（用替身注入依赖） ─────────────── */
function loadStore() {
    const src = fs.readFileSync(path.join(__dirname, '09-chat-store.js'), 'utf8');
    const hints = [];
    const fn = new Function(
        'document', 'snackbarStore', 'updateInputIcon', 'planStore', 'historyStore',
        'renderConversation', 'askUserStore', 'sessionLog', 'stickToBottom',
        src + '\n;return messageStore;'
    );
    const store = fn(
        { getElementById: () => null },
        {
            showInfoMessage: (m) => hints.push(m),
            showWarningMessage: () => {},
            showSuccessMessage: () => {},
            showErrorMessage: () => {}
        },
        () => {}, { clear: () => {}, forceReinject: () => {} },
        { save: () => {}, init: () => {} }, () => {}, { cancel: () => {} }, null, true
    );
    store.__hints = hints;
    return store;
}

/* ─────────────── 模拟 textarea 与键盘事件 ─────────────── */
function makeEl(value, caret) {
    const pos = (caret == null) ? value.length : caret;
    return { value, selectionStart: pos, selectionEnd: pos };
}

// 模拟浏览器默认行为：未被 preventDefault、且不是组词/上屏/快捷键时，在光标处插入换行
function dispatch(store, el, opts) {
    opts = opts || {};
    let prevented = false;
    const composing = !!opts.composing || opts.keyCode === 229;
    const e = {
        key: opts.key || 'Enter',
        target: el,
        isComposing: composing,
        keyCode: opts.keyCode || (composing ? 229 : 13),
        repeat: !!opts.repeat,
        shiftKey: !!opts.shiftKey,
        ctrlKey: !!opts.ctrlKey,
        metaKey: !!opts.metaKey,
        preventDefault() { prevented = true; }
    };
    store.handleKeydown(e);
    if (e.key === 'Enter' && !prevented && !composing && !e.ctrlKey && !e.metaKey) {
        const p = (el.selectionEnd == null) ? el.value.length : el.selectionEnd;
        el.value = el.value.slice(0, p) + '\n' + el.value.slice(p);
        el.selectionStart = el.selectionEnd = p + 1;
    }
    return prevented;
}

function pressLetter(store, el, ch) {
    store.handleKeydown({ key: ch, target: el, isComposing: false, keyCode: ch.charCodeAt(0), preventDefault() {} });
    const p = el.selectionEnd == null ? el.value.length : el.selectionEnd;
    el.value = el.value.slice(0, p) + ch + el.value.slice(p);
    el.selectionStart = el.selectionEnd = p + 1;
}

function newCase(text) {
    const store = loadStore();
    let sent = 0;
    store.sendMessage = () => { sent++; };
    const el = makeEl(text || '');
    return { store, el, count: () => sent };
}

function ageOutPairing(store, ms) { // 模拟「已经过去很久」：把上次回车时间往前拨
    if (store._lastEnterAt) store._lastEnterAt -= (ms || 6000);
}

/* ───────────────────────────── 用例 ───────────────────────────── */

group('① 正常输入：连按两次 Enter（约 300ms）发送一次');
{
    const c = newCase('你好，请帮我写一个函数');
    dispatch(c.store, c.el);
    eq(c.count(), 0, '第一次 Enter 不发送');
    ageOutPairing(c.store, 300);
    const prevented = dispatch(c.store, c.el);
    eq(c.count(), 1, '第二次 Enter 发送');
    ok(prevented, '第二次 Enter 被 preventDefault（不再插入空行）');
}

group('② 超过原 800ms 窗口（模拟 6 秒）仍应发送');
{
    const c = newCase('慢慢按两次回车也应该能发出去');
    dispatch(c.store, c.el);
    eq(c.count(), 0, '第一次 Enter 不发送');
    ageOutPairing(c.store, 6000);
    dispatch(c.store, c.el);
    eq(c.count(), 1, '间隔 6 秒的第二次 Enter 仍然发送');
}

group('③ 中文输入法：上屏回车不发送，下一次回车发送');
{
    const c = newCase('中文输入法');
    const prevented1 = dispatch(c.store, c.el, { composing: true, keyCode: 229 });
    eq(c.count(), 0, '上屏的回车不发送');
    eq(prevented1, false, '上屏的回车不 preventDefault（交给输入法）');
    const prevented2 = dispatch(c.store, c.el);
    eq(c.count(), 1, '紧接着的一次回车即发送（上屏回车算第一次）');
    ok(prevented2, '发送的回车被 preventDefault');
}

group('④ compositionend 先于 keydown：刚上屏的那次不发送，随后发送');
{
    const c = newCase('输入法顺序');
    c.store._composing = true;
    dispatch(c.store, c.el, { composing: true, keyCode: 229 });
    c.store._composing = false;
    c.store._composedAt = Date.now();
    dispatch(c.store, c.el);           // 紧跟着补发的 keydown：仍属「刚上屏」
    eq(c.count(), 0, '刚上屏（<80ms）的 keydown 不发送');
    dispatch(c.store, c.el);           // 用户真正按下的下一次回车
    eq(c.count(), 1, '随后的一次回车发送');
}

group('⑤ Shift+Enter 只换行、不发送、不参与配对');
{
    const c = newCase('第一行');
    const prevented = dispatch(c.store, c.el, { shiftKey: true });
    eq(prevented, false, 'Shift+Enter 不 preventDefault');
    ok(c.el.value === '第一行\n', 'Shift+Enter 插入换行');
    eq(c.store._lastEnterAt, 0, 'Shift+Enter 不记录配对时间');
    dispatch(c.store, c.el);           // 之后的一次普通回车只算「第一次」
    eq(c.count(), 0, 'Shift+Enter 后的单次回车不发送');
}

group('⑥ 空输入连按两次 Enter 不发送');
{
    const c = newCase('');
    dispatch(c.store, c.el);
    dispatch(c.store, c.el);
    eq(c.count(), 0, '空输入不发送');
}

group('⑦ 生成中按 Enter 只换行、不发送、不吞按键');
{
    const c = newCase('生成中的补充输入');
    c.store.generating = true;
    const p1 = dispatch(c.store, c.el);
    const p2 = dispatch(c.store, c.el);
    eq(c.count(), 0, '生成中不发送');
    ok(!p1 && !p2, '生成中不 preventDefault（不会「按了没反应」）');
    ok(c.store.__hints.length >= 1, '给出「正在生成中」提示');
    ok(c.store.__hints.length === 1, '提示只出现一次');
}

group('⑧ 中间敲其他键打断配对');
{
    const c = newCase('ab');
    dispatch(c.store, c.el);
    pressLetter(c.store, c.el, 'c');
    eq(c.store._lastEnterAt, 0, '其他键清空配对时间');
    dispatch(c.store, c.el);
    eq(c.count(), 0, '被打断后的单次回车不发送');
}

group('⑨ 三连回车只发送一次');
{
    const c = newCase('三连回车');
    dispatch(c.store, c.el);
    dispatch(c.store, c.el);
    dispatch(c.store, c.el);
    eq(c.count(), 1, '三连回车只发送一次');
}

group('⑩ 仅图片附件（无文字）连按两次 Enter 也发送');
{
    const c = newCase('');
    c.store.pendingImages = ['data:image/png;base64,AAAA'];
    dispatch(c.store, c.el);
    dispatch(c.store, c.el);
    eq(c.count(), 1, '图片消息可发送');
}

group('⑪ 粘贴的多行文本（以换行结尾）不会一次 Enter 就误发');
{
    const c = newCase('a\nb\n');
    dispatch(c.store, c.el);
    eq(c.count(), 0, '第一次回车不误发');
    dispatch(c.store, c.el);
    eq(c.count(), 1, '第二次回车才发送');
}

console.log('\n──────────────────────────────');
console.log((fail === 0 ? '✅ 全部通过' : '❌ 有失败用例') + '：' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
