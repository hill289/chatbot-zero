/*!
 * cdp-core.test.js — cdp-core.js 的 Node 自检（零依赖）
 * 运行： node renderer/cdp-core.test.js
 */
'use strict';
const C = require('./cdp-core.js');
let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.error('  ✗ ' + m)); }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

// ── 构造一棵无障碍树 ─────────────────────────────────────
const AX = [
  { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['1', '2', '3', '4', '5', 'ig'] },
  { nodeId: '1', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 101, childIds: [] },
  { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'secret' }, backendDOMNodeId: 102, childIds: [] },
  { nodeId: '3', role: { value: 'checkbox' }, name: { value: 'Remember me' }, backendDOMNodeId: 103, properties: [{ name: 'checked', value: { value: true } }], childIds: [] },
  { nodeId: '4', role: { value: 'button' }, name: { value: 'Sign in' }, backendDOMNodeId: 104, properties: [{ name: 'disabled', value: { value: true } }], childIds: ['4a'] },
  { nodeId: '4a', role: { value: 'StaticText' }, name: { value: 'Sign in' }, childIds: [] },
  { nodeId: '5', role: { value: 'link' }, name: { value: 'Forgot password' }, backendDOMNodeId: 105, childIds: [] },
  { nodeId: 'ig', ignored: true, role: { value: 'none' }, childIds: ['6'] },
  { nodeId: '6', role: { value: 'button' }, name: { value: 'Nested in ignored' }, backendDOMNodeId: 106, childIds: [] },
];

group('buildSnapshot：a11y → refs');
{
  const snap = C.buildSnapshot(AX, { url: 'https://example.com/login', title: '登录' });
  eq(snap.refs.length, 6, '6 个可交互元素（含忽略节点的子节点）');
  eq(snap.refs.map(r => r.ref), [1, 2, 3, 4, 5, 6], 'ref 从 1 递增');
  eq(snap.refs[0].role, 'textbox', '第1个 role');
  eq(snap.refs[0].name, 'Email', '第1个 name');
  eq(snap.refs[0].backendNodeId, 101, 'backendDOMNodeId');
  eq(snap.refs[1].value, 'secret', 'textbox value');
  eq(snap.refs[2].checked, true, 'checkbox checked');
  eq(snap.refs[3].disabled, true, 'button disabled');
  eq(snap.refs[3].name, 'Sign in', 'button 名称来自 node（非 StaticText 子节点）');
  eq(snap.backendToRef[106], 6, 'backendToRef 映射忽略节点内的按钮');
  ok(snap.backendToRef[999] === undefined, '不存在的 backendNodeId 不在映射里');
  eq(snap.byRef[5].role, 'link', 'byRef 可用');
  ok(snap.text.indexOf('[1] textbox "Email"') >= 0, '文本含 [1]');
  ok(snap.text.indexOf('Page: 登录 — https://example.com/login') === 0, '文本含页眉');
  ok(snap.text.indexOf('value="secret"') >= 0, '文本含 value');
  ok(snap.text.indexOf('checked') >= 0, '文本含 checked');
  ok(snap.text.indexOf('disabled') >= 0, '文本含 disabled');

  const capped = C.buildSnapshot(AX, { maxRefs: 2 });
  eq(capped.refs.length, 2, 'maxRefs 截断');
}

group('buildSnapshot：空树 / 无元素');
{
  const empty = C.buildSnapshot([], { title: 'blank' });
  eq(empty.refs.length, 0, '空树 0 元素');
  ok(empty.text.indexOf('未发现可交互元素') >= 0, '空树提示文案');
  const onlyText = C.buildSnapshot([
    { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['t'] },
    { nodeId: 't', role: { value: 'StaticText' }, name: { value: 'hello' }, childIds: [] },
  ]);
  eq(onlyText.refs.length, 0, '只有静态文本 → 无 ref');
}

group('坐标换算：quadCenter / quadArea / toDispatchPoint');
{
  const quad = [100, 50, 120, 50, 120, 60, 100, 60]; // 20x10 的矩形
  eq(C.quadCenter(quad), { x: 110, y: 55 }, '四边形中心');
  eq(C.quadArea(quad), 200, '四边形面积 20*10');
  const vp = { clientWidth: 800, clientHeight: 600 };
  eq(C.toDispatchPoint([quad], vp), { x: 110, y: 55, visible: true }, '视口内可见');
  const off = [900, 50, 920, 50, 920, 60, 900, 60];
  const p2 = C.toDispatchPoint([off], vp);
  eq(p2.visible, false, '视口外不可见');
  eq([p2.x, p2.y], [910, 55], '不可见时回退第一块中心');
  eq(C.toDispatchPoint([], vp), { x: 0, y: 0, visible: false }, '空 quads');

  // 多块：一块小的可见 + 一块大的可见 → 取面积大的
  const small = [10, 10, 20, 10, 20, 20, 10, 20];
  const big = [100, 100, 200, 100, 200, 200, 100, 200];
  const pick = C.pickVisibleQuad([small, big], vp);
  eq(pick.center, { x: 150, y: 150 }, 'pick 取面积大的那块');
}

group('输入命令：buildClickCommands');
{
  const cmds = C.buildClickCommands({ x: 10, y: 20 });
  eq(cmds.length, 3, '单击 3 条命令');
  eq(cmds[0].params.type, 'mouseMoved', '首条 mouseMoved');
  eq([cmds[0].params.x, cmds[0].params.y], [10, 20], '坐标透传');
  eq(cmds[1].params.type, 'mousePressed', '第二条 mousePressed');
  eq(cmds[1].params.buttons, 1, '左键 buttons=1');
  eq(cmds[1].params.clickCount, 1, 'clickCount=1');
  eq(cmds[2].params.type, 'mouseReleased', '末条 mouseReleased');
  eq(cmds[2].params.buttons, 0, '释放 buttons=0');

  const dbl = C.buildClickCommands({ x: 1, y: 2, button: 'right', clickCount: 2 });
  eq(dbl.length, 5, '双击 → 5 条');
  eq(dbl[1].params.buttons, 2, '右键 buttons=2');
  eq([dbl[1].params.clickCount, dbl[3].params.clickCount], [1, 2], '双击 clickCount 递增');

  let threw = false;
  try { C.buildClickCommands({ x: 'a', y: 2 }); } catch (_) { threw = true; }
  ok(threw, '非数字坐标抛错');
}

group('输入命令：insertText / keyType / enter');
{
  eq(C.buildInsertTextCommands(''), [], '空文本 → 无命令');
  const ins = C.buildInsertTextCommands('你好');
  eq(ins.length, 1, 'insertText 1 条');
  eq(ins[0].method, 'Input.insertText', '方法名');
  eq(ins[0].params.text, '你好', '文本透传');

  const keyed = C.buildKeyTypeCommands('ab');
  eq(keyed.length, 4, '两个字符 → 4 条 key 事件');
  eq(keyed[0].params.type, 'keyDown', 'keyDown');
  eq(keyed[0].params.code, 'KeyA', 'KeyA code');
  eq(keyed[1].params.type, 'keyUp', 'keyUp');
  eq(keyed[2].params.code, 'KeyB', 'KeyB code');

  const enter = C.buildEnterCommands();
  eq(enter.length, 3, 'enter 3 条');
  eq(enter[0].params.key, 'Enter', 'enter key');
  eq(enter[0].params.windowsVirtualKeyCode, 13, 'enter vk=13');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
