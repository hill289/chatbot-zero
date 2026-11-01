/* fs-grant.test.js —— fileAPI 路径授权模型单测（node --test） */
const test = require('node:test');
const assert = require('node:assert');
const { createGrantStore } = require('./fs-grant.js');

function winStore() {
  return createGrantStore({
    platform: 'win32',
    protectedPaths: ['C:\\Users\\me\\AppData\\Roaming\\chatbot-zero']
  });
}

test('默认零授权：没拖进来的文件一律拒绝', () => {
  const g = winStore();
  assert.strictEqual(g.allows('C:\\Users\\me\\Documents\\a.txt'), false);
  assert.strictEqual(g.allows('C:\\Users\\me\\.ssh\\id_rsa'), false);
});

test('授权目录 → 目录及其子目录可读写，外部仍拒绝', () => {
  const g = winStore();
  g.add('D:\\proj\\demo', 'dir');
  assert.strictEqual(g.allows('D:\\proj\\demo\\src\\a.js'), true);
  assert.strictEqual(g.allows('D:\\proj\\demo'), true);
  assert.strictEqual(g.allows('D:\\proj\\demo2\\a.js'), false);
  assert.strictEqual(g.allows('D:\\proj'), false);
});

test('授权单个文件 → 只放行该文件，不放行同目录其它文件', () => {
  const g = winStore();
  g.add('D:\\docs\\report.docx', 'file');
  assert.strictEqual(g.allows('D:\\docs\\report.docx'), true);
  assert.strictEqual(g.allows('D:\\docs\\other.docx'), false);
});

test('大小写与 .. / 尾部分隔符归一化（Windows）', () => {
  const g = winStore();
  g.add('D:\\Proj\\Demo\\', 'dir');
  assert.strictEqual(g.allows('d:\\proj\\demo\\SRC\\x.js'), true);
  assert.strictEqual(g.allows('D:\\Proj\\Demo\\..\\Demo\\x.js'), true);
  assert.strictEqual(g.allows('D:\\Proj\\..\\Other\\x.js'), false);
});

test('敏感路径永远拒绝，即便落在授权目录内', () => {
  const g = winStore();
  g.add('C:\\Users\\me', 'dir');
  assert.strictEqual(g.allows('C:\\Users\\me\\Documents\\a.txt'), true);
  assert.strictEqual(g.allows('C:\\Users\\me\\.ssh\\id_rsa'), false);
  assert.strictEqual(g.allows('C:\\Users\\me\\.aws\\credentials'), false);
  assert.strictEqual(g.allows('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data'), false);
});

test('系统目录与应用自身配置目录始终拒绝授权', () => {
  const g = winStore();
  assert.throws(() => g.add('C:\\Windows\\System32\\drivers\\etc\\hosts', 'file'), /EPERM_SENSITIVE/);
  assert.throws(() => g.add('C:\\Users\\me\\AppData\\Roaming\\chatbot-zero\\secrets.json', 'file'), /EPERM_SENSITIVE/);
  assert.throws(() => g.add('C:\\Users\\me\\AppData\\Roaming\\chatbot-zero', 'dir'), /EPERM_SENSITIVE/);
});

test('相对路径拒绝授权', () => {
  const g = winStore();
  assert.throws(() => g.add('docs\\a.txt', 'file'), /EPERM_BAD_PATH/);
});

test('POSIX 平台：/etc 与 ~/.ssh 拒绝，/home/me/proj 放行', () => {
  const g = createGrantStore({ platform: 'linux', protectedPaths: ['/home/me/.config/chatbot'] });
  assert.strictEqual(g.allows('/home/me/proj/a.js'), false);
  g.add('/home/me/proj', 'dir');
  assert.strictEqual(g.allows('/home/me/proj/a.js'), true);
  assert.strictEqual(g.allows('/home/me/.ssh/id_ed25519'), false);
  assert.strictEqual(g.allows('/etc/passwd'), false);
  assert.throws(() => g.add('/etc', 'dir'), /EPERM_SENSITIVE/);
});

test('list / revokeAll', () => {
  const g = winStore();
  g.add('D:\\a', 'dir');
  g.add('D:\\b.txt', 'file');
  assert.strictEqual(g.list().length, 2);
  g.revokeAll();
  assert.strictEqual(g.list().length, 0);
  assert.strictEqual(g.allows('D:\\a\\x'), false);
});
