/* renderer/config-file.test.js —— Interface 配置固化（配置文件）纯逻辑单测（node --test） */
const test = require('node:test');
const assert = require('node:assert');
const CF = require('./config-file.js');

function richStore() {
  return {
    apiKey: 'sk-secret-real',
    url: 'https://api.deepseek.com',
    path: '/chat/completions',
    model: 'deepseek-chat',
    authPrefix: 'Bearer',
    contentType: 'application/json',
    method: 'POST',
    stream: true,
    mcp: true,
    cacheMode: true,
    multimodalEnabled: true,
    max_tokens_type: 'max_tokens',
    max_tokens_value: '',
    temperature: '0.7',
    top_p: '0.9',
    disabledTools: ['read_url'],
    mcpUrls: ['https://x/mcp'],
    providers: [
      { id: 'ds', name: 'DeepSeek', url: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-provider-1' }
    ],
    activeProviderId: 'ds',
    subagentProviderId: '',
    subagentModel: '',
    loopGuard: { maxSteps: 30, softRepeat: 3, hardRepeat: 5, maxErrorRepeat: 3 },
    approval: { enabled: true, tools: ['write_file'], timeoutSec: 300 },
    contextWindowTokens: 1048576,
    hardCutRatio: 0.85,
    hardCutEnabled: true,
    memory: { enabled: false, recallLimit: 6 },
    sandbox: { enabled: true, mode: 'auto' },
    sshHosts: [
      { host: '1.2.3.4', port: 22, username: 'root', password: 'p@ss' }
    ],
    // 迁移标记等运行时状态：不应进入文件
    ctxWindowMigrated1M: true,
    ctxWindowMigrated1Mv2: true
  };
}

test('pickFileConfig：包含接口配置键，排除密钥与迁移标记', () => {
  const cfg = CF.pickFileConfig(richStore());
  // 基本键存在
  assert.strictEqual(cfg.url, 'https://api.deepseek.com');
  assert.strictEqual(cfg.model, 'deepseek-chat');
  assert.deepStrictEqual(cfg.disabledTools, ['read_url']);
  // 密钥不落文件
  assert.ok(!('apiKey' in cfg), 'apiKey 不应出现');
  assert.ok(!('apiKey' in cfg.providers[0]), 'provider.apiKey 不应出现');
  assert.ok(!('password' in cfg.sshHosts[0]), 'ssh.password 不应出现');
  // 运行时迁移标记不落文件
  assert.ok(!('ctxWindowMigrated1M' in cfg), '迁移标记不应出现');
  assert.ok(!('ctxWindowMigrated1Mv2' in cfg), '迁移标记不应出现');
});

test('pickFileConfig 不修改原 store（深拷贝隔离）', () => {
  const store = richStore();
  const cfg = CF.pickFileConfig(store);
  cfg.providers[0].url = 'changed';
  cfg.temperature = '9';
  assert.strictEqual(store.providers[0].url, 'https://api.deepseek.com');
  assert.strictEqual(store.temperature, '0.7');
});

test('applyFileConfig：应用白名单值，保留内存中的真实密钥', () => {
  const store = richStore();               // 内存里有真实密钥
  const fileCfg = {
    url: 'https://new.example.com',
    model: 'gpt-4o',
    temperature: '0.2',
    providers: [{ id: 'ds', name: 'DeepSeek', url: 'https://new.example.com', model: 'gpt-4o' }], // 文件里没有 apiKey
    sshHosts: [{ host: '1.2.3.4', port: 22, username: 'root' }]                                  // 文件里没有 password
  };
  CF.applyFileConfig(store, fileCfg);
  assert.strictEqual(store.url, 'https://new.example.com');
  assert.strictEqual(store.model, 'gpt-4o');
  assert.strictEqual(store.temperature, '0.2');
  // 密钥被保留，不被空串覆盖
  assert.strictEqual(store.apiKey, 'sk-secret-real');
  assert.strictEqual(store.providers[0].apiKey, 'sk-provider-1');
  assert.strictEqual(store.sshHosts[0].password, 'p@ss');
});

test('applyFileConfig：兼容包裹结构 { chatbotStore: {...} }', () => {
  const store = richStore();
  CF.applyFileConfig(store, { chatbotStore: { url: 'https://wrapped.example.com', model: 'm-x' } });
  assert.strictEqual(store.url, 'https://wrapped.example.com');
  assert.strictEqual(store.model, 'm-x');
  // 未在文件中的键保持不变
  assert.strictEqual(store.path, '/chat/completions');
});

test('round-trip：pick → apply 可还原全部非密钥接口配置', () => {
  const a = richStore();
  const fileCfg = CF.pickFileConfig(a);           // 写文件
  const b = Object.assign({}, a);                  // 模拟另一份同源内存（含密钥）
  b.url = 'stale'; b.model = 'stale';
  CF.applyFileConfig(b, fileCfg);                  // 改文件后回读
  assert.strictEqual(b.url, a.url);
  assert.strictEqual(b.model, a.model);
  assert.deepStrictEqual(b.disabledTools, a.disabledTools);
  assert.deepStrictEqual(b.loopGuard, a.loopGuard);
  // 密钥仍在
  assert.strictEqual(b.apiKey, 'sk-secret-real');
});

test('looksLikeConfig：识别有效配置 vs 空/无关对象', () => {
  assert.strictEqual(CF.looksLikeConfig({ url: 'x' }), true);
  assert.strictEqual(CF.looksLikeConfig({ chatbotStore: { model: 'm' } }), true);
  assert.strictEqual(CF.looksLikeConfig({}), false);
  assert.strictEqual(CF.looksLikeConfig({ foo: 1 }), false);
  assert.strictEqual(CF.looksLikeConfig(null), false);
});

test('stripSecrets：清空所有密钥字段但保留其它', () => {
  const s = CF.stripSecrets(richStore());
  assert.strictEqual(s.apiKey, '');
  assert.strictEqual(s.providers[0].apiKey, '');
  assert.strictEqual(s.sshHosts[0].password, '');
  assert.strictEqual(s.url, 'https://api.deepseek.com');
});
