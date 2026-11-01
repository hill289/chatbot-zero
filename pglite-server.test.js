'use strict';
// pglite-server 集成测试：用原生 socket 走一遍 psql 的协议握手与查询流程
// （SSLRequest → StartupMessage → Simple/Extended Query → Terminate），
// 不依赖 psql 二进制，也不引入额外 npm 包。见 pglite-service.js。
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { startPgliteServer, stopPgliteServer, getPgliteStatus } = require('./pglite-service');
const { LogLevel } = require('./pglite-server');

// ── 极简 wire 协议客户端：缓冲 → 1 字节原始读（SSL 阶段）/ 按帧解析 ──
class TestClient {
  constructor(port, host) {
    this.buf = Buffer.alloc(0);
    this.pending = [];
    this.rawWaiter = null; // { n, resolve, reject }
    this.msgWaiters = []; // { type, resolve, reject }
    this.closed = false;
    this.sock = net.connect({ port, host });
    this.sock.on('data', (d) => this.pump(d));
    this.sock.on('error', (err) => {
      const w = this.rawWaiter;
      if (w) { this.rawWaiter = null; w.reject(err); }
      for (const mw of this.msgWaiters.splice(0)) mw.reject(err);
      if (!this.rawWaiter && this.msgWaiters.length === 0) this.closeErr = err;
    });
    this.sock.on('close', () => {
      this.closed = true;
      const w = this.rawWaiter;
      if (w) { this.rawWaiter = null; w.reject(new Error('连接被关闭')); }
      for (const mw of this.msgWaiters.splice(0)) mw.reject(new Error('连接被关闭'));
    });
    this.connected = new Promise((resolve, reject) => {
      this.sock.once('connect', resolve);
      this.sock.once('error', reject);
    });
  }

  pump(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);

    // 原始字节读（SSLRequest 只回一个无长度头的 'N'/'S'）
    while (this.rawWaiter) {
      if (this.buf.length === 0) break;
      const take = Math.min(this.rawWaiter.n, this.buf.length);
      const part = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      this.rawWaiter.n -= take;
      this.rawWaiter.parts.push(part);
      if (this.rawWaiter.n === 0) {
        const w = this.rawWaiter;
        this.rawWaiter = null;
        w.resolve(Buffer.concat(w.parts));
      }
    }

    // 成帧解析：type(1) + length(4) + payload(length-4)
    const got = [];
    while (this.buf.length >= 5) {
      const type = String.fromCharCode(this.buf[0]);
      const len = this.buf.readUInt32BE(1);
      if (len < 4 || this.buf.length < 1 + len) break;
      got.push({ type, payload: Buffer.from(this.buf.subarray(5, 1 + len)) });
      this.buf = this.buf.subarray(1 + len);
    }
    if (got.length) {
      this.pending.push(...got);
      for (const m of got) {
        const i = this.msgWaiters.findIndex((w) => w.type === m.type);
        if (i >= 0) {
          const w = this.msgWaiters.splice(i, 1)[0];
          w.resolve(m);
        }
      }
    }
  }

  sendRaw(buf) { this.sock.write(buf); }

  waitRawByte(n) {
    if (this.buf.length >= n) {
      const part = Buffer.from(this.buf.subarray(0, n));
      this.buf = this.buf.subarray(n);
      return Promise.resolve(part);
    }
    return new Promise((resolve, reject) => { this.rawWaiter = { n, parts: [], resolve, reject }; });
  }

  /** 取下一条指定类型的消息（已缓冲的优先，否则等待到达） */
  waitMsg(type) {
    const i = this.pending.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.pending.splice(i, 1)[0]);
    return new Promise((resolve, reject) => { this.msgWaiters.push({ type, resolve, reject }); });
  }

  /** 依次取到 ReadyForQuery 为止，返回途经的全部消息类型 */
  async drainUntilReady() {
    const types = [];
    for (;;) {
      const m = await this.waitOne();
      types.push(m.type);
      if (m.type === 'Z') return types;
      if (m.type === 'E') {
        // 错误也必须以 ReadyForQuery 收尾，继续 drain
        this.lastError = m;
      }
    }
  }

  waitOne() {
    if (this.pending.length) return Promise.resolve(this.pending.shift());
    return new Promise((resolve, reject) => {
      const w = { type: '*', resolve, reject };
      const check = () => {
        if (this.pending.length) {
          const i = this.msgWaiters.indexOf(w);
          if (i >= 0) this.msgWaiters.splice(i, 1);
          resolve(this.pending.shift());
          return true;
        }
        return false;
      };
      this.msgWaiters.push(w);
      if (!check()) {
        // 任意类型：轮询 pending（poll 简单可靠，量级很小）
        const timer = setInterval(() => {
          if (check()) clearInterval(timer);
          else if (this.closed) { clearInterval(timer); reject(new Error('连接被关闭')); }
        }, 5);
        this.sock.once('close', () => { clearInterval(timer); });
      }
    });
  }

  close() { try { this.sock.destroy(); } catch (_) { /* ignore */ } }
}

// ── 消息构造 ────────────────────────────────────────────────────
function sslRequest() {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(8, 0);
  buf.writeUInt32BE(80877103, 4); // 1234, 5679
  return buf;
}

function startupMessage(params = { user: 'postgres', database: 'postgres', client_encoding: 'UTF8' }) {
  const parts = [Buffer.from([0x00, 0x03, 0x00, 0x00])];
  for (const [k, v] of Object.entries(params)) {
    parts.push(Buffer.from(`${k}\0${v}\0`, 'utf8'));
  }
  parts.push(Buffer.from([0x00]));
  const body = Buffer.concat(parts);
  const buf = Buffer.alloc(4 + body.length);
  buf.writeUInt32BE(4 + body.length, 0);
  body.copy(buf, 4);
  return buf;
}

function simpleQuery(sql) {
  const sqlBuf = Buffer.from(`${sql}\0`, 'utf8');
  const buf = Buffer.alloc(1 + 4 + sqlBuf.length);
  buf.write('Q', 0);
  buf.writeUInt32BE(4 + sqlBuf.length, 1);
  sqlBuf.copy(buf, 5);
  return buf;
}

function identMessage(type, chunks) {
  const body = Buffer.concat(chunks);
  const buf = Buffer.alloc(1 + 4 + body.length);
  buf.write(type, 0);
  buf.writeUInt32BE(4 + body.length, 1);
  body.copy(buf, 5);
  return buf;
}

// Parse：statement 名(空) + 查询文本 + int16 参数类型数(0)
function parseMsg(sql) {
  const typeCount = Buffer.alloc(2); // int16 0 = 不指定参数类型
  return identMessage('P', [Buffer.from(`\0${sql}\0`, 'utf8'), typeCount]);
}

// Bind：portal\0 stmt\0 + int16 参数格式码数(0=全默认文本) + int16 参数数
//       + 每个参数 (int32 len + 文本字节) + int16 结果格式码数(0=全默认文本)
function bindMsg(params = []) {
  const chunks = [Buffer.from('\0', 'utf8'), Buffer.from('\0', 'utf8')]; // portal / statement 均为空名
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(params.length, 2);
  chunks.push(head);
  for (const p of params) {
    const value = Buffer.from(String(p), 'utf8');
    const len = Buffer.alloc(4);
    len.writeInt32BE(value.length, 0);
    chunks.push(len, value);
  }
  const tail = Buffer.alloc(2);
  tail.writeUInt16BE(0, 0);
  chunks.push(tail);
  return identMessage('B', chunks);
}

function describePortalMsg() { return identMessage('D', [Buffer.from('P\0', 'utf8')]); }

// Execute：portal 名(空,1B \0) + int32 max rows(0=不限) → body 恰好 5 字节
function executeMsg() {
  const b = Buffer.alloc(5);
  b.writeUInt32BE(0, 1);
  return identMessage('E', [b]);
}

function syncMsg() { return identMessage('S', []); }
function terminateMsg() { return identMessage('X', []); }

// ── 消息解码 ────────────────────────────────────────────────────
function decodeRowDescription(payload) {
  const nfields = payload.readUInt16BE(0);
  const fields = [];
  let off = 2;
  for (let i = 0; i < nfields; i++) {
    const end = payload.indexOf(0, off);
    const name = payload.toString('utf8', off, end);
    off = end + 1;
    off += 4 + 2 + 4 + 2 + 4; // tableOid, attnum, typeOid, typlen, atttypmod
    off += 2;                 // format
    fields.push(name);
  }
  return fields;
}

function decodeDataRow(payload) {
  const nfields = payload.readUInt16BE(0);
  const values = [];
  let off = 2;
  for (let i = 0; i < nfields; i++) {
    const len = payload.readInt32BE(off);
    off += 4;
    if (len < 0) { values.push(null); continue; }
    values.push(payload.toString('utf8', off, off + len));
    off += len;
  }
  return values;
}

function decodeError(payload) {
  // 若干 (byte 类型码 + 文本 + \0)，以 0x00 结尾；'M' = message
  let off = 0;
  let message = '';
  while (off < payload.length && payload[off] !== 0) {
    const code = String.fromCharCode(payload[off]);
    const end = payload.indexOf(0, off + 1);
    const text = payload.toString('utf8', off + 1, end);
    if (code === 'M') message = text;
    off = end + 1;
  }
  return message;
}

// ══════════════════════════════════════════════════════════════
test('pglite-server：psql 可连接并完成握手/查询', { timeout: 60000 }, async (t) => {
  const svc = await startPgliteServer({ port: 0, logLevel: LogLevel.Error });
  assert.ok(svc && svc.port > 0, '服务应监听到一个可用端口');

  const client = new TestClient(svc.port, '127.0.0.1');
  try {
    await client.connected;

    await t.test('1) SSLRequest → 回 N（不支持 SSL，与 psql 握手一致）', async () => {
      client.sendRaw(sslRequest());
      const byte = await client.waitRawByte(1);
      assert.strictEqual(byte.toString('latin1'), 'N');
    });

    await t.test('2) StartupMessage → AuthOk + ReadyForQuery', async () => {
      client.sendRaw(startupMessage());
      const types = await client.drainUntilReady();
      assert.ok(types.includes('R'), '应收到 AuthenticationOk');
      assert.ok(types.includes('K'), '应收到 BackendKeyData');
      assert.strictEqual(types[types.length - 1], 'Z', '握手应以 ReadyForQuery 收尾');
    });

    await t.test('3) Simple Query：select 1 返回行与 ReadyForQuery', async () => {
      client.sendRaw(simpleQuery('select 1 as n'));
      const types = await client.drainUntilReady();
      assert.ok(types.includes('T'), '应收到 RowDescription');
      assert.ok(types.includes('D'), '应收到 DataRow');
      assert.ok(types.includes('C'), '应收到 CommandComplete');
      assert.strictEqual(types[types.length - 1], 'Z');
    });

    await t.test('4) Simple Query：读回具体字段值', async () => {
      client.sendRaw(simpleQuery("select 'hello' as msg, 42 as num"));
      const fieldsMsg = await client.waitMsg('T');
      const rowMsg = await client.waitMsg('D');
      await client.drainUntilReady(); // 消费 C/Z，保持流对齐
      assert.deepStrictEqual(decodeRowDescription(fieldsMsg.payload), ['msg', 'num']);
      assert.deepStrictEqual(decodeDataRow(rowMsg.payload), ['hello', '42']);
    });

    await t.test('5) SQL 错误 → ErrorResponse 且仍以 ReadyForQuery 收尾', async () => {
      client.sendRaw(simpleQuery('select * from definitely_not_exists_tbl'));
      const types = await client.drainUntilReady();
      assert.ok(types.includes('E'), '应收到 ErrorResponse');
      assert.strictEqual(types[types.length - 1], 'Z');
      assert.ok(decodeError(client.lastError.payload).length > 0, '错误消息不应为空');
    });

    await t.test('6) Extended Query（Parse/Bind/Describe/Execute/Sync）', async () => {
      const sentValue = 'extended-hello';
      client.sendRaw(Buffer.concat([
        parseMsg('select $1::text as v'),
        bindMsg([sentValue]),
        describePortalMsg(),
        executeMsg(),
        syncMsg(),
      ]));
      const types = [];
      const byType = {};
      for (;;) {
        const m = await client.waitOne();
        types.push(m.type);
        (byType[m.type] = byType[m.type] || []).push(m);
        if (m.type === 'E') client.lastError = m;
        if (m.type === 'Z') break;
      }
      const got = types.join(',');
      const errText = types.includes('E') && client.lastError
        ? `；服务端报错=${decodeError(client.lastError.payload)}`
        : '';
      assert.ok(types.includes('1'), `应收到 ParseComplete，实际收到：${got}${errText}`);
      assert.ok(types.includes('2'), `应收到 BindComplete，实际收到：${got}${errText}`);
      assert.ok(types.includes('T'), `应收到 RowDescription，实际收到：${got}${errText}`);
      assert.ok(types.includes('D'), `应收到 DataRow，实际收到：${got}${errText}`);
      assert.strictEqual(types[types.length - 1], 'Z');
      assert.deepStrictEqual(decodeRowDescription(byType['T'][0].payload), ['v']);
      assert.deepStrictEqual(decodeDataRow(byType['D'][0].payload), [sentValue]);
    });

    await t.test('7) 多客户端并发可连', async () => {
      const c2 = new TestClient(svc.port, '127.0.0.1');
      try {
        await c2.connected;
        c2.sendRaw(sslRequest());
        assert.strictEqual((await c2.waitRawByte(1)).toString('latin1'), 'N');
        c2.sendRaw(startupMessage());
        const types = await c2.drainUntilReady();
        assert.strictEqual(types[types.length - 1], 'Z');
      } finally { c2.close(); }
    });

    await t.test('8) Terminate → 服务端关闭连接', async () => {
      client.sendRaw(terminateMsg());
      await new Promise((resolve) => {
        if (client.closed) return resolve();
        client.sock.once('close', resolve);
        setTimeout(resolve, 3000);
      });
      assert.ok(client.closed, '连接应被服务端关闭');
    });
  } finally {
    client.close();
    await stopPgliteServer();
  }

  assert.strictEqual(getPgliteStatus(), null, '停止后状态应为 null');
});
