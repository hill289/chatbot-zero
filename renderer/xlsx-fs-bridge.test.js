/*!
 * xlsx-fs-bridge.test.js — xlsx-fs-bridge.js 的 Node 自检（零依赖）
 * 运行： node renderer/xlsx-fs-bridge.test.js
 *
 * 用假 XLSX + 假 fs 验证：readFile/writeFile 确实改走 fs + XLSX.read/write(buffer)，
 * opts 透传且 type 强制 buffer，readFile(Sync)/writeFile(Sync) 别名，幂等，异常输入返回 false。
 */
'use strict';
const { bridgeXlsxFileApi } = require('./xlsx-fs-bridge.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

// 假 XLSX：read(buffer, opts) / write(wb, opts) / readFile、writeFile 故意抛「Cannot access file」
function fakeXlsx() {
  return {
    read(buf, opts) { return { via: 'read', bufferLen: buf && buf.length, opts: opts }; },
    write(wb, opts) { return new Uint8Array([1, 2, 3, 4]); },
    readFile() { throw new Error('Cannot access file'); },
    writeFile() { throw new Error('cannot save file'); }
  };
}
function fakeFs(store) {
  return {
    readFileSync(p) {
      if (!Object.prototype.hasOwnProperty.call(store, p)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; }
      return store[p];
    },
    writeFileSync(p, data) { store[p] = data; }
  };
}

group('readFile → fs.readFileSync + XLSX.read(buffer)');
{
  const x = fakeXlsx();
  const store = { '/home/pyodide/a.xlsx': new Uint8Array([9, 9, 9]) };
  ok(bridgeXlsxFileApi(x, fakeFs(store)) === true, 'bridge 返回 true');
  const r = x.readFile('/home/pyodide/a.xlsx', { sheet: 'S', cellDates: true });
  eq(r.via, 'read', '走了 XLSX.read');
  eq(r.bufferLen, 3, '把 fs 读到的 3 字节交给 XLSX.read');
  eq(r.opts.type, 'buffer', 'type 被强制为 buffer');
  eq(r.opts.sheet, 'S', '其余 opts.sheet 保留');
  eq(r.opts.cellDates, true, '其余 opts.cellDates 保留');
  ok(x.readFile === x.readFileSync, 'readFile === readFileSync');
}

group('readFile 无 opts 也可用');
{
  const x = fakeXlsx();
  bridgeXlsxFileApi(x, fakeFs({ '/x.xlsx': new Uint8Array([1]) }));
  const r = x.readFile('/x.xlsx');
  eq(r.opts.type, 'buffer', '缺省 opts 仍 type=buffer');
  eq(r.bufferLen, 1, '读到 1 字节');
}

group('writeFile → XLSX.write(buffer) + fs.writeFileSync');
{
  const x = fakeXlsx();
  const store = {};
  bridgeXlsxFileApi(x, fakeFs(store));
  x.writeFile({ a: 1 }, '/home/pyodide/b.xlsx', { bookType: 'xlsx' });
  ok(store['/home/pyodide/b.xlsx'] && store['/home/pyodide/b.xlsx'].length === 4, 'writeFile 把 write() 的 4 字节写进 fs');
  ok(x.writeFile === x.writeFileSync, 'writeFile === writeFileSync');
}

group('幂等 + 异常输入');
{
  const x = fakeXlsx(); const fs = fakeFs({});
  bridgeXlsxFileApi(x, fs);
  const first = x.readFile;
  bridgeXlsxFileApi(x, fs);
  ok(x.readFile === first, '重复调用不二次包裹（幂等）');

  ok(bridgeXlsxFileApi(null, {}) === false, 'null XLSX → false');
  ok(bridgeXlsxFileApi({}, {}) === false, '缺 read/write → false');
}

console.log('\n' + (fail ? 'FAIL ' : 'PASS ') + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
