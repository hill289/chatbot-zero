/* renderer/job-store.test.js —— 后台任务落盘存储单测（node --test） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJobStore } = require('./job-store.js');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobstore-'));
  return { dir, store: createJobStore({ dir }) };
}

test('保存 / 读取 / 列表按时间倒序', () => {
  const { store } = tmpStore();
  store.save({ id: 'job-1', command: 'sleep 1', status: 'exited', startedAt: 1000 });
  store.save({ id: 'job-2', command: 'npm run dev', status: 'running', startedAt: 2000 });
  const list = store.list();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, 'job-2');
  assert.strictEqual(store.read('job-1').command, 'sleep 1');
});

test('输出追加与按字符偏移切片（跨重启可续读）', () => {
  const { store } = tmpStore();
  store.save({ id: 'j', command: 'x', status: 'running', startedAt: 1 });
  store.append('j', 'stdout', 'hello ');
  store.append('j', 'stdout', 'world');
  store.append('j', 'stderr', 'warn');
  const s1 = store.slice('j', 'stdout', 0, 5);
  assert.strictEqual(s1.text, 'hello');
  assert.strictEqual(s1.hasMore, true);
  const s2 = store.slice('j', 'stdout', s1.nextOffset, 100);
  assert.strictEqual(s2.text, ' world');
  assert.strictEqual(store.slice('j', 'stderr', 0, 100).text, 'warn');
});

test('启动时把 running 标记为 interrupted，并给出续跑提示', () => {
  const { store } = tmpStore();
  store.save({ id: 'a', status: 'running', startedAt: 1, command: 'npm run dev' });
  store.save({ id: 'b', status: 'exited', startedAt: 2, command: 'ls' });
  const touched = store.markInterrupted(999);
  assert.strictEqual(touched.length, 1);
  assert.strictEqual(store.read('a').status, 'interrupted');
  assert.ok(store.read('a').hint.includes('job_resume'));
  assert.strictEqual(store.read('b').status, 'exited');
});

test('删除任务会清掉记录与日志', () => {
  const { store } = tmpStore();
  store.save({ id: 'd', status: 'exited', startedAt: 1 });
  store.append('d', 'stdout', 'x');
  store.remove('d');
  assert.strictEqual(store.read('d'), null);
  assert.strictEqual(store.readAll('d', 'stdout'), '');
});

test('非法 id 被清洗，不会路径穿越', () => {
  const { store } = tmpStore();
  store.save({ id: '../../evil', status: 'exited', startedAt: 1 });
  assert.ok(!fs.existsSync(path.join(store.dir, '..', 'evil.json')));
  assert.ok(fs.existsSync(path.join(store.dir, 'evil.json')));
});
