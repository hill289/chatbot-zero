/* ══════════════════════════════════════════════════════════════════════
 *  renderer/sanitize.js —— 零依赖 HTML 白名单净化器（SafeHtml）
 *
 *  背景：模型输出 / 网页抓取内容 / 文档正文都可能带 HTML。Markdown 渲染链路
 *  若把 marked.parse() 的结果直接塞进 innerHTML，就等于把「不可信输入」当代码执行：
 *  一个 <img src=x onerror=...> 就能读取 localStorage 里的 API Key，再通过
 *  preload 暴露的 fileAPI 读写磁盘。这是企业安全评估里的一票否决项。
 *
 *  做法：不做「黑名单删危险标签」，而是 **白名单重建**：
 *    · 只保留 ALLOWED_TAGS 里的标签，其余标签连同标签一起丢掉（内容保留）；
 *    · DROP_CONTENT 里的标签（script/style/iframe/svg/math…）连内容一起丢弃；
 *    · 属性同样白名单：on* 全丢、id/name 丢（防 DOM Clobbering）、style 过滤；
 *    · href/src 只允许安全协议（http/https/mailto/tel/#/相对路径；图片额外允许
 *      data:image/*;base64），javascript:/vbscript:/data:text/html 一律拒绝；
 *    · 输出永远由「转义后的文本 + 白名单标签」重新拼装，任何解析歧义都不会
 *      把原始 `<` 漏到输出里（fail-closed）。
 *
 *  纯字符串实现，浏览器与 Node 均可运行（可直接 node --test 单测）。
 * ══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SafeHtml = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function makeSet(list) {
        var s = Object.create(null);
        for (var i = 0; i < list.length; i++) s[list[i]] = true;
        return s;
    }

    // 允许保留的标签（小写）
    var ALLOWED_TAGS = makeSet([
        'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup',
        'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li',
        'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span',
        'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
        'time', 'tr', 'u', 'ul', 'var', 'wbr'
    ]);

    // 空元素：没有闭合标签
    var VOID_TAGS = makeSet(['br', 'col', 'hr', 'img', 'input', 'wbr']);

    // 危险容器：标签与内容一起丢弃
    var DROP_CONTENT_TAGS = makeSet([
        'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
        'noscript', 'template', 'textarea', 'title', 'xmp', 'plaintext', 'svg', 'math',
        'form', 'select', 'option', 'optgroup', 'video', 'audio', 'canvas', 'map',
        'base', 'link', 'meta', 'param', 'source', 'track', 'dialog', 'slot', 'portal',
        'noembed', 'noframes'
    ]);

    // 所有标签都允许的属性（值仍需按类型过滤）
    var GLOBAL_ATTRS = makeSet(['class', 'title', 'lang', 'dir', 'align', 'role', 'style']);

    var TAG_ATTRS = {
        a: ['href', 'target', 'rel', 'download'],
        img: ['src', 'alt', 'width', 'height', 'loading', 'decoding', 'referrerpolicy'],
        td: ['colspan', 'rowspan', 'headers'],
        th: ['colspan', 'rowspan', 'scope', 'headers', 'abbr'],
        ol: ['start', 'type', 'reversed'],
        li: ['value'],
        details: ['open'],
        time: ['datetime'],
        input: ['type', 'checked', 'disabled']
    };

    // 任何标签上都不允许（即使出现在参数里也忽略）
    var FORBIDDEN_ATTRS = makeSet([
        'id', 'name', 'srcset', 'formaction', 'xlink:href', 'http-equiv', 'content',
        'action', 'background', 'poster', 'ping', 'manifest', 'integrity', 'nonce',
        'xmlns', 'srcdoc', 'autofocus'
    ]);

    // 转义文本节点里的特殊字符。
    //   · `<` `>` 一律转义，防止漏出原始标签（fail-closed）；
    //   · `&` 只转义「非合法字符引用」的那些，避免把上游已转义好的实体（如
    //     marked.parse 产出的 &quot; / &amp; / &lt; / &#39;）二次转义成
    //     `&amp;quot;`（浏览器会原样显示成 &quot;）。合法实体在文本节点里只会
    //     被解析成对应字符（包括 < > 也只是文本），不会制造标签，故保留是安全的。
    function escapeText(s) {
        return String(s)
            .replace(/&(?!#[0-9]+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function escapeAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // 只解码常见的命名实体与数字实体：用于 href/src 的协议判断
    // （浏览器会把 &#106;avascript: 当成 javascript:，这里必须先解码再判断）
    function decodeEntities(s) {
        return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|colon|sol|tab|newline);?/gi,
            function (m, body) {
                var b = body.toLowerCase();
                if (b === 'amp') return '&';
                if (b === 'lt') return '<';
                if (b === 'gt') return '>';
                if (b === 'quot') return '"';
                if (b === 'apos') return "'";
                if (b === 'colon') return ':';
                if (b === 'sol') return '/';
                if (b === 'tab') return '\t';
                if (b === 'newline') return '\n';
                if (b.charAt(0) === '#') {
                    var code = b.charAt(1) === 'x' ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
                    if (isFinite(code) && code > 0 && code <= 0x10FFFF) {
                        try { return String.fromCodePoint(code); } catch (_) { return ''; }
                    }
                }
                return '';
            });
    }

    // href / src 协议白名单
    function isSafeUrl(raw, opts) {
        var s = decodeEntities(String(raw == null ? '' : raw));
        // 去掉控制字符与空白（java\nscript: / java\tscript: 都按 javascript: 处理）
        s = s.replace(/[\u0000-\u0020\u007f]+/g, '');
        if (!s) return false;
        if (s.charAt(0) === '#') return true;
        var m = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
        if (!m) return true; // 相对路径 / 协议相对 //host
        var scheme = m[1].toLowerCase();
        if (opts && opts.image) {
            if (scheme === 'http' || scheme === 'https') return true;
            if (scheme === 'data') {
                return /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon);base64,/i.test(s);
            }
            return false;
        }
        return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
    }

    // style 属性：命中危险构造就整条丢弃（CSS 本身不执行 JS，但 url() 可外链、expression 是老 IE 后门）
    function sanitizeStyle(value) {
        var v = String(value || '');
        if (/expression\s*\(|javascript\s*:|vbscript\s*:|url\s*\(|@import|behavior\s*:|-moz-binding|position\s*:\s*fixed/i.test(v)) {
            return '';
        }
        return v;
    }

    function attrAllowed(tag, name) {
        if (!name) return false;
        if (name.indexOf('on') === 0) return false;                 // onclick / onerror / onload …
        if (FORBIDDEN_ATTRS[name]) return false;
        if (GLOBAL_ATTRS[name]) return true;
        if (name.indexOf('aria-') === 0 || name.indexOf('data-') === 0) return true;
        var list = TAG_ATTRS[tag];
        return !!(list && list.indexOf(name) !== -1);
    }

    // 解析一段属性，返回 [[name, value], ...] 与结束位置
    function parseAttrs(src, start) {
        var n = src.length, p = start, attrs = [], selfClosing = false, ended = false;
        while (p < n) {
            var c = src.charAt(p);
            if (c === '>') { ended = true; p++; break; }
            if (c === '/' && src.charAt(p + 1) === '>') { selfClosing = true; ended = true; p += 2; break; }
            if (/\s/.test(c)) { p++; continue; }
            var nm = /^[^\s=\/>]+/.exec(src.slice(p, p + 256));
            if (!nm) { p++; continue; }
            var name = nm[0].toLowerCase();
            p += nm[0].length;
            while (p < n && /\s/.test(src.charAt(p))) p++;
            var value = '';
            if (src.charAt(p) === '=') {
                p++;
                while (p < n && /\s/.test(src.charAt(p))) p++;
                var q = src.charAt(p);
                if (q === '"' || q === "'") {
                    var endq = src.indexOf(q, p + 1);
                    if (endq < 0) { value = src.slice(p + 1); p = n; } else { value = src.slice(p + 1, endq); p = endq + 1; }
                } else {
                    var vm = /^[^\s>]+/.exec(src.slice(p));
                    if (vm) { value = vm[0]; p += vm[0].length; }
                }
            }
            attrs.push([name, value]);
        }
        return { attrs: attrs, selfClosing: selfClosing, ended: ended, next: p };
    }

    function buildOpenTag(tag, attrs) {
        var out = '<' + tag;
        var hrefSeen = false, srcSeen = false;
        for (var i = 0; i < attrs.length; i++) {
            var name = attrs[i][0], value = attrs[i][1];
            if (!attrAllowed(tag, name)) continue;

            if (name === 'style') {
                value = sanitizeStyle(value);
                if (!value) continue;
            }
            if (name === 'href' || name === 'src') {
                if (!isSafeUrl(value, { image: name === 'src' })) continue;
                if (name === 'href') hrefSeen = true;
                if (name === 'src') srcSeen = true;
            }
            if (name === 'type' && tag === 'input') {
                // 只保留禁用的任务清单复选框，其余 input 一律丢弃
                if (String(value).toLowerCase() !== 'checkbox') return '';
            }
            out += ' ' + name + '="' + escapeAttr(value) + '"';
        }
        // <a>：外链统一新窗口 + noopener，避免被宿主页面上下文劫持
        if (tag === 'a') {
            if (!hrefSeen) { /* 没有安全 href 的链接仍然是普通文本容器 */ }
            out += ' rel="noopener noreferrer nofollow"';
            out += ' target="_blank"';
        }
        // <img>：没有安全 src 就整张丢掉；顺带禁止发送 Referer
        if (tag === 'img') {
            if (!srcSeen) return '';
            out += ' referrerpolicy="no-referrer" loading="lazy"';
        }
        out += '>';
        return out;
    }

    /**
     * 净化 HTML 字符串。
     * @param {string} input 不可信 HTML
     * @returns {string} 只含白名单标签 / 属性的安全 HTML
     */
    function sanitizeHtml(input) {
        if (input == null) return '';
        var src = String(input);
        var n = src.length, i = 0, out = [];
        var skipTag = null, skipDepth = 0;

        while (i < n) {
            var lt = src.indexOf('<', i);
            if (lt < 0) {
                if (!skipTag) out.push(escapeText(src.slice(i)));
                break;
            }
            if (lt > i && !skipTag) out.push(escapeText(src.slice(i, lt)));
            i = lt;

            // 注释 / CDATA / doctype / 处理指令：整段丢弃
            if (src.slice(i, i + 4) === '<!--') {
                var ce = src.indexOf('-->', i + 4);
                i = ce < 0 ? n : ce + 3;
                continue;
            }
            if (src.slice(i, i + 9).toUpperCase() === '<![CDATA[') {
                var de = src.indexOf(']]>', i + 9);
                i = de < 0 ? n : de + 3;
                continue;
            }
            if (src.charAt(i + 1) === '!' || src.charAt(i + 1) === '?') {
                var se = src.indexOf('>', i + 2);
                i = se < 0 ? n : se + 1;
                continue;
            }

            var closing = src.charAt(i + 1) === '/';
            var nameStart = i + (closing ? 2 : 1);
            var nm = /^[A-Za-z][A-Za-z0-9:-]*/.exec(src.slice(nameStart, nameStart + 64));
            if (!nm) { out.push('&lt;'); i += 1; continue; }   // 孤立的 '<'，按文本处理
            var tag = nm[0].toLowerCase();

            var parsed = parseAttrs(src, nameStart + nm[0].length);
            if (!parsed.ended) { out.push(escapeText(src.slice(i))); break; } // 标签没闭合：剩余全部按文本
            i = parsed.next;

            // 正在跳过 drop-content 容器内部
            if (skipTag) {
                if (tag === skipTag) {
                    if (closing) { skipDepth--; if (skipDepth <= 0) { skipTag = null; skipDepth = 0; } }
                    else if (!VOID_TAGS[tag] && !parsed.selfClosing) { skipDepth++; }
                }
                continue;
            }

            if (closing) {
                if (ALLOWED_TAGS[tag] && !VOID_TAGS[tag]) out.push('</' + tag + '>');
                continue;
            }

            if (DROP_CONTENT_TAGS[tag]) {
                if (!VOID_TAGS[tag] && !parsed.selfClosing) { skipTag = tag; skipDepth = 1; }
                continue;
            }

            if (!ALLOWED_TAGS[tag]) continue; // 未知标签：去壳留内容

            var open = buildOpenTag(tag, parsed.attrs);
            if (!open) continue;
            out.push(open);
            if (!VOID_TAGS[tag] && parsed.selfClosing) out.push('</' + tag + '>');
        }

        return out.join('');
    }

    return {
        sanitizeHtml: sanitizeHtml,
        isSafeUrl: isSafeUrl,
        sanitizeStyle: sanitizeStyle,
        ALLOWED_TAGS: ALLOWED_TAGS,
        DROP_CONTENT_TAGS: DROP_CONTENT_TAGS
    };
});
