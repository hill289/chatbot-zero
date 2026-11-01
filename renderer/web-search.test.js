/*!
 * web-search.test.js — web-search.js 解析逻辑的 Node 自检（零依赖）
 * 运行： node renderer/web-search.test.js
 */
'use strict';
const W = require('./web-search.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

group('decodeEntities / stripTags');
{
  eq(W.decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39;'), "a & b <c> 'd'", '实体解码');
  eq(W.stripTags('<b>Hello</b> <i>world</i>'), 'Hello world', '去标签+折叠空白');
}

group('normalizeUrl');
{
  eq(W.normalizeUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x'),
    'https://example.com/a?b=1', 'uddg 解码');
  eq(W.normalizeUrl('//example.com/x'), 'https://example.com/x', 'protocol-relative');
  eq(W.normalizeUrl('https://a.com'), 'https://a.com', '原样');
}

const FIXTURE_HTML = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=1">First <b>Result</b></a>
  </h2>
  <a class="result__snippet" href="#">This is the <b>first</b> snippet &amp; more.</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Ftwo&rut=2">Second Result</a>
  </h2>
  <div class="result__snippet">Second snippet text.</div>
</div>`;

group('parseDuckDuckGoHtml');
{
  const list = W.parseDuckDuckGoHtml(FIXTURE_HTML, 10);
  eq(list.length, 2, '解析出 2 条');
  eq(list[0].title, 'First Result', '标题去标签');
  eq(list[0].url, 'https://example.com/one', '链接解码');
  eq(list[0].snippet, 'This is the first snippet & more.', '摘要');
  eq(list[1].url, 'https://example.org/two', '第二条链接');
  eq(W.parseDuckDuckGoHtml(FIXTURE_HTML, 1).length, 1, 'limit 生效');
}

group('parseInstantAnswer');
{
  const json = {
    Heading: 'Example', AbstractURL: 'https://example.com', AbstractText: 'An abstract.',
    RelatedTopics: [
      { FirstURL: 'https://a.com', Text: 'Topic A' },
      { Name: 'Group', Topics: [{ FirstURL: 'https://b.com', Text: 'Topic B' }] }
    ]
  };
  const list = W.parseInstantAnswer(json);
  ok(list.length >= 3, '含 abstract + 展开的 related');
  eq(list[0].url, 'https://example.com', 'abstract 优先');
  ok(list.some(x => x.url === 'https://b.com'), '嵌套 Topics 展开');
}

const BING_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>必应：示例 搜索</title>
<item>
  <title>First &amp; Bing Result</title>
  <link>https://example.com/one?a=1&amp;b=2</link>
  <description>This is the &lt;b&gt;first&lt;/b&gt; snippet &amp;amp; more.</description>
</item>
<item>
  <title><![CDATA[Second Result]]></title>
  <link>https://example.org/two</link>
  <description><![CDATA[Second snippet text.]]></description>
</item>
<item><title></title><link>https://empty.example</link><description>无标题应被跳过</description></item>
</channel></rss>`;

group('parseBingRss');
{
  const list = W.parseBingRss(BING_RSS, 10);
  eq(list.length, 2, '解析出 2 条（空标题被跳过）');
  eq(list[0].title, 'First & Bing Result', '标题实体解码');
  eq(list[0].url, 'https://example.com/one?a=1&b=2', '链接实体解码');
  ok(list[0].snippet.indexOf('first') >= 0, '摘要去标签');
  eq(list[1].title, 'Second Result', 'CDATA 标题');
  eq(W.parseBingRss(BING_RSS, 1).length, 1, 'limit 生效');
  eq(W.parseBingRss('<html><body>blocked</body></html>', 5).length, 0, '非 RSS 返回空数组');
}

const BING_HTML = `
<ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/one" h="ID=SERP,1">First <strong>Result</strong></a></h2>
<div class="b_caption"><p class="b_lineclamp2">This is the <b>first</b> snippet &amp; more.</p></div></li>
<li class="b_algo b_algoBorder"><h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy90d28&ntb=1">Second Result</a></h2>
<p>Second snippet text.</p></li>
<li class="b_algo"><h2><a href="https://nop.example">No snippet</a></h2></li>
</ol>`;

group('parseBingHtml');
{
  const list = W.parseBingHtml(BING_HTML, 10);
  eq(list.length, 3, '解析出 3 条');
  eq(list[0].title, 'First Result', '标题去标签');
  eq(list[0].url, 'https://example.com/one', '直链保留');
  eq(list[0].snippet, 'This is the first snippet & more.', '摘要');
  eq(list[1].url, 'https://example.org/two', 'bing.com/ck/a 包装解码');
  eq(list[2].snippet, '', '无摘要为空串');
  eq(W.parseBingHtml(BING_HTML, 1).length, 1, 'limit 生效');
  eq(W.parseBingHtml('<div>验证码</div>', 5).length, 0, '验证页返回空数组');
}

group('normalizeProvider / bing endpoints');
{
  eq(W.normalizeProvider('Bing'), 'bing', '大小写归一');
  eq(W.normalizeProvider(undefined), 'auto', '缺省 auto');
  ok(W.bingRssEndpoint('a b', { count: 5 }).indexOf('format=rss') >= 0, 'rss endpoint 带 format=rss');
  eq(W.bingRssEndpoint('a b').indexOf('q=a%20b') >= 0, true, 'bing endpoint 编码');
  ok(W.bingHtmlEndpoint('a').indexOf('www.bing.com/search') >= 0, 'html endpoint');
}

group('formatResults / endpoints');
{
  const s = W.formatResults('hello', [{ title: 'T', url: 'https://x', snippet: 'S' }]);
  ok(s.indexOf('hello') >= 0 && s.indexOf('https://x') >= 0 && s.indexOf('read_url') >= 0, '结果格式含 query/url/提示');
  ok(W.formatResults('none', []).indexOf('没有返回结果') >= 0, '空结果文案');
  eq(W.htmlEndpoint('a b'), 'https://html.duckduckgo.com/html/?q=a%20b', 'html endpoint 编码');
  ok(W.apiEndpoint('a').indexOf('format=json') >= 0, 'api endpoint');
}

// ── search() 编排与回退链（注入 _fetchText，全程零网络）──────────
const RSS_OK  = '<rss><channel><item><title>RSS Hit</title><link>https://rss.example/a</link>'
              + '<description>snippet A</description></item></channel></rss>';
const BLOCKED = '<html><body><div id="b_results"></div>captcha</body></html>';
const HTML_OK = '<ol><li class="b_algo"><h2><a href="https://html.example/b">HTML Hit</a></h2>'
              + '<p>snippet B</p></li></ol>';
const DDG_OK  = '<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2Fc">DDG Hit</a>'
              + '<a class="result__snippet" href="#">snippet C</a></div>';
const IA_OK   = JSON.stringify({ Heading: 'IA', AbstractURL: 'https://ia.example', AbstractText: 'abstract d' });

function stubFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    for (const r of routes) if (r[0].test(url)) return { ok: true, status: 200, text: r[1] };
    return { ok: false, status: 403, text: '' };
  };
  return { calls, f };
}
function searchWith(routes, params) {
  const s = stubFetch(routes);
  return { calls: s.calls, p: W.search(Object.assign({ query: 'x', _fetchText: s.f }, params || {})) };
}

async function testFallbackChain() {
  group('search() 回退链');
  let r = searchWith([[/format=rss/, BLOCKED], [/bing\.com\/search/, HTML_OK]]);
  let txt = await r.p;
  ok(txt.indexOf('来源：Bing）') >= 0, 'Bing RSS 被拦后回退 Bing HTML');
  eq(r.calls.length, 2, '回退时共 2 次抓取');

  r = searchWith([[/bing\.com/, BLOCKED], [/duckduckgo\.com\/html/, DDG_OK]]);
  txt = await r.p;
  ok(txt.indexOf('来源：DuckDuckGo）') >= 0, 'Bing 全挂后回退 DuckDuckGo');
  eq(r.calls.length, 3, 'Bing RSS + Bing HTML + DDG = 3 次');

  r = searchWith([[/bing\.com/, BLOCKED], [/html\.duckduckgo/, BLOCKED], [/api\.duckduckgo/, IA_OK]]);
  txt = await r.p;
  ok(txt.indexOf('来源：DuckDuckGo IA') >= 0, '最后的 Instant Answer 兜底');

  r = searchWith([]);
  txt = await r.p;
  ok(txt.indexOf('未获得结果') >= 0, '全部失败给出明确文案');
  ok(txt.indexOf('Bing RSS 请求失败') >= 0 && txt.indexOf('Instant Answer 请求失败') >= 0, '诊断按顺序列出 4 条失败原因');
  eq(r.calls.length, 4, 'auto 全链路最多 4 次抓取');

  r = searchWith([[/bing\.com/, BLOCKED]], { provider: 'bing-rss' });
  await r.p;
  eq(r.calls.length, 1, 'provider=bing-rss 只抓 RSS，不回退');
  ok(r.calls[0].indexOf('format=rss') >= 0, '且请求的是 RSS 端点');

  r = searchWith([[/format=rss/, RSS_OK], [/bing\.com\/search/, HTML_OK]]);
  txt = await r.p;
  ok(txt.indexOf('来源：Bing RSS') >= 0, 'RSS 正常时首次命中即返回');
  eq(r.calls.length, 1, '命中即返回，不做多余请求');

  r = searchWith([[/format=rss/, RSS_OK], [/bing\.com\/search/, HTML_OK]], { provider: 'bing-html' });
  txt = await r.p;
  ok(txt.indexOf('来源：Bing）') >= 0, 'provider=bing-html 跳过 RSS');
  eq(r.calls.length, 1, '只抓 1 次');
}

testFallbackChain().then(function () {
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
}).catch(function (e) {
  console.error('测试异常：', e);
  process.exitCode = 1;
});
