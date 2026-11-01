/*!
 * input-focus-guard.test.js — 回归测试：输入框被浮层遮挡时点击仍能聚焦
 * -----------------------------------------------------------------------------
 * 覆盖 input-focus-guard.js：
 *   · pointInRect / shouldRescuePoint 纯逻辑；
 *   · install() 接线后：当点击落在输入框矩形内、但最上层是「非控件」的浮层时，
 *     强制把焦点抢回 textarea 并 preventDefault；命中控件 / 点 textarea 本身 / 点在框外则不抢。
 *
 * 运行： node --test renderer/assets/js/input-focus-guard.test.js
 */
'use strict';
const assert = require('assert');
const { test } = require('node:test');
const G = require('./input-focus-guard.js');

const RECT = { left: 100, top: 100, right: 300, bottom: 160 };
const inPoint = { x: 200, y: 130 };
const outPoint = { x: 50, y: 50 };

function makeUserInput() {
    const calls = { focus: 0, range: 0 };
    return {
        value: 'hello',
        calls,
        getBoundingClientRect: () => RECT,
        focus() { calls.focus++; },
        setSelectionRange() { calls.range++; }
    };
}
const overlayEl = { closest: () => null };                 // 普通 div（透明浮层）
const buttonEl = { closest: () => ({ tag: 'BUTTON' }) };    // 合法控件

function makeDoc(topEl) {
    const doc = {
        handlers: {},
        addEventListener(type, fn) { this.handlers[type] = fn; },
        removeEventListener() {},
        elementFromPoint() { return topEl; }
    };
    return doc;
}
function fire(doc, opts) {
    let prevented = false;
    const e = {
        button: opts.button == null ? 0 : opts.button,
        clientX: opts.x, clientY: opts.y,
        target: opts.target,
        preventDefault() { prevented = true; }
    };
    doc.handlers['mousedown'](e);
    return prevented;
}

/* ─────────────── 纯逻辑 ─────────────── */
test('pointInRect 边界', () => {
    assert.strictEqual(G.pointInRect(200, 130, RECT), true);
    assert.strictEqual(G.pointInRect(100, 100, RECT), true);
    assert.strictEqual(G.pointInRect(300, 160, RECT), true);
    assert.strictEqual(G.pointInRect(99, 130, RECT), false);
    assert.strictEqual(G.pointInRect(200, 161, RECT), false);
    assert.strictEqual(G.pointInRect(NaN, 130, RECT), false);
    assert.strictEqual(G.pointInRect(200, 130, null), false);
});

test('shouldRescuePoint：被浮层遮挡才抢焦点', () => {
    const ui = makeUserInput();
    // 落在框外 → 不抢
    assert.strictEqual(G.shouldRescuePoint({ button: 0, x: outPoint.x, y: outPoint.y, rect: RECT, target: overlayEl, userInput: ui, topEl: overlayEl }), false);
    // 点 textarea 本身 → 不抢（交给默认）
    assert.strictEqual(G.shouldRescuePoint({ button: 0, ...inPoint, rect: RECT, target: ui, userInput: ui, topEl: ui }), false);
    // 命中最上层就是 textarea → 不抢
    assert.strictEqual(G.shouldRescuePoint({ button: 0, ...inPoint, rect: RECT, target: overlayEl, userInput: ui, topEl: ui }), false);
    // 命中合法控件（浮层上的按钮）→ 不抢
    assert.strictEqual(G.shouldRescuePoint({ button: 0, ...inPoint, rect: RECT, target: overlayEl, userInput: ui, topEl: buttonEl, topElIsControl: true }), false);
    // 被普通浮层 div 遮挡 → 抢
    assert.strictEqual(G.shouldRescuePoint({ button: 0, ...inPoint, rect: RECT, target: overlayEl, userInput: ui, topEl: overlayEl, topElIsControl: false }), true);
    // 非左键 → 不抢
    assert.strictEqual(G.shouldRescuePoint({ button: 2, ...inPoint, rect: RECT, target: overlayEl, userInput: ui, topEl: overlayEl }), true === false);
});

/* ─────────────── install 行为 ─────────────── */
test('install：浮层遮挡时点击输入框位置 → 抢焦点 + preventDefault', () => {
    const ui = makeUserInput();
    const doc = makeDoc(overlayEl);
    G.install(doc, { userInput: ui });
    const prevented = fire(doc, { x: inPoint.x, y: inPoint.y, target: overlayEl });
    assert.strictEqual(prevented, true, '应 preventDefault 阻止浮层吞点击');
    assert.strictEqual(ui.calls.focus, 1, '应聚焦输入框一次');
});

test('install：命中浮层上的按钮 → 尊重按钮，不抢焦点', () => {
    const ui = makeUserInput();
    const doc = makeDoc(buttonEl);   // elementFromPoint 返回按钮
    G.install(doc, { userInput: ui });
    const prevented = fire(doc, { x: inPoint.x, y: inPoint.y, target: buttonEl });
    assert.strictEqual(prevented, false);
    assert.strictEqual(ui.calls.focus, 0);
});

test('install：直接点 textarea / 点在框外 → 不干预', () => {
    const ui = makeUserInput();
    const doc = makeDoc(ui);
    G.install(doc, { userInput: ui });
    assert.strictEqual(fire(doc, { x: inPoint.x, y: inPoint.y, target: ui }), false, '点 textarea 不干预');
    assert.strictEqual(fire(doc, { x: outPoint.x, y: outPoint.y, target: overlayEl }), false, '点框外不干预');
    assert.strictEqual(ui.calls.focus, 0);
});
