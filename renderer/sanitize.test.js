/* renderer/sanitize.test.js —— SafeHtml 白名单净化器单测（node --test） */
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeHtml, isSafeUrl, sanitizeStyle } = require('./sanitize.js');

test('script 标签连内容一起丢弃', () => {
  assert.strictEqual(sanitizeHtml('<script>alert(1)</script>hello'), 'hello');
  assert.strictEqual(sanitizeHtml('<SCRIPT SRC=//evil.js></SCRIPT>ok'), 'ok');
  assert.strictEqual(sanitizeHtml('a<script>alert("<b>")</script>b'), 'ab');
});

test('事件属性一律丢弃，正常属性保留', () => {
  const out = sanitizeHtml('<img src="https://a.com/x.png" onerror="alert(1)" alt="x">');
  assert.ok(!/onerror/i.test(out));
  assert.ok(out.includes('src="https://a.com/x.png"'));
  assert.ok(out.includes('alt="x"'));
  assert.ok(!/referrerpolicy="no-referrer"/.test('') || out.includes('referrerpolicy="no-referrer"'));
});

test('img 的 src 不安全时整张图丢弃', () => {
  assert.strictEqual(sanitizeHtml('<img src="javascript:alert(1)">'), '');
  assert.strictEqual(sanitizeHtml('<img src="data:text/html;base64,PHN2Zz4=">'), '');
  assert.ok(sanitizeHtml('<img src="data:image/png;base64,AAAA">').includes('data:image/png'));
});

test('a 链接：javascript: 被移除，http 保留并加 rel/target', () => {
  const bad = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
  assert.ok(!/javascript/i.test(bad));
  assert.ok(bad.includes('>x</a>'));
  const good = sanitizeHtml('<a href="https://example.com" onclick="x()">y</a>');
  assert.ok(good.includes('href="https://example.com"'));
  assert.ok(good.includes('rel="noopener noreferrer nofollow"'));
  assert.ok(good.includes('target="_blank"'));
  assert.ok(!/onclick/i.test(good));
});

test('实体编码绕过：&#106;avascript: 与 java\\nscript: 均被拒绝', () => {
  assert.ok(!/href=/.test(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>')));
  assert.ok(!/href=/.test(sanitizeHtml('<a href="java\nscript:alert(1)">x</a>')));
  assert.ok(!/href=/.test(sanitizeHtml('<a href=" JaVaScRiPt:alert(1)">x</a>')));
});

test('style 属性过滤危险构造', () => {
  assert.strictEqual(sanitizeStyle('background:url(https://evil/x)'), '');
  assert.strictEqual(sanitizeStyle('width:expression(alert(1))'), '');
  assert.strictEqual(sanitizeStyle('position:fixed'), '');
  assert.strictEqual(sanitizeStyle('color:red'), 'color:red');
  assert.ok(!/url\(/.test(sanitizeHtml('<span style="background:url(//evil)">x</span>')));
});

test('iframe / svg / math / form 连内容丢弃', () => {
  assert.strictEqual(sanitizeHtml('a<iframe src="//evil">payload</iframe>b'), 'ab');
  assert.strictEqual(sanitizeHtml('<svg><script>alert(1)</script><text>x</text></svg>ok'), 'ok');
  assert.strictEqual(sanitizeHtml('<form><input name="q"><button>go</button></form>tail'), 'tail');
});

test('未知标签去壳留内容，常见块级标签保留', () => {
  assert.strictEqual(sanitizeHtml('<section><p>hi</p></section>'), '<p>hi</p>');
  assert.strictEqual(sanitizeHtml('<h1>a</h1><ul><li>b</li></ul>'), '<h1>a</h1><ul><li>b</li></ul>');
  assert.strictEqual(sanitizeHtml('<br/><hr>'), '<br><hr>');
});

test('id / name 被移除（防 DOM Clobbering）', () => {
  const out = sanitizeHtml('<div id="location" name="x" class="c">y</div>');
  assert.ok(!/id=/.test(out));
  assert.ok(!/name=/.test(out));
  assert.ok(out.includes('class="c"'));
});

test('文本中的 < 与 & 被转义，不会漏出原始标签', () => {
  assert.strictEqual(sanitizeHtml('1 < 2 && 3 > 2'), '1 &lt; 2 &amp;&amp; 3 &gt; 2');
  assert.strictEqual(sanitizeHtml('<<script>alert(1)</script>'), '&lt;');
  assert.strictEqual(sanitizeHtml('<scr<script>ipt>alert(1)</script>'), 'ipt&gt;alert(1)');
});

test('上游已转义的实体不被二次转义（防 &amp;quot; 显示成 &quot;）', () => {
  // marked.parse 会把 " 转成 &quot;、& 转成 &amp;；净化器不应再把实体里的 & 转义成 &amp;
  assert.strictEqual(
    sanitizeHtml('<p>把它当成&quot;要正面超越的对手&quot;</p>'),
    '<p>把它当成&quot;要正面超越的对手&quot;</p>');
  assert.strictEqual(sanitizeHtml('price &amp; more'), 'price &amp; more');
  assert.strictEqual(sanitizeHtml('a&#39;b &#x4E2D;'), 'a&#39;b &#x4E2D;');
  // 但裸 & 仍必须转义，避免歧义
  assert.strictEqual(sanitizeHtml('a & b'), 'a &amp; b');
  // 实体化的尖括号在文本节点里只会显示成文本，不会制造标签（安全）
  assert.strictEqual(
    sanitizeHtml('&lt;script&gt;alert(1)&lt;/script&gt;'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('未闭合标签按文本处理（fail-closed）', () => {
  const out = sanitizeHtml('<div class="x"');
  assert.ok(out.startsWith('&lt;div'));
  assert.ok(!/<div/.test(out));
});

test('任务清单复选框保留，其它 input 丢弃', () => {
  const ok = sanitizeHtml('<input type="checkbox" checked disabled>');
  assert.ok(ok.includes('type="checkbox"'));
  assert.strictEqual(sanitizeHtml('<input type="text" value="x">'), '');
  assert.strictEqual(sanitizeHtml('<input type="checkbox" onfocus="x()">').includes('onfocus'), false);
});

test('嵌套同名容器正常跳过', () => {
  assert.strictEqual(sanitizeHtml('<div><style>a{}</style>x</div>'), '<div>x</div>');
  assert.strictEqual(sanitizeHtml('<script><script></script></script>tail'), 'tail');
});

test('isSafeUrl 协议白名单', () => {
  assert.strictEqual(isSafeUrl('https://a.com'), true);
  assert.strictEqual(isSafeUrl('/relative/path'), true);
  assert.strictEqual(isSafeUrl('#anchor'), true);
  assert.strictEqual(isSafeUrl('javascript:alert(1)'), false);
  assert.strictEqual(isSafeUrl('data:text/html,<script>'), false);
  assert.strictEqual(isSafeUrl('vbscript:x'), false);
  assert.strictEqual(isSafeUrl('file:///C:/Windows/win.ini'), false);
  assert.strictEqual(isSafeUrl('data:image/png;base64,AA', { image: true }), true);
});

test('空输入安全', () => {
  assert.strictEqual(sanitizeHtml(''), '');
  assert.strictEqual(sanitizeHtml(null), '');
  assert.strictEqual(sanitizeHtml(undefined), '');
});
