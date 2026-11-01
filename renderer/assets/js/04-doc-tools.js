        // ══════════════════════════════════════════════════════════════
        //  markdown_to_pdf：用本地化的 markview-web 把 Markdown 转成 PDF
        //   1) 取 Markdown（markdown 文本 或 从 almostnode FS 的 file_path 读取）
        //   2) Markview.renderPages() 排成 A4 分页（justified，KaTeX/Mermaid）
        //   3) html2canvas 逐页栅格化 + jsPDF 组装成真正的 PDF 字节
        //   4) 写入 almostnode FS，并（默认）触发浏览器下载
        //   5) 归一化 \( \) \[ \] 等常见 LaTeX 定界符与「定界符内侧空白」
        // ══════════════════════════════════════════════════════════════
        // 归一化 LaTeX 定界符：texmath 默认只启用 `dollars`（$ / $$），且要求定界符
        // 内侧首尾无空白；不满足时公式不会被识别，在 PDF 中会以原始 LaTeX 文本输出。
        //   \(...\) → $...$        \[...\] → $$...$$
        //   并去掉 $...$ / $$...$$ 内侧空白；先保护代码区域（围栏/行内）避免误伤。
        function normalizeTexDelims(src) {
            const stash = [];
            const put = (m) => { stash.push(m); return '\u0000' + (stash.length - 1) + '\u0000'; };
            let s = String(src);
            s = s.replace(/```[\s\S]*?```/g, put);
            s = s.replace(/~~~[\s\S]*?~~~/g, put);
            s = s.replace(/`[^`\n]*`/g, put);
            s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, i) => '$$' + i.trim() + '$$');
            s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, i) => '$' + i.trim() + '$');
            s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, i) => '$$' + i.trim() + '$$');
            s = s.replace(/\$([^$\n]+?)\$/g, (m, i) => '$' + i.trim() + '$');
            s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
            return s;
        }

        // 为 html2canvas 搭一个极简沙箱文档：只放「当前页」+ 一份宿主页样式表的副本。
        // html2canvas 每次栅格化克隆的是 element.ownerDocument 的整棵 DOM；把页面
        // 搬进这个空文档后，克隆代价就从「整个聊天页面」降到「单页」，是 markdown_to_pdf
        // 的性能关键。见其内注释。
        function createCaptureSandbox(width) {
            try {
                const frame = document.createElement('iframe');
                frame.setAttribute('aria-hidden', 'true');
                // 放到视口外即可；不要设 visibility:hidden——克隆体会继承它而渲染成空白
                frame.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + (width + 40) + 'px;height:1400px;border:0;';
                document.body.appendChild(frame);
                const idoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
                if (!idoc) { frame.remove(); return null; }
                idoc.open();
                idoc.write('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
                idoc.close();

                // 相对 URL（KaTeX 字体等）按宿主页基准解析
                const base = idoc.createElement('base');
                base.href = document.baseURI;
                idoc.head.appendChild(base);

                // 把宿主页 <head> 里的样式原样搬进来（外链 + 内联，保持顺序）：
                // 这样沙箱里的 CSS 与排版时完全一致（全局 reset、KaTeX、Mermaid 等），
                // 而沙箱 DOM 极小，html2canvas 的逐节点 CSS 匹配代价可以忽略。
                // 一条样式都没有时返回 null，调用方自动回退到旧的宿主页截图路径。
                const headKids = Array.prototype.slice.call(document.head.children);
                let copied = 0;
                for (let h = 0; h < headKids.length; h++) {
                    const el = headKids[h];
                    if (el.tagName === 'LINK' && /\bstylesheet\b/i.test(el.rel || '')) {
                        if (!el.href) continue;
                        const link = idoc.createElement('link');
                        link.rel = 'stylesheet';
                        link.href = el.href; // 取绝对地址，避免相对路径按 about:blank 解析
                        idoc.head.appendChild(link);
                        copied++;
                    } else if (el.tagName === 'STYLE') {
                        const st = idoc.createElement('style');
                        st.textContent = el.textContent;
                        idoc.head.appendChild(st);
                        copied++;
                    }
                }
                if (!copied) { frame.remove(); return null; }

                const stage = idoc.createElement('div');
                stage.style.cssText = 'position:absolute;left:0;top:0;';
                idoc.body.appendChild(stage);

                return { frame: frame, stage: stage, destroy: function () { try { frame.remove(); } catch (_) {} } };
            } catch (e) {
                return null;
            }
        }

        async function markdown_to_pdf(params) {
            params = params || {};
            const _fail = (msg) => JSON.stringify({ success: false, content: [{ type: 'text', text: 'markdown_to_pdf error: ' + msg }] });
            const _ok = (msg) => JSON.stringify({ success: true, content: [{ type: 'text', text: msg }] });
            const hasFS = !!(nodeRuntime && nodeRuntime.ready && nodeRuntime.FS);

            try {
                const MV = window.Markview;
                if (!MV || typeof MV.renderPages !== 'function') {
                    return _fail('markview-web 未加载（请确认 ./markview-web.js 已引入）。');
                }
                if (!window.markdownit) {
                    return _fail('markdown-it 未加载（请确认 ./markdown-it.min.js 已引入）。');
                }

                // ── 1) 解析 Markdown 源 ──
                let markdown = params.markdown;
                const file_path = params.file_path;
                if ((markdown === undefined || markdown === null || markdown === '') && file_path) {
                    if (!hasFS) {
                        return _fail('Node 运行时未就绪，无法从 file_path 读取，请改用 markdown 参数。');
                    }
                    try {
                        const bytes = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });
                        markdown = new TextDecoder().decode(bytes);
                    } catch (e) {
                        return _fail("无法读取 file_path='" + file_path + "'：" + (e && e.message ? e.message : String(e)));
                    }
                }
                if (typeof markdown !== 'string' || markdown.trim() === '') {
                    return _fail('需要提供 `markdown` 文本，或可读取的 `file_path`。');
                }
                // 兼容 \(...\) \[...\] 等定界符，并去掉 $ 内侧空白
                // （texmath 只认 dollars 且要求内侧无空白，否则公式会以原始文本输出）
                markdown = normalizeTexDelims(markdown);

                const output_path = (params.output_path && String(params.output_path).trim()) || '/home/pyodide/output.pdf';
                let filename = (params.filename && String(params.filename).trim()) || output_path.split('/').pop() || 'output.pdf';
                if (!/\.pdf$/i.test(filename)) filename += '.pdf';

                const opts = {
                    width: Number(params.width) > 0 ? Number(params.width) : 720,
                    fontSize: Number(params.font_size) > 0 ? Number(params.font_size) : 18,
                    justify: params.justify !== false,
                    // 额外启用 \(...\) \[...\] 与 \begin...\end，避免只认 $ 而漏渲染
                    delimiters: ['dollars', 'brackets', 'beg_end'],
                    markdownit: window.markdownit,
                };

                // 离屏容器：不打扰界面，同时仍可被 html2canvas 正常栅格化
                const host = document.createElement('div');
                host.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + (opts.width + 40) + 'px;background:#ffffff;';
                document.body.appendChild(host);

                try {
                    // Mermaid 需先初始化（markview-web 只调用 mermaid.run）
                    if (window.mermaid && typeof window.mermaid.initialize === 'function') {
                        try { window.mermaid.initialize({ startOnLoad: false }); } catch (_) {}
                    }

                    // ── 2) 排版为 A4 分页 ──
                    await MV.renderPages(host, markdown, opts);
                    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) {} }

                    const ns = window.jspdf;
                    const JsPDF = ns && (ns.jsPDF || ns.default || ns);
                    const h2c = window.html2canvas;
                    if (!h2c) return _fail('html2canvas 未加载（请确认 ./html2canvas.min.js 已引入）。');
                    if (!JsPDF) return _fail('jsPDF 未加载（请确认 ./jspdf.umd.min.js 已引入）。');

                    let sheets = Array.prototype.slice.call(host.querySelectorAll('.mvw-sheet'));
                    if (!sheets.length) sheets = [host];

                    // ── 3) 逐页栅格化并写入 PDF（A4：210×297mm）──
                    const pdf = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
                    const scale = Number(params.scale) > 0 ? Number(params.scale) : 2;
                    const jpegQuality = Number(params.image_quality) > 0 ? Number(params.image_quality) : 0.92;

                    // ⚡ 性能关键修复：html2canvas 每次调用都会「深拷贝 element.ownerDocument
                    //   的整棵 DOM」并对每个克隆节点计算样式（getComputedStyle 等）。若直接在
                    //   宿主页面（聊天 UI 本身 ≈3000 节点 + 全部页 sheet ≈16000 节点 + 十余张
                    //   样式表）上逐页栅格化，则每一页都要重新克隆/计算整棵文档：单页 ≈1.1s，
                    //   本书 200 页 ≈ 4 分钟，浏览器长时间无响应（表现为「卡死」）。
                    //   解决：把「当前这一页」临时搬进一个极简沙箱 <iframe>（只含本页 + 一份
                    //   宿主页样式表的副本），再对它栅格化。此时 ownerDocument 是这个空
                    //   文档，克隆代价从「整站节点数」降到「单页节点数」：单页 ≈0.2s，整体从
                    //   O(页数 × 全文节点) 降为 O(页数 × 单页节点)。沙箱内同一时刻只有一页，
                    //   也就不再需要 ignoreElements 裁剪兄弟页，规避了布局错位的风险。
                    var captureSandbox = createCaptureSandbox(opts.width);
                    if (captureSandbox) {
                        // 等沙箱里的样式表就绪（缓存命中时几乎即时），再开始截图
                        var sdoc = captureSandbox.frame.contentWindow.document;
                        await new Promise(function (resolve) {
                            var left = 3000, done = false;
                            var finish = function () { if (!done) { done = true; resolve(); } };
                            (function tick() {
                                var ready = sdoc.styleSheets.length >= 1;
                                if (ready) {
                                    for (var k = 0; k < sdoc.styleSheets.length; k++) {
                                        try { void sdoc.styleSheets[k].cssRules; } catch (_) { ready = false; }
                                    }
                                }
                                if (ready || left <= 0) return finish();
                                left -= 50;
                                setTimeout(tick, 50);
                            })();
                        });
                        try { await sdoc.fonts.ready; } catch (_) {}
                    }

                    const captureOpts = {
                        scale: scale,
                        backgroundColor: '#ffffff',
                        useCORS: true,
                        logging: false,
                    };
                    for (let i = 0; i < sheets.length; i++) {
                        const sheet = sheets[i];
                        // 没有沙箱时回退到旧路径：留在宿主页里截图，并让克隆器跳过其它 sheet
                        if (!captureSandbox && sheets.length > 1 && sheet.classList && sheet.classList.contains('mvw-sheet')) {
                            captureOpts.ignoreElements = function (el) {
                                return el !== sheet && !!(el.classList && el.classList.contains('mvw-sheet'));
                            };
                        } else {
                            delete captureOpts.ignoreElements;
                        }
                        const prevBoxShadow = sheet.style.boxShadow;
                        const prevRadius = sheet.style.borderRadius;
                        sheet.style.boxShadow = 'none';
                        sheet.style.borderRadius = '0';
                        let img;
                        try {
                            // 沙箱里始终只保留当前页，保证克隆体最小
                            if (captureSandbox) {
                                var stage = captureSandbox.stage;
                                while (stage.firstChild) stage.removeChild(stage.firstChild);
                                stage.appendChild(sheet);
                            }
                            const canvas = await h2c(sheet, captureOpts);
                            img = canvas.toDataURL('image/jpeg', jpegQuality);
                            // 及时释放整页 canvas 占用的大块内存（scale=2 的 A4 ≈ 十几 MB/页）
                            try { canvas.width = 1; canvas.height = 1; } catch (_) {}
                        } finally {
                            sheet.style.boxShadow = prevBoxShadow;
                            sheet.style.borderRadius = prevRadius;
                        }
                        if (i > 0) pdf.addPage();
                        pdf.addImage(img, 'JPEG', 0, 0, 210, 297);
                        // 让出主线程：避免长时间独占主线程导致界面假死、无法响应/取消
                        await new Promise(function (r) { setTimeout(r, 0); });
                    }

                    const pdfBytes = new Uint8Array(pdf.output('arraybuffer'));

                    // ── 4) 写入 almostnode FS（可用时）──
                    let wroteToFS = false;
                    if (hasFS) {
                        try {
                            const dir = output_path.substring(0, output_path.lastIndexOf('/'));
                            if (dir) { try { nodeRuntime.FS.mkdirTree(dir); } catch (_) {} }
                            nodeRuntime.FS.writeFile(output_path, pdfBytes);
                            wroteToFS = true;
                            if (typeof pgpySyncMount === 'function') { try { await pgpySyncMount(false); } catch (_) {} }
                        } catch (e) {
                            console.warn('markdown_to_pdf: 写入 almostnode FS 失败', e);
                        }
                    }

                    // ── 5) 触发浏览器下载（默认关闭：不再自动下载，仅当显式 download=true 时触发）──
                    let downloaded = false;
                    if (params.download === true) {
                        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        setTimeout(() => URL.revokeObjectURL(url), 10000);
                        downloaded = true;
                    }

                    return _ok([
                        '已生成 PDF：' + sheets.length + ' 页，' + (pdfBytes.length / 1024).toFixed(1) + ' KB',
                        wroteToFS ? ('已写入 almostnode FS：' + output_path) : '未写入 almostnode FS（Node 运行时未就绪）',
                        downloaded ? ('已触发下载：' + filename) : '未触发下载（默认关闭自动下载）',
                    ].join('\n'));
                } finally {
                    try { if (captureSandbox) captureSandbox.destroy(); } catch (_) {}
                    try { host.remove(); } catch (_) {}
                }
            } catch (e) {
                console.error('markdown_to_pdf failed', e);
                return _fail(e && e.message ? e.message : String(e));
            }
        }
        // ══════════════════════════════════════════════════════════════
        //  html_to_ppt：把 html-ppt 技能（assets/base.css + assets/themes/*.css
        //  + templates/full-decks/*）产出的静态 HTML 幻灯片转换成真正的 .pptx。
        //    · 约定：一个 deck = <div class="deck"> 内若干 <section class="slide">；
        //      画布尺寸取 data-w/data-h（默认 1920×1080）；逐字稿放在
        //      <aside class="notes">。本工具据此把每一页搬进 PPTX。
        //    · mode:'image'（默认）：用 html2canvas 逐页栅格化成整页图片，
        //      像素级还原主题/渐变/排版，但文字不可编辑。
        //      mode:'text'：读取每个块级元素的实际位置与计算样式，生成可编辑
        //      文本框 + 图片，尽量贴近原版式。
        //    · 两种模式都会把 <aside class="notes"> 写成 PPT 备注（speaker notes）。
        //    · HTML 里以相对路径引用的 CSS / 图片会从 almostnode FS 内联进来，
        //      所以 deck 放在工作区任意位置都能正确渲染。输出写入 almostnode FS。
        // ══════════════════════════════════════════════════════════════

        // 解析相对/绝对 href 为 almostnode FS 路径；外链(data:/http:/#…)返回 null
        function htmlToPptResolvePath(baseDir, href) {
            if (href === undefined || href === null) return null;
            const h = String(href).trim();
            if (!h) return null;
            if (/^(https?:|data:|blob:|mailto:|tel:|javascript:|#)/i.test(h) || h.slice(0, 2) === '//') return null;
            let p = h;
            if (h.charAt(0) !== '/') p = String(baseDir || '').replace(/\/+$/, '') + '/' + h;
            const segs = p.split('/');
            const out = [];
            for (let i = 0; i < segs.length; i++) {
                const s = segs[i];
                if (s === '' || s === '.') continue;
                if (s === '..') { if (out.length) out.pop(); continue; }
                out.push(s);
            }
            return '/' + out.join('/');
        }

        // 读取 almostnode FS 文件并转成 data:URI（图片用）；失败返回 null
        function htmlToPptFileToDataUri(filePath) {
            try {
                if (!(typeof nodeRuntime !== 'undefined' && nodeRuntime && nodeRuntime.ready && nodeRuntime.FS)) return null;
                const bytes = nodeRuntime.FS.readFile(filePath, { encoding: 'binary' });
                if (!bytes || !bytes.length) return null;
                const mime = (typeof pgpyDetectImageMime === 'function' ? pgpyDetectImageMime(bytes, filePath) : '') || 'application/octet-stream';
                return 'data:' + mime + ';base64,' + pgpyBytesToBase64(bytes);
            } catch (_) { return null; }
        }

        // 把 CSS 里的 url(...) 就地内联为 data:URI（相对 cssBaseDir 解析）
        function htmlToPptInlineCssUrls(css, cssBaseDir) {
            return String(css === undefined || css === null ? '' : css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (m, q, href) {
                const p = htmlToPptResolvePath(cssBaseDir, href);
                if (!p) return m;
                const d = htmlToPptFileToDataUri(p);
                return d ? 'url("' + d + '")' : m;
            });
        }

        // 在离屏 iframe 里把「静态出图」所需的样式钉死（不依赖 runtime.js）
        const HTML_TO_PPT_OVERRIDE_CSS = [
            '.slide{opacity:1!important;transform:none!important;transition:none!important;pointer-events:auto!important}',
            '.slide.is-prev{transform:none!important}',
            '.slide.is-active{opacity:1!important;transform:none!important}',
            '.deck{transform:none!important}',
            '.notes,.speaker-notes,.notes-overlay,.progress-bar,.overview{display:none!important}'
        ].join('\n');

        // 把 iframe 文档里的所有 CSS 动画结束到最终帧（保证静态出图取到“动画完成态”）
        function htmlToPptFinishAnimations(win) {
            try {
                const doc = win && win.document;
                if (!doc || typeof doc.getAnimations !== 'function') return;
                doc.getAnimations().forEach(function (a) {
                    try { a.finish(); }
                    catch (_) { try { a.currentTime = 1000; } catch (__) {} }
                });
            } catch (_) {}
        }

        // 等两帧，让布局/样式稳定
        function htmlToPptNextFrame(win) {
            return new Promise(function (res) {
                try { win.requestAnimationFrame(function () { win.requestAnimationFrame(function () { res(); }); }); }
                catch (_) { setTimeout(res, 16); }
            });
        }

        // 等字体和图片就绪（带超时，避免离线时永久挂起）
        async function htmlToPptWaitAssets(idoc, iwin, timeoutMs) {
            const deadline = Date.now() + (timeoutMs || 4000);
            try { if (iwin && iwin.document && iwin.document.fonts && iwin.document.fonts.ready) await iwin.document.fonts.ready; } catch (_) {}
            let imgs = [];
            try { imgs = Array.prototype.slice.call(idoc.images || []); } catch (_) {}
            await Promise.all(imgs.map(function (img) {
                if (img.complete) return Promise.resolve();
                return new Promise(function (res) {
                    const done = function () { res(); };
                    img.addEventListener('load', done, { once: true });
                    img.addEventListener('error', done, { once: true });
                    setTimeout(done, Math.max(0, deadline - Date.now()));
                });
            }));
        }

        // 把某个元素（img / svg / canvas）转成可嵌入的 data:URI（失败返回 null）
        function htmlToPptElementToImageData(el, iwin, baseDir) {
            try {
                const tag = el.tagName ? el.tagName.toUpperCase() : '';
                if (tag === 'IMG') {
                    let src = el.getAttribute('src') || '';
                    if (src.indexOf('data:') === 0) return src;
                    const p = htmlToPptResolvePath(baseDir, src);
                    return p ? htmlToPptFileToDataUri(p) : null;
                }
                if (tag === 'CANVAS') { try { return el.toDataURL('image/png'); } catch (_) { return null; } }
                if (tag === 'SVG') {
                    const xml = new XMLSerializer().serializeToString(el);
                    const b64 = btoa(unescape(encodeURIComponent(xml)));
                    return 'data:image/svg+xml;base64,' + b64;
                }
            } catch (_) {}
            return null;
        }

        // 文本模式：把一页里各元素的「实际位置 + 计算样式」映射成可编辑的 PPTX 元素
        function htmlToPptFillSlideText(pptSlide, slideEl, iwin, geom) {
            const W = geom.W, H = geom.H, wIn = geom.wIn, hIn = geom.hIn;
            const pxX = function (v) { return v / W * wIn; };
            const pxY = function (v) { return v / H * hIn; };
            const pxW = function (v) { return v / W * wIn; };
            const pxH = function (v) { return v / H * hIn; };
            const PX2PT = 72 / 144; // 画布 144 px / inch

            let slideRect;
            try { slideRect = slideEl.getBoundingClientRect(); }
            catch (_) { slideRect = { left: 0, top: 0, width: W, height: H }; }
            const baseLeft = slideRect.left, baseTop = slideRect.top;

            function rgbToHex(c) {
                if (!c) return null;
                const m = /rgba?\(([^)]+)\)/.exec(c);
                if (!m) return String(c).replace('#', '') || null;
                const p = m[1].split(',').map(function (x) { return parseFloat(x); });
                if (p.length >= 4 && p[3] === 0) return null; // 透明
                const h = function (n) { const s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length < 2 ? '0' + s : s; };
                return h(p[0]) + h(p[1]) + h(p[2]);
            }
            function isInlineDisplay(d) { return d === 'inline' || d === 'inline-block' || d === 'inline-flex'; }
            function visible(el) {
                try {
                    const cs = iwin.getComputedStyle(el);
                    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
                    if (parseFloat(cs.opacity) === 0) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 1 && r.height > 1;
                } catch (_) { return false; }
            }

            let defaultColor = '222222';
            try { defaultColor = rgbToHex(iwin.getComputedStyle(slideEl).color) || '222222'; } catch (_) {}

            const images = [];
            const texts = [];

            (function walk(el) {
                const tag = el.tagName ? el.tagName.toUpperCase() : '';
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'BR') return;
                if (!visible(el)) return;
                if (tag === 'IMG' || tag === 'SVG' || tag === 'CANVAS') { images.push(el); return; }
                if (tag === 'TABLE') { texts.push({ kind: 'table', el: el }); return; }

                const children = Array.prototype.slice.call(el.children || []);
                const hasBlockChild = children.some(function (c) {
                    const t = c.tagName ? c.tagName.toUpperCase() : '';
                    if (t === 'BR') return false;
                    let d = 'block';
                    try { d = iwin.getComputedStyle(c).display; } catch (_) {}
                    return !isInlineDisplay(d);
                });

                if (!hasBlockChild) {
                    let text = '';
                    try { text = (el.innerText !== undefined ? el.innerText : el.textContent) || ''; }
                    catch (_) { text = el.textContent || ''; }
                    if (text.trim()) texts.push({ kind: 'text', el: el, text: text.replace(/\s+$/, '') });
                    return;
                }
                children.forEach(function (c) { walk(c); });
            })(slideEl);

            // 图片
            images.forEach(function (img) {
                try {
                    const r = img.getBoundingClientRect();
                    const data = htmlToPptElementToImageData(img, iwin, geom.baseDir);
                    if (!data) return;
                    pptSlide.addImage({ data: data, x: pxX(r.left - baseLeft), y: pxY(r.top - baseTop), w: pxW(r.width), h: pxH(r.height) });
                } catch (_) {}
            });

            // 文本 / 表格
            texts.forEach(function (item) {
                try {
                    const el = item.el;
                    const r = el.getBoundingClientRect();
                    const cs = iwin.getComputedStyle(el);
                    const x = pxX(r.left - baseLeft), y = pxY(r.top - baseTop);
                    const w = Math.max(pxW(r.width), 0.2), h = Math.max(pxH(r.height), 0.2);

                    if (item.kind === 'table') {
                        const rows = [];
                        el.querySelectorAll('tr').forEach(function (tr) {
                            const cells = [];
                            tr.querySelectorAll('td,th').forEach(function (td) { cells.push({ text: (td.innerText || '').trim() }); });
                            if (cells.length) rows.push(cells);
                        });
                        if (rows.length) {
                            const cols = Math.max.apply(null, rows.map(function (rr) { return rr.length; }));
                            pptSlide.addTable(rows, {
                                x: x, y: y, w: w,
                                colW: new Array(cols).fill(w / cols),
                                fontSize: Math.max(8, (parseFloat(cs.fontSize) || 16) * PX2PT),
                                border: { pt: 1, color: 'BBBBBB' }, autoPage: false
                            });
                        }
                        return;
                    }

                    const color = rgbToHex(cs.color) || defaultColor;
                    const fontSize = Math.max(6, (parseFloat(cs.fontSize) || 16) * PX2PT);
                    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
                    const italic = cs.fontStyle === 'italic';
                    let align = 'left';
                    if (cs.textAlign === 'center') align = 'center';
                    else if (cs.textAlign === 'right' || cs.textAlign === 'end') align = 'right';
                    else if (cs.textAlign === 'justify') align = 'justify';

                    const opts = {
                        x: x, y: y, w: w, h: h,
                        fontSize: fontSize, bold: bold, italic: italic,
                        color: color, align: align, valign: 'top',
                        margin: 0, wrap: true, isTextBox: true, fontFace: 'Arial'
                    };
                    if (el.tagName && el.tagName.toUpperCase() === 'LI') opts.bullet = { indent: 12 };
                    pptSlide.addText(item.text, opts);
                } catch (_) {}
            });
        }

        async function html_to_ppt(params) {
            params = params || {};
            const _fail = (msg) => JSON.stringify({ success: false, content: [{ type: 'text', text: 'html_to_ppt error: ' + msg }] });
            const _ok = (msg) => JSON.stringify({ success: true, content: [{ type: 'text', text: msg }] });
            const hasFS = !!(typeof nodeRuntime !== 'undefined' && nodeRuntime && nodeRuntime.ready && nodeRuntime.FS);

            let iframe = null;
            try {
                // ── 0) 依赖检查 ──
                if (typeof PptxGenJS === 'undefined' && window.__waitOfficeLibs) {
                    try { await window.__waitOfficeLibs(30000); } catch (_) {}
                }
                if (typeof PptxGenJS === 'undefined') return _fail('PptxGenJS 未加载（almostnode 运行时应内置 pptxgenjs）。');
                const h2c = window.html2canvas;
                if (!h2c) return _fail('html2canvas 未加载（请确认 ./html2canvas.min.js 已引入）。');

                // ── 1) 取得 HTML 源 ──
                let html = params.html;
                const file_path = params.file_path ? String(params.file_path).trim() : '';
                if ((html === undefined || html === null || html === '') && file_path) {
                    if (!hasFS) return _fail('Node 运行时未就绪，无法从 file_path 读取，请改用 html 参数。');
                    try {
                        const bytes = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });
                        html = new TextDecoder().decode(bytes);
                    } catch (e) {
                        return _fail("无法读取 file_path='" + file_path + "'：" + (e && e.message ? e.message : String(e)));
                    }
                }
                if (typeof html !== 'string' || !html.trim()) return _fail('需要提供 html 文本，或可读取的 file_path。');

                let baseDir = params.base_dir ? String(params.base_dir).trim()
                    : (file_path ? file_path.replace(/\/[^\/]*$/, '') : '/home/pyodide');
                if (!baseDir) baseDir = '/home/pyodide';

                const mode = (params.mode === 'text') ? 'text' : 'image';
                const bgOverride = params.background ? String(params.background) : '';

                // ── 2) 解析 HTML ──
                const srcDoc = new DOMParser().parseFromString(html, 'text/html');
                if (!srcDoc || !srcDoc.body) return _fail('HTML 解析失败（DOMParser 未返回 body）。');
                Array.prototype.slice.call(srcDoc.querySelectorAll('script')).forEach(function (s) { try { s.remove(); } catch (_) {} });

                // 画布尺寸：参数 > data-w/data-h > 默认 1920×1080
                const deckEl0 = srcDoc.querySelector('.deck');
                const W = Number(params.width) > 0 ? Number(params.width)
                    : ((deckEl0 && parseInt(deckEl0.getAttribute('data-w'), 10)) || 1920);
                const H = Number(params.height) > 0 ? Number(params.height)
                    : ((deckEl0 && parseInt(deckEl0.getAttribute('data-h'), 10)) || 1080);

                // ── 3) 收集并内联样式表 ──
                const cssTexts = [];
                let assetsDir = '';
                Array.prototype.slice.call(srcDoc.head.children).forEach(function (el) {
                    const tag = el.tagName ? el.tagName.toUpperCase() : '';
                    if (tag === 'LINK' && /stylesheet/i.test(el.getAttribute('rel') || '')) {
                        const href = el.getAttribute('href') || '';
                        const resolved = htmlToPptResolvePath(baseDir, href);
                        if (resolved && /assets\/base\.css$/i.test(href)) assetsDir = resolved.replace(/\/base\.css$/i, '');
                        if (resolved && hasFS) {
                            try {
                                const css = new TextDecoder().decode(nodeRuntime.FS.readFile(resolved, { encoding: 'binary' }));
                                cssTexts.push(htmlToPptInlineCssUrls(css, resolved.replace(/\/[^\/]*$/, '')));
                            } catch (_) { /* 读不到就跳过（外链/离线） */ }
                        }
                    } else if (tag === 'STYLE') {
                        cssTexts.push(htmlToPptInlineCssUrls(el.textContent || '', baseDir));
                    }
                });
                // 指定主题时追加主题 CSS（覆盖前面的 :root 变量）
                if (params.theme && assetsDir && hasFS) {
                    const tp = assetsDir + '/themes/' + String(params.theme).trim() + '.css';
                    try {
                        const tcss = new TextDecoder().decode(nodeRuntime.FS.readFile(tp, { encoding: 'binary' }));
                        cssTexts.push(htmlToPptInlineCssUrls(tcss, assetsDir + '/themes'));
                    } catch (_) {}
                }

                // ── 4) 处理 body 内的资源引用（img/src、行内 style 的 url()）──
                (function process(node) {
                    Array.prototype.slice.call(node.children || []).forEach(function (el) {
                        const tag = el.tagName ? el.tagName.toUpperCase() : '';
                        if (tag === 'SCRIPT') { try { el.remove(); } catch (_) {} return; }
                        if (tag === 'IMG') {
                            const p = htmlToPptResolvePath(baseDir, el.getAttribute('src'));
                            if (p) { const d = htmlToPptFileToDataUri(p); if (d) el.setAttribute('src', d); }
                        }
                        const st = el.getAttribute && el.getAttribute('style');
                        if (st && /url\(/i.test(st)) el.setAttribute('style', htmlToPptInlineCssUrls(st, baseDir));
                        if (tag === 'STYLE') el.textContent = htmlToPptInlineCssUrls(el.textContent || '', baseDir);
                        process(el);
                    });
                })(srcDoc.body);

                // ── 5) 搭建离屏 iframe（隔离 deck 全局 CSS，不污染本页）──
                iframe = document.createElement('iframe');
                iframe.setAttribute('aria-hidden', 'true');
                iframe.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + W + 'px;height:' + H +
                    'px;border:0;margin:0;padding:0;pointer-events:none;';
                document.body.appendChild(iframe);
                const idoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
                const iwin = iframe.contentWindow;
                if (!idoc || !iwin) return _fail('无法创建渲染用 iframe。');
                idoc.open();
                idoc.write('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>');
                idoc.close();

                // 复制 body 属性（class="tpl-xxx" 等，模板样式依赖它）
                Array.prototype.slice.call(srcDoc.body.attributes || []).forEach(function (a) {
                    try { idoc.body.setAttribute(a.name, a.value); } catch (_) {}
                });
                cssTexts.forEach(function (css) {
                    const s = idoc.createElement('style'); s.textContent = css; idoc.head.appendChild(s);
                });
                const ovStyle = idoc.createElement('style'); ovStyle.textContent = HTML_TO_PPT_OVERRIDE_CSS; idoc.head.appendChild(ovStyle);
                Array.prototype.slice.call(srcDoc.body.childNodes).forEach(function (n) {
                    try { idoc.body.appendChild(idoc.importNode(n, true)); } catch (_) {}
                });

                // 固定画布尺寸（不依赖 runtime.js）
                const deckEl = idoc.querySelector('.deck');
                if (deckEl) {
                    deckEl.style.setProperty('--deck-w', W + 'px');
                    deckEl.style.setProperty('--deck-h', H + 'px');
                    deckEl.style.width = W + 'px';
                    deckEl.style.height = H + 'px';
                    deckEl.style.transform = 'none';
                } else {
                    idoc.body.style.cssText = 'margin:0;padding:0;width:' + W + 'px;height:' + H + 'px;display:block;overflow:visible;';
                }

                let slides = Array.prototype.slice.call(idoc.querySelectorAll('.slide'));
                const isFallbackBody = !slides.length;
                if (isFallbackBody) slides = [idoc.body];

                await htmlToPptWaitAssets(idoc, iwin, 4000);
                await htmlToPptNextFrame(iwin);

                // 背影色
                let bg = bgOverride;
                if (!bg) {
                    try {
                        const cs = iwin.getComputedStyle(deckEl || idoc.body);
                        let c = cs.backgroundColor;
                        if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') {
                            const v = (cs.getPropertyValue('--bg') || '').trim();
                            c = v || '#ffffff';
                        }
                        bg = c;
                    } catch (_) { bg = '#ffffff'; }
                }
                if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') bg = '#ffffff';

                // ── 6) 生成 PPTX ──
                const PX_PER_IN = 144; // 1920px -> 13.333in
                const wIn = W / PX_PER_IN, hIn = H / PX_PER_IN;
                const pptx = new PptxGenJS();
                try { pptx.defineLayout({ name: 'HTMLPPT', width: wIn, height: hIn }); pptx.layout = 'HTMLPPT'; }
                catch (_) { pptx.layout = 'LAYOUT_16x9'; }

                const scale = Number(params.scale) > 0 ? Number(params.scale) : 2;
                const imgFmt = (params.image_format === 'jpeg' || params.image_format === 'jpg') ? 'jpeg' : 'png';
                const imgQuality = Number(params.image_quality) > 0 ? Number(params.image_quality) : 0.92;
                const geom = { W: W, H: H, wIn: wIn, hIn: hIn, baseDir: baseDir };

                let failCount = 0;
                for (let i = 0; i < slides.length; i++) {
                    const slideEl = slides[i];
                    // 只显示当前页，避免其它页叠影
                    slides.forEach(function (s, j) { try { s.style.display = (j === i) ? '' : 'none'; } catch (_) {} });
                    try { slideEl.classList.add('is-active'); } catch (_) {}
                    try { slideEl.style.opacity = '1'; slideEl.style.transform = 'none'; } catch (_) {}
                    await htmlToPptNextFrame(iwin);
                    htmlToPptFinishAnimations(iwin);
                    await htmlToPptNextFrame(iwin);

                    const pptSlide = pptx.addSlide();
                    let rendered = false;

                    if (mode === 'text') {
                        try { htmlToPptFillSlideText(pptSlide, slideEl, iwin, geom); rendered = true; }
                        catch (e) { console.warn('html_to_ppt: text 模式本页失败，回退为整页图片', e); }
                    }
                    if (!rendered) {
                        // 先常规栅格化；失败再尝试 foreignObject 渲染（对某些 CSS 更宽容）
                        const capOpts = [
                            { scale: scale, backgroundColor: bg, useCORS: true, logging: false, width: W, height: H, windowWidth: W, windowHeight: H },
                            { scale: scale, backgroundColor: bg, useCORS: true, logging: false, width: W, height: H, windowWidth: W, windowHeight: H, foreignObjectRendering: true }
                        ];
                        for (let a = 0; a < capOpts.length && !rendered; a++) {
                            try {
                                const canvas = await h2c(slideEl, capOpts[a]);
                                const dataUrl = (imgFmt === 'jpeg')
                                    ? canvas.toDataURL('image/jpeg', imgQuality)
                                    : canvas.toDataURL('image/png');
                                pptSlide.addImage({ data: dataUrl, x: 0, y: 0, w: wIn, h: hIn });
                                rendered = true;
                            } catch (e) {
                                if (a === capOpts.length - 1) {
                                    console.warn('html_to_ppt: 第 ' + (i + 1) + ' 页渲染失败', e);
                                    failCount++;
                                }
                            }
                        }
                    }

                    // 逐字稿 → PPT 备注
                    try {
                        const nEl = slideEl.querySelector ? slideEl.querySelector('.notes, aside.notes, .speaker-notes') : null;
                        if (nEl) {
                            const ps = nEl.querySelectorAll('p');
                            const note = ps.length
                                ? Array.prototype.slice.call(ps).map(function (p) { return (p.textContent || '').trim(); }).filter(Boolean).join('\n\n')
                                : (nEl.textContent || '').trim();
                            if (note) pptSlide.addNotes(note);
                        }
                    } catch (_) {}
                }

                // ── 7) 导出字节 ──
                let bytes = null;
                try {
                    const blob = await pptx.write('blob');
                    if (blob && blob.arrayBuffer) bytes = new Uint8Array(await blob.arrayBuffer());
                } catch (_) {}
                if (!bytes) {
                    try {
                        const out = await pptx.write({ outputType: 'arraybuffer' });
                        if (out) bytes = new Uint8Array(out);
                    } catch (_) {}
                }
                if (!bytes || !bytes.length) return _fail('生成 PPTX 字节失败（PptxGenJS.write 未返回数据）。');

                const output_path = (params.output_path && String(params.output_path).trim()) || '/home/pyodide/output.pptx';
                let filename = (params.filename && String(params.filename).trim()) || output_path.split('/').pop() || 'output.pptx';
                if (!/\.pptx$/i.test(filename)) filename += '.pptx';

                // ── 8) 写入 almostnode FS（可用时）──
                let wroteToFS = false;
                if (hasFS) {
                    try {
                        const dir = output_path.substring(0, output_path.lastIndexOf('/'));
                        if (dir) { try { nodeRuntime.FS.mkdirTree(dir); } catch (_) {} }
                        nodeRuntime.FS.writeFile(output_path, bytes);
                        wroteToFS = true;
                        if (typeof pgpySyncMount === 'function') { try { await pgpySyncMount(false); } catch (_) {} }
                    } catch (e) { console.warn('html_to_ppt: 写入 almostnode FS 失败', e); }
                }

                // ── 9) 可选下载（默认关闭，避免打扰）──
                let downloaded = false;
                if (params.download === true) {
                    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = filename;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
                    downloaded = true;
                }

                return _ok([
                    '已生成 PPTX：' + slides.length + ' 页（' + W + '×' + H + ' px 画布 · ' + mode + ' 模式），' +
                        (bytes.length / 1024).toFixed(1) + ' KB' + (failCount ? ('，其中 ' + failCount + ' 页渲染失败') : ''),
                    wroteToFS ? ('已写入 almostnode FS：' + output_path) : '未写入 almostnode FS（Node 运行时未就绪）',
                    downloaded ? ('已触发下载：' + filename) : '未触发下载（默认关闭自动下载）'
                ].join('\n'));
            } catch (e) {
                console.error('html_to_ppt failed', e);
                return _fail(e && e.message ? e.message : String(e));
            } finally {
                try { if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch (_) {}
            }
        }

        // ══════════════════════════════════════════════════════════════
        //  chart —— 纯 SVG 图表（无外部库，离线可用；可选 PNG 栅格化）
        //    入参：{ type:'bar'|'line'|'area'|'pie'|'scatter',
        //            data?:[{label,value}] | values?:number[] | series?:[{name,values[]}],
        //            labels?:[], title?, x_label?, y_label?,
        //            width?=960, height?=540, output_path?, format?:'svg'|'png' }
        //    产物：写入 almostnode FS（SVG 文本 / PNG 字节，二进制保真），回传 artifacts。
        // ══════════════════════════════════════════════════════════════
        function _svgEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]; }); }
        var _CHART_COLORS = ['#2f6feb', '#3fb950', '#d29922', '#ff7b72', '#a371f7', '#39c5cf', '#db61a2', '#f0883e'];

        function _chartNormalize(params) {
            params = params || {};
            var t = String(params.type || 'bar').toLowerCase();
            if (['bar', 'line', 'area', 'pie', 'scatter'].indexOf(t) === -1) t = 'bar';
            var labels = Array.isArray(params.labels) ? params.labels.slice() : null;
            var series = [];
            if (Array.isArray(params.series) && params.series.length) {
                params.series.forEach(function (s) { series.push({ name: String((s && s.name) || ''), values: ((s && s.values) || []).map(Number) }); });
            } else if (Array.isArray(params.data) && params.data.length) {
                labels = params.data.map(function (d, i) { return (d && d.label != null) ? String(d.label) : String(i + 1); });
                series = [{ name: params.y_label || '', values: params.data.map(function (d) { return Number(d && (d.value != null ? d.value : d.y)); }) }];
            } else if (Array.isArray(params.values)) {
                series = [{ name: '', values: params.values.map(Number) }];
            }
            if (!labels) { var n = series[0] ? series[0].values.length : 0; labels = []; for (var i = 0; i < n; i++) labels.push(String(i + 1)); }
            return { type: t, labels: labels, series: series };
        }
        function _niceMax(v) { if (!(v > 0)) return 1; var e = Math.pow(10, Math.floor(Math.log10(v))); var f = v / e; var n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; return n * e; }

        function _chartSVG(params) {
            var norm = _chartNormalize(params);
            var W = Number(params.width) > 0 ? Number(params.width) : 960;
            var H = Number(params.height) > 0 ? Number(params.height) : 540;
            var title = params.title ? String(params.title) : '';
            var padL = 64, padR = 24, padT = title ? 54 : 24, padB = 64;
            var innerW = W - padL - padR, innerH = H - padT - padB;
            var font = 'font-family="sans-serif" font-size="12" fill="#555"';
            var parts = [];
            parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">');
            parts.push('<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>');
            if (title) parts.push('<text x="' + (W / 2) + '" y="32" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#111">' + _svgEsc(title) + '</text>');

            if (norm.type === 'pie') {
                var vals = norm.series[0].values;
                var total = vals.reduce(function (a, b) { return a + (isFinite(b) ? b : 0); }, 0) || 1;
                var cx = W / 2, cy = padT + innerH / 2, r = Math.min(innerW, innerH) / 2 - 16, a0 = -Math.PI / 2;
                vals.forEach(function (v, i) {
                    var frac = (isFinite(v) ? v : 0) / total, a1 = a0 + frac * Math.PI * 2;
                    var large = frac > 0.5 ? 1 : 0;
                    var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
                    var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
                    parts.push('<path d="M' + cx + ',' + cy + ' L' + x0.toFixed(1) + ',' + y0.toFixed(1) + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(1) + ',' + y1.toFixed(1) + ' Z" fill="' + _CHART_COLORS[i % _CHART_COLORS.length] + '" stroke="#fff" stroke-width="1"/>');
                    var mid = (a0 + a1) / 2;
                    parts.push('<text x="' + (cx + (r + 14) * Math.cos(mid)).toFixed(1) + '" y="' + (cy + (r + 14) * Math.sin(mid)).toFixed(1) + '" ' + font + '>' + _svgEsc(String(norm.labels[i] || '') + ' ' + Math.round(frac * 100) + '%') + '</text>');
                    a0 = a1;
                });
            } else {
                var maxV = 0, minV = 0;
                norm.series.forEach(function (s) { s.values.forEach(function (v) { if (isFinite(v)) { if (v > maxV) maxV = v; if (v < minV) minV = v; } }); });
                var yMax = _niceMax(maxV || 1), yMin = (minV < 0) ? -_niceMax(-minV) : 0;
                function yPix(v) { var tt = (v - yMin) / ((yMax - yMin) || 1); return padT + innerH - tt * innerH; }
                function xPix(i) { var n = norm.labels.length; if (norm.type === 'bar') { var step = innerW / n; return padL + step * i + step / 2; } return padL + (n <= 1 ? innerW / 2 : innerW * i / (n - 1)); }
                for (var g = 0; g <= 5; g++) {
                    var vv = yMin + (yMax - yMin) * g / 5, yy = yPix(vv);
                    parts.push('<line x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (padL + innerW) + '" y2="' + yy.toFixed(1) + '" stroke="#eee"/>');
                    parts.push('<text x="' + (padL - 8) + '" y="' + (yy + 4).toFixed(1) + '" text-anchor="end" ' + font + '>' + (Math.round(vv * 100) / 100) + '</text>');
                }
                parts.push('<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + innerH) + '" stroke="#ccc"/>');
                norm.labels.forEach(function (lb, i) { parts.push('<text x="' + xPix(i).toFixed(1) + '" y="' + (padT + innerH + 20) + '" text-anchor="middle" ' + font + '>' + _svgEsc(String(lb).slice(0, 12)) + '</text>'); });
                norm.series.forEach(function (s, si) {
                    var color = _CHART_COLORS[si % _CHART_COLORS.length];
                    if (norm.type === 'bar') {
                        var bw = Math.min(48, (innerW / norm.labels.length) * 0.6);
                        s.values.forEach(function (v, i) {
                            if (!isFinite(v)) return;
                            var xx = xPix(i), y0 = yPix(0), y1 = yPix(v);
                            parts.push('<rect x="' + (xx - bw / 2).toFixed(1) + '" y="' + Math.min(y0, y1).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.abs(y1 - y0).toFixed(1) + '" fill="' + color + '" opacity="0.85"/>');
                        });
                    } else if (norm.type === 'line' || norm.type === 'area') {
                        var pts = s.values.map(function (v, i) { return xPix(i).toFixed(1) + ',' + yPix(v).toFixed(1); });
                        if (norm.type === 'area') parts.push('<polygon points="' + padL + ',' + yPix(0).toFixed(1) + ' ' + pts.join(' ') + ' ' + (padL + innerW) + ',' + yPix(0).toFixed(1) + '" fill="' + color + '" opacity="0.2"/>');
                        parts.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="2"/>');
                        s.values.forEach(function (v, i) { parts.push('<circle cx="' + xPix(i).toFixed(1) + '" cy="' + yPix(v).toFixed(1) + '" r="3" fill="' + color + '"/>'); });
                    } else {
                        s.values.forEach(function (v, i) { parts.push('<circle cx="' + xPix(i).toFixed(1) + '" cy="' + yPix(v).toFixed(1) + '" r="4" fill="' + color + '" opacity="0.8"/>'); });
                    }
                });
            }
            parts.push('</svg>');
            return parts.join('');
        }

        function _b64ToBytes(b64) { var bin = atob(b64); var len = bin.length; var bytes = new Uint8Array(len); for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i); return bytes; }
        function _svgToPng(svg, w, h, scale) {
            return new Promise(function (resolve, reject) {
                try {
                    var img = new Image();
                    var url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
                    img.onload = function () {
                        var c = document.createElement('canvas');
                        c.width = Math.round(w * scale); c.height = Math.round(h * scale);
                        var ctx = c.getContext('2d');
                        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
                        ctx.drawImage(img, 0, 0, c.width, c.height);
                        resolve(c.toDataURL('image/png'));
                    };
                    img.onerror = function () { reject(new Error('SVG→PNG 失败（或环境不支持 canvas 绘制 SVG）')); };
                    img.src = url;
                } catch (e) { reject(e); }
            });
        }

        async function chart(params) {
            params = params || {};
            var _fail = function (m) { return JSON.stringify({ success: false, content: [{ type: 'text', text: 'chart error: ' + m }] }); };
            try {
                var norm = _chartNormalize(params);
                if (!norm.series.length || !norm.series[0].values.length) return _fail('需要 data / values / series 之一。');
                var svg = _chartSVG(params);
                var format = (String(params.format || '').toLowerCase() === 'png') ? 'png' : 'svg';
                var output_path = (params.output_path && String(params.output_path).trim()) || ('/home/pyodide/chart.' + format);
                var W = Number(params.width) > 0 ? Number(params.width) : 960;
                var H = Number(params.height) > 0 ? Number(params.height) : 540;
                var bytes;
                if (format === 'png') {
                    var png = await _svgToPng(svg, W, H, Number(params.scale) > 0 ? Number(params.scale) : 2);
                    bytes = _b64ToBytes(png.split(',')[1]);
                } else {
                    bytes = new TextEncoder().encode(svg);
                }
                var wrote = false;
                try { if (nodeRuntime && nodeRuntime.ready && nodeRuntime.FS) { nodeRuntime.FS.writeFile(output_path, bytes); wrote = true; } } catch (e) { console.warn('chart: 写入 almostnode FS 失败', e); }
                return JSON.stringify({
                    success: true,
                    content: [{ type: 'text', text: '已生成图表（' + norm.type + '，' + norm.labels.length + ' 个数据点）：' + output_path + (wrote ? '' : '（未写入 FS：Node 运行时未就绪）') }],
                    artifacts: [{ kind: 'chart', path: output_path, label: output_path.split('/').pop() }]
                });
            } catch (e) { console.error('chart failed', e); return _fail(e && e.message ? e.message : String(e)); }
        }

        // markdown_to_docx：Markdown → .docx（本地 marked + html-docx，无网络）
        async function markdown_to_docx(params) {
            params = params || {};
            var _fail = function (m) { return JSON.stringify({ success: false, content: [{ type: 'text', text: 'markdown_to_docx error: ' + m }] }); };
            try {
                var md = params.markdown;
                if ((md === undefined || md === null || md === '') && params.file_path) {
                    try { var b = nodeRuntime.FS.readFile(params.file_path, { encoding: 'binary' }); md = new TextDecoder().decode(b); }
                    catch (e) { return _fail('无法读取 file_path：' + (e && e.message)); }
                }
                if (typeof md !== 'string' || !md.trim()) return _fail('需要 markdown 或 file_path。');
                if (!window.marked || typeof window.marked.parse !== 'function') return _fail('marked 未加载。');
                var lib = window.htmlDocx || window.htmlDocxJs;
                if (!lib || typeof lib.asBlob !== 'function') return _fail('html-docx 未加载。');
                var html = '<html><head><meta charset="utf-8"></head><body>' + window.marked.parse(md) + '</body></html>';
                var bytes = new Uint8Array(await lib.asBlob(html).arrayBuffer());
                var output_path = (params.output_path && String(params.output_path).trim()) || '/home/pyodide/output.docx';
                var wrote = false;
                try { if (nodeRuntime && nodeRuntime.ready && nodeRuntime.FS) { nodeRuntime.FS.writeFile(output_path, bytes); wrote = true; } } catch (e) { console.warn('markdown_to_docx: 写入 FS 失败', e); }
                return JSON.stringify({
                    success: true,
                    content: [{ type: 'text', text: '已生成 DOCX：' + output_path + (wrote ? '' : '（未写入 FS：Node 运行时未就绪）') }],
                    artifacts: [{ kind: 'docx', path: output_path, label: output_path.split('/').pop() }]
                });
            } catch (e) { console.error('markdown_to_docx failed', e); return _fail(e && e.message ? e.message : String(e)); }
        }

        // ══════════════════════════════════════════════════════════════
        //  file_to_image：把「文档」转成图片（PNG/JPEG），支持
        //    markdown / docx / xlsx / pptx / pdf 五种格式。
        //  统一流水线：任意源 →(docx/xlsx/pptx/pdf 先经 anydoc 归一为 markdown)
        //    → markview-web 排成 A4 分页(.mvw-sheet) → 逐页用 snapdom 栅格化成图片
        //    →（先转 PDF）把这些页图组装成一份 A4 PDF 落盘 →（后转 image）逐页图片写入 FS。
        //  要点：
        //    · 「使用 snapdom 做 html→image」：分页后的 A4 HTML 交给
        //      window.snapdom.toCanvas() 栅格化（HTML/DOM → 图片，替代 html2canvas）。
        //    · 「先转 PDF 再转 image」：中间 PDF 的每一页就是对应页图，二者同源、
        //      页数一致；PDF 为中间产物（可用 keep_pdf=false 关闭），图片为最终交付。
        //    · 依赖：markview-web、markdown-it、snapdom、jspdf、anydoc（Office/PDF→md）。
        // ══════════════════════════════════════════════════════════════
        // html→image：把一段 HTML 字符串渲染进离屏容器；按 .mvw-sheet/.page/.slide 拆页，
        // 无显式分页容器时整体作一页。<style>/<link> 随容器一起移除，不污染全局样式。
        function fileToImageBuildHtmlStage(htmlSource, width) {
            var container = document.createElement('div');
            container.setAttribute('data-file-to-image', 'html');
            container.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + width + 'px;background:#ffffff;';
            document.body.appendChild(container);
            try {
                var doc = new DOMParser().parseFromString(String(htmlSource || ''), 'text/html');
                var headNodes = doc.head ? doc.head.querySelectorAll('style,link[rel="stylesheet"]') : [];
                for (var i = 0; i < headNodes.length; i++) {
                    try { container.appendChild(document.importNode(headNodes[i], true)); } catch (_) {}
                }
                if (doc.body) {
                    var kids = Array.prototype.slice.call(doc.body.childNodes);
                    for (var j = 0; j < kids.length; j++) {
                        try { container.appendChild(document.importNode(kids[j], true)); } catch (_) {}
                    }
                }
            } catch (e) {
                try { container.innerHTML = String(htmlSource || ''); } catch (_) {}
            }
            var units = Array.prototype.slice.call(container.querySelectorAll('.mvw-sheet, .page, .slide'));
            if (!units.length) units = [container];
            return { container: container, units: units };
        }

        // 把图片按比例“contain”进 A4（210×297mm），返回放置矩形（不同宽高比的页图都摆得下）。
        function fileToImageFitRect(dataUrl) {
            return new Promise(function (resolve) {
                var fallback = { x: 0, y: 0, w: 210, h: 297 };
                try {
                    var im = new Image();
                    im.onload = function () {
                        var w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
                        if (!w || !h) return resolve(fallback);
                        var s = Math.min(210 / w, 297 / h);
                        var rw = w * s, rh = h * s;
                        resolve({ x: (210 - rw) / 2, y: (297 - rh) / 2, w: rw, h: rh });
                    };
                    im.onerror = function () { resolve(fallback); };
                    im.src = dataUrl;
                } catch (e) { resolve(fallback); }
            });
        }

        async function file_to_image(params) {
            params = params || {};
            var _fail = function (m) { return JSON.stringify({ success: false, content: [{ type: 'text', text: 'file_to_image error: ' + m }] }); };
            var hasFS = !!(typeof nodeRuntime !== 'undefined' && nodeRuntime && nodeRuntime.ready && nodeRuntime.FS);
            var C = window.FileToImageCore;
            if (!C) return _fail('file-to-image-core.js 未加载（缺少 window.FileToImageCore）。');

            var cleanup = [];
            try {
                // ── 0) 判定格式（显式 format 优先，其次扩展名）──
                var file_path = params.file_path ? String(params.file_path).trim() : '';
                var markdown = params.markdown;
                var format = C.detectFormat(file_path, params.format);
                if (!file_path && markdown !== undefined && markdown !== null && markdown !== '') format = 'markdown';
                if (!file_path && params.html !== undefined && params.html !== null && String(params.html).trim() !== '' && format !== 'markdown') format = 'html';
                if (!format || !C.isSupported(format)) {
                    return _fail('无法识别格式（支持 ' + C.SUPPORTED.join('/') + '）。请提供 file_path 或显式 format。');
                }

                // ── 1) 源：html 直读 / markdown 直读 / Office·PDF 经 anydoc 归一为 markdown ──
                var htmlSource = '';
                if (format === 'html') {
                    htmlSource = (params.html !== undefined && params.html !== null) ? String(params.html) : '';
                    if (!htmlSource.trim()) {
                        if (!file_path) return _fail('html 格式需要 html 文本或 file_path（.html）。');
                        if (!hasFS) return _fail('Node 运行时未就绪，无法从 file_path 读取。');
                        try {
                            var hbytes = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });
                            htmlSource = new TextDecoder().decode(hbytes);
                        } catch (e) { return _fail("无法读取 file_path='" + file_path + "'：" + (e && e.message ? e.message : String(e))); }
                    }
                    if (!htmlSource.trim()) return _fail('HTML 源为空，无法转换。');
                } else if (format === 'markdown') {
                    if (markdown === undefined || markdown === null || markdown === '') {
                        if (!file_path) return _fail('markdown 格式需要 file_path 或 markdown 文本。');
                        if (!hasFS) return _fail('Node 运行时未就绪，无法从 file_path 读取。');
                        try {
                            var mbytes = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });
                            markdown = new TextDecoder().decode(mbytes);
                        } catch (e) { return _fail("无法读取 file_path='" + file_path + "'：" + (e && e.message ? e.message : String(e))); }
                    }
                    if (typeof markdown !== 'string' || markdown.trim() === '') return _fail('源内容为空，无法转换。');
                    try { if (typeof normalizeTexDelims === 'function') markdown = normalizeTexDelims(markdown); } catch (_) {}
                } else {
                    if (!file_path) return _fail('格式 ' + format + ' 需要 file_path（almostnode FS 内路径）。');
                    if (!hasFS) return _fail('Node 运行时未就绪，无法读取 file_path。');
                    var parse = window.__undocParse || window.__anydocParse;
                    if (typeof parse !== 'function' || window.__undocReady === false) {
                        return _fail('anydoc（Office/PDF→Markdown）未就绪，无法处理 ' + format + '。');
                    }
                    var srcBytes;
                    try { srcBytes = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' }); }
                    catch (e) { return _fail("无法读取 file_path='" + file_path + "'：" + (e && e.message ? e.message : String(e))); }
                    try {
                        var parsed = parse(srcBytes);
                        markdown = parsed.toMarkdown();
                    } catch (e) { return _fail('anydoc 解析 ' + format + ' 失败：' + (e && e.message ? e.message : String(e))); }
                    if (typeof markdown !== 'string' || markdown.trim() === '') return _fail('源内容为空，无法转换。');
                    try { if (typeof normalizeTexDelims === 'function') markdown = normalizeTexDelims(markdown); } catch (_) {}
                }

                // ── 2) 依赖检查 ──
                if (!window.snapdom || typeof window.snapdom.toCanvas !== 'function') return _fail('snapdom 未加载（缺少 window.snapdom.toCanvas）。');
                var MV = window.Markview;
                if (format !== 'html') {
                    if (!MV || typeof MV.renderPages !== 'function') return _fail('markview-web 未加载。');
                    if (!window.markdownit) return _fail('markdown-it 未加载。');
                }

                var width = Number(params.width) > 0 ? Number(params.width) : 720;
                var fontSize = Number(params.font_size) > 0 ? Number(params.font_size) : 18;
                var scale = Number(params.scale) > 0 ? Number(params.scale) : 2;
                var imageFormat = C.normalizeImageFormat(params.image_format);
                var imgQuality = Number(params.image_quality) > 0 ? Number(params.image_quality) : 0.92;
                var keepPdf = params.keep_pdf !== false; // 默认保留中间 PDF

                var plan = C.planOutputs({
                    output_path: params.output_path,
                    output_dir: params.output_dir,
                    base: params.base,
                    pdf_path: params.pdf_path,
                    image_format: imageFormat
                });

                // ── 3) 生成待栅格化的“页”单元 ──
                //   html：直接渲染进离屏容器（按 .mvw-sheet/.page/.slide 拆页，否则整体一页）；
                //   其余：markview-web 排成 A4 分页（.mvw-sheet）。
                var sheets;
                if (format === 'html') {
                    var built = fileToImageBuildHtmlStage(htmlSource, width);
                    cleanup.push(function () { try { built.container.remove(); } catch (_) {} });
                    sheets = built.units;
                    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) {} }
                } else {
                    if (window.mermaid && typeof window.mermaid.initialize === 'function') {
                        try { window.mermaid.initialize({ startOnLoad: false }); } catch (_) {}
                    }
                    var host = document.createElement('div');
                    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + (width + 40) + 'px;background:#ffffff;';
                    document.body.appendChild(host);
                    cleanup.push(function () { try { host.remove(); } catch (_) {} });
                    var opts = {
                        width: width,
                        fontSize: fontSize,
                        justify: params.justify !== false,
                        delimiters: ['dollars', 'brackets', 'beg_end'],
                        markdownit: window.markdownit
                    };
                    await MV.renderPages(host, markdown, opts);
                    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) {} }
                    sheets = Array.prototype.slice.call(host.querySelectorAll('.mvw-sheet'));
                    if (!sheets.length) sheets = [host];
                }
                var totalPages = sheets.length;

                var selected = C.selectPages(totalPages, params.pages);
                if (!selected.length) return _fail('没有可导出的页（pages 过滤后为空，总页数 ' + totalPages + '）。');

                // ── 4) 逐页 snapdom 栅格化（HTML/DOM → image）──
                var pageImages = []; // { index1, dataUrl }
                for (var si = 0; si < selected.length; si++) {
                    var pageIdx = selected[si];
                    var sheet = sheets[pageIdx];
                    var prevShadow = sheet.style.boxShadow, prevRadius = sheet.style.borderRadius;
                    sheet.style.boxShadow = 'none';
                    sheet.style.borderRadius = '0';
                    var canvas = null;
                    try {
                        canvas = await window.snapdom.toCanvas(sheet, {
                            scale: scale,
                            dpr: 1,
                            backgroundColor: '#ffffff'
                        });
                    } finally {
                        sheet.style.boxShadow = prevShadow;
                        sheet.style.borderRadius = prevRadius;
                    }
                    if (!canvas) { continue; }
                    var dataUrl = (imageFormat === 'jpeg')
                        ? canvas.toDataURL('image/jpeg', imgQuality)
                        : (imageFormat === 'webp' ? canvas.toDataURL('image/webp', imgQuality) : canvas.toDataURL('image/png'));
                    pageImages.push({ index1: pageIdx + 1, dataUrl: dataUrl });
                    try { canvas.width = 1; canvas.height = 1; } catch (_) {}
                    await new Promise(function (r) { setTimeout(r, 0); }); // 让出主线程
                }
                if (!pageImages.length) return _fail('栅格化失败：没有得到任何页面图片。');

                // ── 5) 先转 PDF：把每页图片组装成一份 A4 PDF 并落盘 ──
                var pdfWrotePath = '';
                if (keepPdf) {
                    var ns = window.jspdf;
                    var JsPDF = ns && (ns.jsPDF || ns.default || ns);
                    if (!JsPDF) return _fail('jsPDF 未加载，无法生成中间 PDF。');
                    var pdf = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
                    var imgType = (imageFormat === 'jpeg') ? 'JPEG' : 'PNG';
                    for (var pi = 0; pi < pageImages.length; pi++) {
                        if (pi > 0) pdf.addPage();
                        var rect = await fileToImageFitRect(pageImages[pi].dataUrl);
                        pdf.addImage(pageImages[pi].dataUrl, imgType, rect.x, rect.y, rect.w, rect.h);
                    }
                    var pdfBytes = new Uint8Array(pdf.output('arraybuffer'));
                    if (hasFS) {
                        try {
                            var pdir = plan.pdfPath.substring(0, plan.pdfPath.lastIndexOf('/'));
                            if (pdir) { try { nodeRuntime.FS.mkdirTree(pdir); } catch (_) {} }
                            nodeRuntime.FS.writeFile(plan.pdfPath, pdfBytes);
                            pdfWrotePath = plan.pdfPath;
                        } catch (e) { console.warn('file_to_image: 写中间 PDF 失败', e); }
                    }
                }

                // ── 6) 后转 image：逐页图片写入 almostnode FS ──
                var written = [];
                if (hasFS) {
                    try { nodeRuntime.FS.mkdirTree(plan.imageDir); } catch (_) {}
                    for (var wi = 0; wi < pageImages.length; wi++) {
                        var name = C.imageName(plan.base, pageImages[wi].index1, imageFormat);
                        var outPath = plan.imageDir.replace(/\/+$/, '') + '/' + name;
                        try {
                            var dec = C.decodeDataUrl(pageImages[wi].dataUrl);
                            nodeRuntime.FS.writeFile(outPath, dec.bytes);
                            written.push(outPath);
                        } catch (e) { console.warn('file_to_image: 写图片失败 ' + outPath, e); }
                    }
                    if (typeof pgpySyncMount === 'function') { try { await pgpySyncMount(false); } catch (_) {} }
                }

                // ── 7) 可选：触发浏览器下载逐页图片 ──
                var downloaded = 0;
                if (params.download === true) {
                    for (var di = 0; di < pageImages.length; di++) {
                        try {
                            var a = document.createElement('a');
                            a.href = pageImages[di].dataUrl;
                            a.download = C.imageName(plan.base, pageImages[di].index1, imageFormat);
                            document.body.appendChild(a); a.click(); document.body.removeChild(a);
                            downloaded++;
                        } catch (_) {}
                    }
                }

                // ── 8) 汇总 ──
                var pageList = pageImages.map(function (p) { return p.index1; });
                var lines = [];
                lines.push('已生成 ' + pageImages.length + ' 张图片（格式 ' + imageFormat + '，来源 ' + format + '，总 ' + totalPages + ' 页，导出页：' + pageList.join(',') + '）');
                lines.push('中间 PDF：' + (pdfWrotePath ? ('已写入 ' + pdfWrotePath) : (keepPdf ? '未写入（Node 运行时未就绪）' : '已跳过（keep_pdf=false）')));
                lines.push(written.length ? ('图片已写入：\n  ' + written.join('\n  ')) : '图片未写入 almostnode FS（Node 运行时未就绪）');
                if (params.download === true) lines.push('已触发下载 ' + downloaded + ' 张');
                return JSON.stringify({
                    success: true,
                    content: [{ type: 'text', text: lines.join('\n') }],
                    structuredContent: {
                        format: format,
                        pages: pageList,
                        total_pages: totalPages,
                        pdf_path: pdfWrotePath || null,
                        images: written
                    }
                });
            } catch (e) {
                console.error('file_to_image failed', e);
                return _fail(e && e.message ? e.message : String(e));
            } finally {
                for (var ci = 0; ci < cleanup.length; ci++) { try { cleanup[ci](); } catch (_) {} }
            }
        }


        // ── 注册交付物工具（走可插拔注册表 tool-registry；registerTool 在 07-mcp 中定义，
        //    本文件在其之前加载，故延迟到 DOMContentLoaded（此时全部脚本已就绪）──
        (function () {
            function reg() {
                try {
                    if (typeof window.registerTool !== 'function') return;
                    window.registerTool({
                        name: 'chart',
                        description: '生成图表（bar/line/area/pie/scatter）→ SVG/PNG，并写入工作区。Args: { type, data?:[{label,value}] | values?:number[] | series?:[{name,values[]}], labels?, title?, x_label?, y_label?, width?, height?, output_path?, format?:svg|png }',
                        tags: ['doc', 'builtin'],
                        inputSchema: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', enum: ['bar', 'line', 'area', 'pie', 'scatter'] },
                                data: { type: 'array', items: {} },
                                values: { type: 'array', items: {} },
                                series: { type: 'array', items: {} },
                                labels: { type: 'array', items: {} },
                                title: { type: 'string' },
                                x_label: { type: 'string' },
                                y_label: { type: 'string' },
                                output_path: { type: 'string' },
                                format: { type: 'string', enum: ['svg', 'png'] },
                                width: { type: 'integer' },
                                height: { type: 'integer' }
                            },
                            required: []
                        },
                        handler: function (args) { return chart(args || {}); }
                    });
                    window.registerTool({
                        name: 'markdown_to_docx',
                        description: 'Markdown → .docx（本地 marked + html-docx）。Args: { markdown | file_path, output_path?, filename? }',
                        tags: ['doc', 'builtin'],
                        inputSchema: {
                            type: 'object',
                            properties: { markdown: { type: 'string' }, file_path: { type: 'string' }, output_path: { type: 'string' }, filename: { type: 'string' } },
                            required: []
                        },
                        handler: function (args) { return markdown_to_docx(args || {}); }
                    });
                    window.registerTool({
                        name: 'file_to_image',
                        description: '把文档转成图片（PNG/JPEG），支持 html / docx / xlsx / pptx / pdf / markdown。html 直接走 snapdom 的 HTML→图片直通（按 .page/.slide/.mvw-sheet 拆页，否则整体一页）；docx/xlsx/pptx/pdf 先经 anydoc 归一为 Markdown，再用 markview-web 排成 A4 分页，逐页用 snapdom 做「HTML→图片」栅格化；随后把这些页图组装成一份中间 PDF（先转 PDF），并把逐页图片写入 almostnode FS（后转 image）。提供 file_path（almostnode FS 内路径）或 html/markdown 文本；可用 format 覆盖扩展名识别。输出：<base>-1.png、<base>-2.png… 及中间 <base>.pdf。',
                        tags: ['doc', 'builtin', 'image'],
                        inputSchema: {
                            type: 'object',
                            properties: {
                                file_path: { type: 'string', description: '源文件在 almostnode FS 内的路径，如 /home/pyodide/report.docx。' },
                                format: { type: 'string', enum: ['html', 'markdown', 'docx', 'xlsx', 'pptx', 'pdf'], description: '源格式；缺省时按 file_path 扩展名识别。' },
                                markdown: { type: 'string', description: '直接提供 Markdown 文本（file_path 缺省时使用）。' },
                                html: { type: 'string', description: '直接提供 HTML 文本（file_path 缺省时使用；走 snapdom 的 HTML→图片直通路径）。' },
                                output_path: { type: 'string', description: '输出基名/路径；据此推导目录与文件名（如 /home/pyodide/out/report → out/report-1.png 与 out/report.pdf）。' },
                                output_dir: { type: 'string', description: '输出目录（覆盖由 output_path 推导的目录）。' },
                                base: { type: 'string', description: '输出文件名基（不含扩展名）。缺省由 output_path 推导。' },
                                pdf_path: { type: 'string', description: '中间 PDF 的目标路径。缺省为 <dir>/<base>.pdf。' },
                                image_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: '图片格式（默认 png）。' },
                                scale: { type: 'number', description: '栅格放大倍率（默认 2）。' },
                                image_quality: { type: 'number', description: 'jpeg/webp 质量 0-1（默认 0.92）。' },
                                width: { type: 'number', description: '排版列宽 CSS px（默认 720）。' },
                                font_size: { type: 'number', description: '正文字号 px（默认 18）。' },
                                justify: { type: 'boolean', description: '两端对齐（默认 true）。' },
                                pages: { type: 'array', items: { type: 'integer' }, description: '只导出指定页（1-based 页号数组）；缺省导出全部。' },
                                keep_pdf: { type: 'boolean', description: '是否保留中间 PDF（默认 true）。' },
                                download: { type: 'boolean', description: '是否触发浏览器下载逐页图片（默认 false）。' }
                            },
                            required: []
                        },
                        handler: function (args) { return file_to_image(args || {}); }
                    });
                } catch (e) { try { console.warn('[doc-deliverables] 注册失败', e); } catch (_) {} }
            }
            if (typeof document !== 'undefined') {
                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reg);
                else setTimeout(reg, 0);
            }
        })();




