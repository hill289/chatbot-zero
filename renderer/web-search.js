/*!
 * web-search.js — 网页搜索（Web Search）能力
 * =============================================================================
 * 对齐 dsh 的 `web/` 能力系列：read_url 只能抓「已知 URL」，而研究/查错/选型
 * 往往需要先「搜索」。本模块补上 web_search。
 *
 * 引擎：默认 **Bing**。
 *   · Bing 官方 Web Search API（Azure Bing Search v7）已于 2025-08-11 退役，
 *     没有可免 key 的官方接口，因此这里走「结果页抓取」：
 *       - 首选 Bing RSS：`/search?q=...&format=rss`（RSS 2.0 XML，结构稳定、体积小）
 *       - 次选 Bing HTML：`/search?q=...` 解析 `li.b_algo`
 *   · DuckDuckGo（HTML 结果页 / Instant Answer JSON）保留为兜底与显式可选项。
 *
 * 结构约束：
 *   · 解析逻辑（Bing RSS / Bing HTML / DuckDuckGo HTML / Instant Answer）是纯函数、
 *     UMD、可 node 单测；
 *   · 抓取走两条路：
 *       - Electron 外壳：window.searchAPI.fetchText → 主进程 net.fetch（无 CORS）；
 *       - 纯浏览器：直接 fetch（可能被 CORS 拦）。
 *   · 只回 title + url + snippet（体积小），需要正文再用 read_url 打开链接。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WebSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = { limit: 8, maxLimit: 20, timeoutMs: 15000 };

  // 搜索结果页选择器里可能出现的实体（含十六进制），统一解码
  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#39;/gi, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#x2F;/gi, '/')
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) {
        try { return String.fromCharCode(parseInt(n, 16)); } catch (e) { return _; }
      })
      .replace(/&#(\d+);/g, function (_, n) {
        try { return String.fromCharCode(parseInt(n, 10)); } catch (e) { return _; }
      });
  }

  function stripTags(s) {
    return decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  // RSS / Atom 里常见 <![CDATA[ ... ]]>
  function unwrapCdata(s) {
    return String(s == null ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  }

  function clampLimit(limit) {
    return Math.max(1, Math.min(Number(limit) || DEFAULTS.limit, DEFAULTS.maxLimit));
  }

  function cut(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function errText(e, fallback) {
    return (e && e.message) ? e.message : String(e || fallback);
  }

  // ── URL 规整 ────────────────────────────────────────────────
  // DuckDuckGo 的结果链接常被包成 //duckduckgo.com/l/?uddg=<encoded>
  function normalizeUrl(href) {
    href = decodeEntities(String(href == null ? '' : href)).trim();
    if (!href) return '';
    var m = href.match(/[?&]uddg=([^&]+)/i);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
    }
    if (href.indexOf('//') === 0) return 'https:' + href;
    return href;
  }

  function b64UrlDecode(s) {
    try {
      s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(s, 'base64').toString('utf8');
      if (typeof atob === 'function') {
        var bin = atob(s);
        if (typeof TextDecoder !== 'undefined') {
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder('utf-8').decode(bytes);
        }
        return bin;
      }
    } catch (_) { /* 解码失败则按原链接返回 */ }
    return '';
  }

  // Bing 多数返回真实链接；但部分区域会把结果包成 bing.com/ck/a?...&u=a1<base64url>
  function normalizeBingUrl(href) {
    href = decodeEntities(String(href == null ? '' : href)).trim();
    if (!href) return '';
    if (href.indexOf('//') === 0) href = 'https:' + href;
    if (/bing\.com\/ck\/a/i.test(href)) {
      var m = href.match(/[?&]u=a1([A-Za-z0-9_\-%]+)/);
      if (m) {
        var dec = b64UrlDecode(decodeURIComponent(m[1]));
        if (dec && /^https?:\/\//i.test(dec)) return dec;
      }
    }
    return href;
  }

  // ── 解析器：Bing ────────────────────────────────────────────

  function pickTag(block, tag) {
    var m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(String(block || ''));
    return m ? m[1] : '';
  }

  function pickAttr(block, tag, attr) {
    var m = new RegExp('<' + tag + '\\b[^>]*\\b' + attr + '="([^"]*)"[^>]*>', 'i').exec(String(block || ''));
    return m ? m[1] : '';
  }

  // Bing RSS：<rss><channel><item><title/><link/><description/></item>…</channel></rss>
  function parseBingRss(xml, limit) {
    xml = String(xml == null ? '' : xml);
    limit = clampLimit(limit);
    var out = [];
    var re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    var m;
    while ((m = re.exec(xml)) && out.length < limit) {
      var block = m[1];
      var title = stripTags(unwrapCdata(pickTag(block, 'title')));
      if (!title) continue;
      var link = unwrapCdata(pickTag(block, 'link')) || pickAttr(block, 'link', 'href');
      var desc = stripTags(unwrapCdata(pickTag(block, 'description')));
      out.push({
        title: title,
        url: normalizeBingUrl(unwrapCdata(link)),
        snippet: cut(desc, 400)
      });
    }
    return out;
  }

  // Bing HTML：结果块为 <li class="b_algo">，标题 <h2><a href>，摘要 <p>
  function parseBingHtml(html, limit) {
    html = String(html == null ? '' : html);
    limit = clampLimit(limit);
    var chunks = html.split(/<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/i);
    var out = [];
    for (var i = 1; i < chunks.length && out.length < limit; i++) {
      var b = chunks[i];
      var mA = b.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
        || b.match(/<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!mA) continue;
      var title = stripTags(mA[2]);
      if (!title) continue;
      var mS = b.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)
        || b.match(/<div\b[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      out.push({
        title: title,
        url: normalizeBingUrl(mA[1]),
        snippet: mS ? cut(stripTags(mS[1]), 400) : ''
      });
    }
    return out;
  }

  // ── 解析器：DuckDuckGo（兜底）────────────────────────────────

  function parseDuckDuckGoHtml(html, limit) {
    html = String(html == null ? '' : html);
    limit = clampLimit(limit);
    var links = [];
    var m;
    var reA = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = reA.exec(html))) {
      links.push({ href: m[1], title: stripTags(m[2]) });
    }
    var snips = [];
    var reS = /<(?:a|div)\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
    while ((m = reS.exec(html))) {
      snips.push(stripTags(m[1]));
    }
    var out = [];
    for (var i = 0; i < links.length && out.length < limit; i++) {
      if (!links[i].title) continue;
      out.push({ title: links[i].title, url: normalizeUrl(links[i].href), snippet: snips[i] || '' });
    }
    return out;
  }

  // DuckDuckGo Instant Answer API（JSON，CORS 相对友好）
  function parseInstantAnswer(json) {
    var j = json;
    if (typeof j === 'string') {
      try { j = JSON.parse(j); } catch (_) { j = null; }
    }
    if (!j || typeof j !== 'object') return [];
    var out = [];
    if (j.AbstractURL || j.AbstractText) {
      out.push({
        title: stripTags(j.Heading || j.AbstractSource || 'DuckDuckGo'),
        url: j.AbstractURL || '',
        snippet: stripTags(j.AbstractText || '')
      });
    }
    var flatten = function (arr) {
      (arr || []).forEach(function (t) {
        if (t && Array.isArray(t.Topics)) return flatten(t.Topics);
        if (t && t.FirstURL) {
          out.push({ title: stripTags(t.Text || t.FirstURL), url: t.FirstURL, snippet: stripTags(t.Text || '') });
        }
      });
    };
    flatten(j.RelatedTopics);
    return out;
  }

  // ── 输出与端点 ──────────────────────────────────────────────

  function formatResults(query, results, source) {
    if (!results || !results.length) {
      return '搜索「' + query + '」没有返回结果（可换关键词，或直接用 read_url 打开已知链接）。';
    }
    var head = '搜索「' + query + '」返回 ' + results.length + ' 条结果';
    if (source) head += '（来源：' + source + '）';
    var lines = [head + '：'];
    results.forEach(function (r, i) {
      lines.push((i + 1) + '. ' + (r.title || '(无标题)'));
      if (r.url) lines.push('   ' + r.url);
      if (r.snippet) lines.push('   ' + r.snippet);
    });
    lines.push('提示：需要网页正文时用 read_url 打开具体链接（必要时配合分页/筛选）。');
    return lines.join('\n');
  }

  function bingRssEndpoint(q, opts) {
    opts = opts || {};
    var n = clampLimit(opts.count);
    var url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&format=rss&count=' + n;
    if (opts.lang) url += '&setlang=' + encodeURIComponent(opts.lang);
    return url;
  }

  function bingHtmlEndpoint(q) { return 'https://www.bing.com/search?q=' + encodeURIComponent(q); }
  function htmlEndpoint(q) { return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q); }
  function apiEndpoint(q) { return 'https://api.duckduckgo.com/?format=json&no_redirect=1&no_html=1&q=' + encodeURIComponent(q); }

  async function fetchText(url, timeoutMs) {
    timeoutMs = Math.max(1000, Math.min(Number(timeoutMs) || DEFAULTS.timeoutMs, 60000));
    // Electron：主进程 net.fetch（绕过 CORS）
    if (typeof window !== 'undefined' && window.searchAPI && typeof window.searchAPI.fetchText === 'function') {
      var r = await window.searchAPI.fetchText({ url: url, timeoutMs: timeoutMs });
      return r || { ok: false, error: 'no-result' };
    }
    // 纯浏览器：直接 fetch（可能被 CORS 拦）
    var controller = new AbortController();
    var timer = setTimeout(function () { try { controller.abort(); } catch (_) {} }, timeoutMs);
    try {
      var resp = await fetch(url, { method: 'GET', signal: controller.signal });
      var text = await resp.text();
      return { ok: resp.ok, status: resp.status, text: text, url: resp.url || url };
    } finally {
      clearTimeout(timer);
    }
  }

  // provider 归一化：bing 是「Bing RSS + Bing HTML」的别名
  function normalizeProvider(p) {
    p = String(p || 'auto').trim().toLowerCase();
    if (!p) return 'auto';
    if (p === 'bing' || p === 'bing-web' || p === 'bing-search') return 'bing';
    return p;
  }

  async function search(params) {
    params = params || {};
    var q = String(params.query || '').trim();
    if (!q) throw new Error('web_search 需要 query');
    var limit = clampLimit(params.limit);
    var provider = normalizeProvider(params.provider);
    var timeoutMs = Number(params.timeout_ms) || DEFAULTS.timeoutMs;
    var errors = [];
    // 测试注入点（不暴露给模型）：传入 async (url, timeoutMs) => {ok,status,text}
    var doFetch = (typeof params._fetchText === 'function') ? params._fetchText : fetchText;

    var allow = function (name) {
      return provider === 'auto' || provider === name;
    };
    var wantBingRss = allow('bing') || provider === 'bing-rss' || provider === 'rss';
    var wantBingHtml = allow('bing') || provider === 'bing-html';
    var wantDdgHtml = allow('duckduckgo-html');
    var wantDdgApi = allow('duckduckgo-api');

    // 1) Bing RSS（首选：结构化、体积小）
    if (wantBingRss) {
      try {
        var r1 = await doFetch(bingRssEndpoint(q, { count: limit, lang: params.lang }), timeoutMs);
        if (r1 && r1.ok && r1.text) {
          var list1 = parseBingRss(r1.text, limit);
          if (list1.length) return formatResults(q, list1, 'Bing RSS');
          errors.push('Bing RSS 解析为空');
        } else {
          errors.push('Bing RSS 请求失败: ' + ((r1 && (r1.error || r1.status)) || 'unknown'));
        }
      } catch (e1) {
        errors.push('Bing RSS 异常: ' + errText(e1));
      }
    }

    // 2) Bing HTML（RSS 被拦时通常 HTML 还能出）
    if (wantBingHtml) {
      try {
        var r2 = await doFetch(bingHtmlEndpoint(q), timeoutMs);
        if (r2 && r2.ok && r2.text) {
          var list2 = parseBingHtml(r2.text, limit);
          if (list2.length) return formatResults(q, list2, 'Bing');
          errors.push('Bing HTML 解析为空（可能是验证页/无结果）');
        } else {
          errors.push('Bing HTML 请求失败: ' + ((r2 && (r2.error || r2.status)) || 'unknown'));
        }
      } catch (e2) {
        errors.push('Bing HTML 异常: ' + errText(e2));
      }
    }

    // 3) DuckDuckGo HTML（兜底）
    if (wantDdgHtml) {
      try {
        var r3 = await doFetch(htmlEndpoint(q), timeoutMs);
        if (r3 && r3.ok && r3.text) {
          var list3 = parseDuckDuckGoHtml(r3.text, limit);
          if (list3.length) return formatResults(q, list3, 'DuckDuckGo');
          errors.push('DuckDuckGo HTML 解析为空');
        } else {
          errors.push('DuckDuckGo HTML 请求失败: ' + ((r3 && (r3.error || r3.status)) || 'unknown'));
        }
      } catch (e3) {
        errors.push('DuckDuckGo HTML 异常: ' + errText(e3));
      }
    }

    // 4) DuckDuckGo Instant Answer（最后兜底：只有摘要，没有真实结果列表）
    if (wantDdgApi) {
      try {
        var r4 = await doFetch(apiEndpoint(q), timeoutMs);
        if (r4 && r4.ok && r4.text) {
          var list4 = parseInstantAnswer(r4.text).slice(0, limit);
          if (list4.length) return formatResults(q, list4, 'DuckDuckGo IA');
          errors.push('Instant Answer 无结果');
        } else {
          errors.push('Instant Answer 请求失败: ' + ((r4 && (r4.error || r4.status)) || 'unknown'));
        }
      } catch (e4) {
        errors.push('Instant Answer 异常: ' + errText(e4));
      }
    }

    return '搜索「' + q + '」未获得结果。' +
      (errors.length ? ('\n诊断：' + errors.join('；')) : '') +
      '\n提示：Electron 外壳内检索更稳定（主进程抓取不受 CORS 限制）；纯浏览器可能被拦，' +
      '可改用 read_url 直接打开已知链接，或显式指定 provider（bing / duckduckgo-html）。';
  }

  return {
    DEFAULTS: DEFAULTS,
    decodeEntities: decodeEntities,
    stripTags: stripTags,
    unwrapCdata: unwrapCdata,
    normalizeUrl: normalizeUrl,
    normalizeBingUrl: normalizeBingUrl,
    b64UrlDecode: b64UrlDecode,
    parseBingRss: parseBingRss,
    parseBingHtml: parseBingHtml,
    parseDuckDuckGoHtml: parseDuckDuckGoHtml,
    parseInstantAnswer: parseInstantAnswer,
    formatResults: formatResults,
    bingRssEndpoint: bingRssEndpoint,
    bingHtmlEndpoint: bingHtmlEndpoint,
    htmlEndpoint: htmlEndpoint,
    apiEndpoint: apiEndpoint,
    normalizeProvider: normalizeProvider,
    search: search
  };
});
