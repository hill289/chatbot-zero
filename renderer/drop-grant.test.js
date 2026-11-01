/* drop-grant.test.js —— 拖入路径免确认授权的证明校验（node --test） */
const test = require('node:test');
const assert = require('node:assert');
const { createDropGrantVerifier } = require('./drop-grant.js');

function winV() { return createDropGrantVerifier({ platform: 'win32' }); }
function posixV() { return createDropGrantVerifier({ platform: 'linux' }); }

test('拖入单个文件：文件自身可授权', () => {
    const v = winV();
    const r = v.verify(['D:\\proj\\a.txt'], ['D:\\proj\\a.txt']);
    assert.deepStrictEqual(r.allowed, ['D:\\proj\\a.txt']);
    assert.deepStrictEqual(r.rejected, []);
});

test('拖入目录：目录内有真实文件即可授权整个目录', () => {
    const v = winV();
    const r = v.verify(['D:\\proj\\demo'], ['D:\\proj\\demo\\src\\a.js', 'D:\\proj\\demo\\b.md']);
    assert.deepStrictEqual(r.allowed, ['D:\\proj\\demo']);
    assert.strictEqual(r.rejected.length, 0);
});

test('没有证明（合成 File 的空路径）→ 一律拒绝，脚本无法空手扩权', () => {
    const v = winV();
    const r = v.verify(['C:\\Users\\me', 'D:\\proj'], []);
    assert.strictEqual(r.allowed.length, 0);
    assert.strictEqual(r.rejected.length, 2);
    assert.strictEqual(r.rejected[0].reason, 'EPERM_NO_DROP_PROOF');
    assert.strictEqual(r.rejected[1].reason, 'EPERM_NO_DROP_PROOF');
});

test('证明不在范围内 → 拒绝（不能借别的目录的拖入证明扩展授权）', () => {
    const v = winV();
    const r = v.verify(['D:\\secret'], ['D:\\proj\\demo\\a.js']);
    assert.strictEqual(r.allowed.length, 0);
    assert.strictEqual(r.rejected[0].reason, 'EPERM_NO_DROP_PROOF');
});

test('只允许「证明路径等于请求路径 / 位于请求路径之下」：反过来（请求是证明的子路径）拒绝', () => {
    const v = winV();
    // 拖入的是 D:\proj\demo\a.js：可以授权它本身，也可以授权它所在的拖入目录，
    // 但不能凭空申请它下面的子目录（那里没有任何拖入的东西）
    assert.deepStrictEqual(v.verify(['D:\\proj\\demo'], ['D:\\proj\\demo\\a.js']).allowed, ['D:\\proj\\demo']);
    const r = v.verify(['D:\\proj\\demo\\src'], ['D:\\proj\\demo\\a.js']);
    assert.strictEqual(r.allowed.length, 0);
    assert.strictEqual(r.rejected[0].reason, 'EPERM_NO_DROP_PROOF');
});

test('大小写 / 分隔符 / 尾分隔符 / .. 归一化（Windows）', () => {
    const v = winV();
    const r = v.verify(
        ['d:\\PROJ\\Demo\\', 'D:\\Proj\\Demo\\..\\Demo'],
        ['D:\\proj\\demo\\src\\x.js']
    );
    assert.strictEqual(r.allowed.length, 1, '同一条路径去重后只授权一次');
    assert.deepStrictEqual(v.normalize('d:\\PROJ\\Demo\\'), 'd:\\proj\\demo');
});

test('相对路径与空路径 → EPERM_BAD_PATH', () => {
    const v = winV();
    const r = v.verify(['docs\\a.txt', '', null], ['D:\\proj\\a.txt']);
    assert.strictEqual(r.allowed.length, 0);
    assert.strictEqual(r.rejected.length, 3);
    r.rejected.forEach(x => assert.strictEqual(x.reason, 'EPERM_BAD_PATH'));
});

test('POSIX：目录授权与 /etc 之类由上层兜底（本模块只看证明）', () => {
    const v = posixV();
    const ok = v.verify(['/home/me/proj'], ['/home/me/proj/src/a.js']);
    assert.deepStrictEqual(ok.allowed, ['/home/me/proj']);
    // 证明落在 /etc 下也算「有证明」——敏感路径由 fs-grant.js 的 add() 继续拒绝
    const etc = v.verify(['/etc'], ['/etc/passwd']);
    assert.deepStrictEqual(etc.allowed, ['/etc']);
});

test('前缀相近的兄弟目录不算包含关系', () => {
    const v = winV();
    const r = v.verify(['D:\\proj\\demo'], ['D:\\proj\\demo2\\a.js']);
    assert.strictEqual(r.allowed.length, 0);
    assert.strictEqual(v.isWithin(v.normalize('D:\\proj\\demo2\\a.js'), v.normalize('D:\\proj\\demo')), false);
});

test('重复申请同一路径只保留一次', () => {
    const v = winV();
    const r = v.verify(['D:\\proj\\demo', 'D:\\proj\\demo\\'], ['D:\\proj\\demo\\a.js']);
    assert.strictEqual(r.allowed.length, 1);
});
