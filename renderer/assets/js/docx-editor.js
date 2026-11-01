(function(){

    let currentDocumentBuffer = null;
    let originalFileName = "新文档.docx";
    let savedSelection = null;
    // 原文件跟踪：用于“未修改则原样保存”+“修改后尽量沿用原页面设置/默认字体”
    let _docxOrigBuffer = null;      // 最近一次 load 的原始字节 (ArrayBuffer)
    let _docxOrigHtml = null;        // 加载渲染完成后未编辑时的 HTML 快照
    let _docxOrigSectPr = '';        // 原始文档页面设置 <w:sectPr>
    let _docxOrigDocDefaults = '';   // 原始文档默认字体/段落 <w:docDefaults> 内部内容
    let _docxSettingsPromise = null; // 懒提取原始设置（一次性）

    const fileInput = document.getElementById("docx_fileInput");
    const imageInput = document.getElementById("docx_imageInput");
    const fileNameSpan = document.getElementById("docx_fileName");
    const docxContainer = document.getElementById("docx_docx-container");
    const selectFileBtn = document.getElementById("docx_selectFileBtn");
    const exportBtn = document.getElementById("docx_exportBtn");
    const newDocBtn = document.getElementById("docx_newDocBtn");
    const charCountSpan = document.getElementById("docx_charCount");
    const statusSpan = document.getElementById("docx_status");
    const richToolbar = document.getElementById("docx_richToolbar");
    const formatBlockSelect = document.getElementById("docx_formatBlockSelect");
    const fontNameSelect = document.getElementById("docx_fontNameSelect");
    const fontSizeSelect = document.getElementById("docx_fontSizeSelect");
    const foreColorPicker = document.getElementById("docx_foreColorPicker");
    const backColorPicker = document.getElementById("docx_backColorPicker");
    const createLinkBtn = document.getElementById("docx_createLinkBtn");
    const unlinkBtn = document.getElementById("docx_unlinkBtn");
    const insertImageBtn = document.getElementById("docx_insertImageBtn");
    const insertTableBtn = document.getElementById("docx_insertTableBtn");
    const insertHrBtn = document.getElementById("docx_insertHrBtn");

    function init() {
      docxContainer.setAttribute("contenteditable", "true");

      document.execCommand("styleWithCSS", false, true);

      docxContainer.addEventListener("input", updateCharCount);
      docxContainer.addEventListener("keyup", updateToolbarState);
      docxContainer.addEventListener("mouseup", updateToolbarState);
      docxContainer.addEventListener("blur", saveSelection);
      docxContainer.addEventListener("focus", restoreSelection);
      docxContainer.addEventListener("paste", handlePaste);

      fileInput.addEventListener("change", handleFileSelect);
      imageInput.addEventListener("change", handleImageSelect);
      selectFileBtn.addEventListener("click", () => fileInput.click());
      exportBtn.addEventListener("click", exportToWord);
      newDocBtn.addEventListener("click", createNewDocument);

      richToolbar.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });

      richToolbar.querySelectorAll("[data-command]").forEach((button) => {
        button.addEventListener("click", () => {
          executeCommand(button.dataset.command);
        });
      });

      formatBlockSelect.addEventListener("change", () => {
        executeCommand("formatBlock", formatBlockSelect.value);
      });

      fontNameSelect.addEventListener("change", () => {
        executeCommand("fontName", fontNameSelect.value);
      });

      fontSizeSelect.addEventListener("change", () => {
        executeCommand("fontSize", fontSizeSelect.value);
      });

      foreColorPicker.addEventListener("input", () => {
        executeCommand("foreColor", foreColorPicker.value);
      });

      backColorPicker.addEventListener("input", () => {
        executeCommand("hiliteColor", backColorPicker.value);
      });

      createLinkBtn.addEventListener("click", createLink);
      unlinkBtn.addEventListener("click", () => executeCommand("unlink"));
      insertImageBtn.addEventListener("click", () => imageInput.click());
      insertTableBtn.addEventListener("click", insertTable);
      insertHrBtn.addEventListener("click", () => executeCommand("insertHorizontalRule"));

      updateCharCount();
      statusSpan.textContent = "就绪";
    }

    function focusEditor() {
      docxContainer.focus();
      restoreSelection();
    }

    function saveSelection() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      if (docxContainer.contains(range.commonAncestorContainer)) {
        savedSelection = range.cloneRange();
      }
    }

    function restoreSelection() {
      if (!savedSelection) return;

      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(savedSelection);
    }

    function executeCommand(command, value = null) {
      focusEditor();
      document.execCommand(command, false, value);
      saveSelection();
      updateToolbarState();
      updateCharCount();
      statusSpan.textContent = "已应用格式";
    }

    function updateToolbarState() {
      const stateCommands = [
        "bold",
        "italic",
        "underline",
        "strikeThrough",
        "justifyLeft",
        "justifyCenter",
        "justifyRight",
        "justifyFull",
        "insertUnorderedList",
        "insertOrderedList"
      ];

      stateCommands.forEach((command) => {
        const button = richToolbar.querySelector(`[data-command="${command}"]`);
        if (!button) return;

        try {
          button.classList.toggle("active", document.queryCommandState(command));
        } catch (error) {
          button.classList.remove("active");
        }
      });
    }

    function createLink() {
      focusEditor();

      const url = prompt("请输入链接地址，例如：https://example.com");
      if (!url) return;

      const safeUrl = /^https?:\/\//i.test(url) ? url : "https://" + url;
      document.execCommand("createLink", false, safeUrl);

      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const anchor = getClosestElement(selection.anchorNode, "A");
        if (anchor) {
          anchor.setAttribute("target", "_blank");
          anchor.setAttribute("rel", "noopener noreferrer");
        }
      }

      saveSelection();
      updateCharCount();
      statusSpan.textContent = "已插入链接";
    }

    function getClosestElement(node, tagName) {
      let current = node;
      while (current && current !== docxContainer) {
        if (current.nodeType === Node.ELEMENT_NODE && current.tagName === tagName) {
          return current;
        }
        current = current.parentNode;
      }
      return null;
    }

    function handleImageSelect(event) {
      const file = event.target.files[0];
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        alert("请选择图片文件。");
        return;
      }

      const reader = new FileReader();
      reader.onload = function (e) {
        focusEditor();
        document.execCommand("insertImage", false, e.target.result);
        updateCharCount();
        statusSpan.textContent = "已插入图片";
      };
      reader.readAsDataURL(file);
      imageInput.value = "";
    }

    function insertTable() {
      focusEditor();

      const rowsInput = prompt("请输入行数", "3");
      if (rowsInput === null) return;

      const colsInput = prompt("请输入列数", "3");
      if (colsInput === null) return;

      const rows = Math.max(1, Math.min(20, parseInt(rowsInput, 10) || 3));
      const cols = Math.max(1, Math.min(12, parseInt(colsInput, 10) || 3));

      let html = "<table><tbody>";
      for (let i = 0; i < rows; i++) {
        html += "<tr>";
        for (let j = 0; j < cols; j++) {
          html += "<td>&nbsp;</td>";
        }
        html += "</tr>";
      }
      html += "</tbody></table><p><br></p>";

      document.execCommand("insertHTML", false, html);
      saveSelection();
      updateCharCount();
      statusSpan.textContent = `已插入 ${rows}×${cols} 表格`;
    }

    function handlePaste(event) {
      event.preventDefault();

      const clipboardData = event.clipboardData || window.clipboardData;
      const html = clipboardData.getData("text/html");
      const text = clipboardData.getData("text/plain");

      if (html) {
        const cleaned = sanitizePastedHtml(html);
        document.execCommand("insertHTML", false, cleaned);
      } else if (text) {
        document.execCommand("insertText", false, text);
      }

      updateCharCount();
      statusSpan.textContent = "已粘贴内容";
    }

    function sanitizePastedHtml(html) {
      const temp = document.createElement("div");
      temp.innerHTML = html;

      temp.querySelectorAll("script, style, iframe, object, embed").forEach((el) => el.remove());
      temp.querySelectorAll("*").forEach((el) => {
        [...el.attributes].forEach((attr) => {
          const name = attr.name.toLowerCase();
          if (name.startsWith("on")) {
            el.removeAttribute(attr.name);
          }
        });
      });

      return temp.innerHTML;
    }

    function handleFileSelect(event) {
      const file = event.target.files[0];

      if (!file) return;

      if (!file.name.toLowerCase().endsWith(".docx")) {
        alert("请选择有效的 .docx 文件");
        return;
      }

      originalFileName = file.name.replace(/\.docx$/i, "") + "_编辑版.docx";
      fileNameSpan.textContent = file.name;
      statusSpan.textContent = "正在处理文档...";

      const reader = new FileReader();

      reader.onload = function (e) {
        currentDocumentBuffer = e.target.result;
        renderDocxSmart(currentDocumentBuffer);
      };

      reader.onerror = function () {
        statusSpan.textContent = "文件读取失败";
        alert("文件读取失败，请重新选择文件。");
      };

      reader.readAsArrayBuffer(file);
    }

    function renderDocx(arrayBuffer) {
      docxContainer.innerHTML = "";

      docx.renderAsync(arrayBuffer, docxContainer, null, {
        className: "docx",
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        ignoreFonts: false,
        breakPages: true,
        ignoreLastRenderedPageBreak: true,
        experimental: true,
        trimXmlDeclaration: true,
        useBase64URL: true,
        useMathMLPolyfill: true,
        showChanges: false,
        debug: false
      })
        .then(() => {
          statusSpan.textContent = "文档已就绪，可开始编辑";
          docxContainer.setAttribute("contenteditable", "true");
          docxContainer.focus();
          savedSelection = null;
          updateCharCount();
          updateToolbarState();
        })
        .catch((error) => {
          console.error("渲染文档时出错：", error);
          docxContainer.innerHTML = `
            <p style="color: red; text-align: center;">
              错误：无法渲染该文档。请确保是有效的 .docx 文件。
            </p>
          `;
          statusSpan.textContent = "文档渲染失败";
        });
    }

    function updateCharCount() {
      const text = docxContainer.innerText || "";
      const charCount = text.replace(/\s/g, "").length;
      charCountSpan.textContent = "字符数: " + charCount;
    }

    function createNewDocument() {
      const hasContent = docxContainer.innerText.trim().length > 0;
      const isPlaceholder = docxContainer.innerHTML.includes("请上传 DOCX 文件或开始编辑新文档");

      if (hasContent && !isPlaceholder) {
        const confirmed = confirm("确定要创建新文档吗？当前未保存的更改将丢失。");
        if (!confirmed) return;
      }

      docxContainer.innerHTML = `
        <h1>新文档标题</h1>
        <p>开始输入您的内容...</p>
      `;

      fileNameSpan.textContent = "";
      currentDocumentBuffer = null;
      originalFileName = "新文档.docx";
      savedSelection = null;
      statusSpan.textContent = "新文档已就绪";
      updateCharCount();
      docxContainer.focus();
    }

    function cleanExportHtml(html) {
      const temp = document.createElement("div");
      temp.innerHTML = html;

      const placeholder = temp.querySelector(".placeholder");
      if (placeholder) {
        placeholder.remove();
      }

      temp.querySelectorAll("script, style, iframe, object, embed").forEach((el) => el.remove());

      temp.querySelectorAll("*").forEach((el) => {
        el.removeAttribute("contenteditable");
        el.removeAttribute("data-gramm");
        el.removeAttribute("data-gramm_editor");
        el.removeAttribute("data-enable-grammarly");
      });

      return temp.innerHTML;
    }

    // 生成当前编辑内容的 DOCX Blob（导出下载 / 宿主页面保存到沙箱共用）
    function buildDocxBlob() {
      const content = cleanExportHtml(docxContainer.innerHTML);

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body {
              font-family: "Microsoft YaHei", "SimSun", "Arial", sans-serif;
              font-size: 12pt;
              line-height: 1.6;
              color: #000;
            }

            p {
              margin: 0 0 10px 0;
            }

            h1 {
              font-size: 22pt;
              font-weight: bold;
              margin: 18px 0 12px 0;
            }

            h2 {
              font-size: 18pt;
              font-weight: bold;
              margin: 16px 0 10px 0;
            }

            h3 {
              font-size: 15pt;
              font-weight: bold;
              margin: 14px 0 8px 0;
            }

            h4 {
              font-size: 13pt;
              font-weight: bold;
              margin: 12px 0 8px 0;
            }

            blockquote {
              border-left: 4px solid #4b6cb7;
              padding: 8px 14px;
              margin: 12px 0;
              background: #f5f7ff;
              color: #384152;
            }

            pre {
              font-family: "Courier New", monospace;
              background: #f3f4f6;
              padding: 10px;
              white-space: pre-wrap;
            }

            table {
              border-collapse: collapse;
              width: 100%;
              margin: 10px 0;
            }

            td,
            th {
              border: 1px solid #000;
              padding: 6px;
              vertical-align: top;
            }

            img {
              max-width: 100%;
              height: auto;
            }

            ul,
            ol {
              margin-left: 24px;
            }

            li {
              margin-bottom: 6px;
            }

            a {
              color: #1155cc;
              text-decoration: underline;
            }
          </style>
        </head>
        <body>
          ${content}
        </body>
        </html>
      `;

      return htmlDocx.asBlob(html, {
        orientation: "portrait",
        margins: {
          top: 720,
          right: 720,
          bottom: 720,
          left: 720
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════
    //  真实 OOXML (WordprocessingML) DOCX 导出
    //  html-docx-js 生成的文档 docx-preview 无法解析（内容以 MHT/altChunk 内嵌），
    //  保存后重新双击打开会空白/异常。这里改用 JSZip 直接生成标准的 Word 文档，
    //  Word 与 docx-preview 均可正常打开；编辑内容再次打开时可继续浏览/编辑。
    // ═══════════════════════════════════════════════════════════════
    function xEsc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function xColor(c) {
      if (!c) return '';
      c = String(c).trim().toLowerCase();
      if (c.charAt(0) === '#') c = c.slice(1);
      if (/^[0-9a-f]{3}$/.test(c)) c = c.split('').map(function (x) { return x + x; }).join('');
      if (/^[0-9a-f]{6}$/.test(c)) return c.toUpperCase();
      var m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
      if (m) {
        return [m[1], m[2], m[3]].map(function (v) {
          var n = Math.min(255, Math.max(0, Math.round(parseFloat(v))));
          var h = n.toString(16);
          return h.length < 2 ? '0' + h : h;
        }).join('').toUpperCase();
      }
      return '';
    }

    function xFontSize(v) {
      v = String(v || '').trim().toLowerCase();
      var m = v.match(/^([\d.]+)\s*(pt|px|em|rem)?/);
      if (!m) return 0;
      var n = parseFloat(m[1]);
      var u = m[2] || '';
      if (u === 'pt') return Math.round(n * 2);
      if (u === 'px') return Math.round(n * 2 * 0.75);
      if (u === 'em' || u === 'rem') return Math.round(n * 24);
      return Math.round(n * 2);
    }

    function xHtmlSizeToHalf(n) {
      var map = { 1: 16, 2: 20, 3: 24, 4: 28, 5: 36, 6: 48, 7: 72 };
      return map[n] || 0;
    }

    function xPropsXml(p) {
      p = p || {};
      var s = '';
      if (p.b) s += '<w:b/>';
      if (p.i) s += '<w:i/>';
      if (p.u) s += '<w:u w:val="single"/>';
      if (p.strike) s += '<w:strike/>';
      if (p.color) s += '<w:color w:val="' + p.color + '"/>';
      if (p.hl) s += '<w:shd w:val="clear" w:color="auto" w:fill="' + p.hl + '"/>';
      if (p.font) s += '<w:rFonts w:ascii="' + xEsc(p.font) + '" w:hAnsi="' + xEsc(p.font) + '" w:eastAsia="' + xEsc(p.font) + '"/>';
      if (p.sz) s += '<w:sz w:val="' + p.sz + '"/><w:szCs w:val="' + p.sz + '"/>';
      return s ? '<w:rPr>' + s + '</w:rPr>' : '';
    }

    function xExtendProps(parent, el) {
      var p = {};
      for (var k in parent) { if (Object.prototype.hasOwnProperty.call(parent, k)) p[k] = parent[k]; }
      var tag = el.nodeName ? el.nodeName.toUpperCase() : '';
      if (tag === 'B' || tag === 'STRONG') p.b = true;
      if (tag === 'I' || tag === 'EM') p.i = true;
      if (tag === 'U' || tag === 'INS') p.u = true;
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') p.strike = true;
      if (tag === 'A') { if (!p.color) p.color = '0563C1'; if (!p.u) p.u = true; }
      if (el.getAttribute) {
        var col = el.getAttribute('color');
        if (col) { var cc = xColor(col); if (cc) p.color = cc; }
        var face = el.getAttribute('face');
        if (face) p.font = String(face).trim();
        var fsz = el.getAttribute('size');
        if (fsz) { var n = parseInt(fsz, 10); if (n >= 1 && n <= 7) { var h = xHtmlSizeToHalf(n); if (h) p.sz = h; } }
      }
      var cs = el.style;
      if (cs) {
        if (cs.fontWeight === 'bold' || parseInt(cs.fontWeight || '', 10) >= 700) p.b = true;
        if (cs.fontStyle === 'italic') p.i = true;
        var dec = cs.textDecoration || '';
        if (dec.indexOf('underline') !== -1) p.u = true;
        if (dec.indexOf('line-through') !== -1) p.strike = true;
        if (cs.color) { var c2 = xColor(cs.color); if (c2) p.color = c2; }
        if (cs.backgroundColor) { var c3 = xColor(cs.backgroundColor); if (c3) p.hl = c3; }
        if (cs.fontFamily) { var ff = String(cs.fontFamily).split(',')[0].replace(/^['"]|['"]$/g, '').trim(); if (ff) p.font = ff; }
        if (cs.fontSize) { var sz = xFontSize(cs.fontSize); if (sz) p.sz = sz; }
      }
      return p;
    }

    function xRunXml(text, p) {
      var pr = xPropsXml(p);
      return '<w:r>' + (pr ? pr : '') + '<w:t xml:space="preserve">' + xEsc(text) + '</w:t></w:r>';
    }

    function xBrXml(p) {
      var pr = xPropsXml(p);
      return '<w:r>' + (pr ? pr : '') + '<w:br/></w:r>';
    }

    function xInlineXml(node, props, imgMap) {
      if (!node) return '';
      if (node.nodeType === 3) {
        var t = node.nodeValue;
        return t ? xRunXml(t, props) : '';
      }
      if (node.nodeType !== 1) return '';
      var tag = node.nodeName.toUpperCase();
      if (tag === 'BR') return xBrXml(props);
      if (tag === 'IMG') {
        var src = node.getAttribute('src') || '';
        var info = imgMap ? imgMap[src] : null;
        return info ? xImgXml(info, props) : '';
      }
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'META' || tag === 'LINK' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') return '';
      var np = xExtendProps(props, node);
      var xml = '';
      for (var i = 0; i < node.childNodes.length; i++) { xml += xInlineXml(node.childNodes[i], np, imgMap); }
      return xml;
    }

    function xImgXml(info, props) {
      var pr = xPropsXml(props);
      var cx = info.cx || 5486400;
      var cy = info.cy || 4114800;
      var id = info.docPr || 1;
      return '<w:r>' + (pr ? pr : '') +
        '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
        '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
        '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
        '<wp:docPr id="' + id + '" name="Picture ' + id + '"/>' +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + id + '" name="Picture ' + id + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="' + info.rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
        '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    }

    function xBlockPPr(el, opts) {
      opts = opts || {};
      var arr = [];
      if (opts.indent) arr.push('<w:ind w:left="720"/>');
      if (opts.spaceAfter) arr.push('<w:spacing w:after="' + opts.spaceAfter + '"/>');
      if (el && el.style && el.style.textAlign) arr.push('<w:jc w:val="' + xEsc(el.style.textAlign) + '"/>');
      return arr.length ? '<w:pPr>' + arr.join('') + '</w:pPr>' : '';
    }

    function xParaXml(runsXml, pPrXml) {
      return '<w:p>' + (pPrXml || '') + runsXml + '</w:p>';
    }

    function xHeading(el, level, imgMap) {
      var sizes = { 1: 44, 2: 36, 3: 30, 4: 26, 5: 22, 6: 20 };
      var base = { b: true, sz: sizes[level] || 24 };
      var runs = '';
      for (var i = 0; i < el.childNodes.length; i++) { runs += xInlineXml(el.childNodes[i], base, imgMap); }
      return xParaXml(runs, xBlockPPr(el, { spaceAfter: 120 }));
    }

    function xParagraph(el, imgMap, opts) {
      opts = opts || {};
      var runs = '';
      if (opts.prefix) runs += xRunXml(opts.prefix, {});
      var skipNestedList = !!opts.skipNestedList;
      for (var i = 0; i < el.childNodes.length; i++) {
        if (skipNestedList && el.childNodes[i].nodeType === 1) {
          var tg = el.childNodes[i].nodeName.toUpperCase();
          if (tg === 'UL' || tg === 'OL') continue;
        }
        runs += xInlineXml(el.childNodes[i], opts.props || {}, imgMap);
      }
      return xParaXml(runs, xBlockPPr(el, { indent: !!opts.indent }));
    }

    function xPre(el) {
      var text = (el.innerText != null) ? el.innerText : (el.textContent || '');
      var lines = String(text).replace(/\r/g, '').split('\n');
      var base = { font: 'Courier New', sz: 20 };
      var runs = '';
      for (var i = 0; i < lines.length; i++) {
        if (i > 0) runs += xBrXml(base);
        runs += xRunXml(lines[i], base);
      }
      return xParaXml(runs, xBlockPPr(null, {}));
    }

    function xList(el, imgMap) {
      var ordered = el.nodeName.toUpperCase() === 'OL';
      var xml = '';
      var idx = 0;
      var children = el.childNodes;
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c.nodeType !== 1) continue;
        if (c.nodeName.toUpperCase() !== 'LI') continue;
        idx++;
        var prefix = ordered ? (idx + '.  ') : '\u2022  ';
        var runs = xRunXml(prefix, {});
        for (var j = 0; j < c.childNodes.length; j++) {
          if (c.childNodes[j].nodeType === 1) {
            var tg = c.childNodes[j].nodeName.toUpperCase();
            if (tg === 'UL' || tg === 'OL') continue;
          }
          runs += xInlineXml(c.childNodes[j], {}, imgMap);
        }
        xml += xParaXml(runs, xBlockPPr(c, {}));
      }
      return xml;
    }

    function xCellBlocks(td, imgMap) {
      var hasBlock = false;
      var children = td.childNodes;
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c.nodeType !== 1) continue;
        if (xIsBlockTag(c.nodeName ? c.nodeName.toUpperCase() : '')) { hasBlock = true; break; }
      }
      if (!hasBlock) {
        var runs = '';
        for (var k = 0; k < children.length; k++) { runs += xInlineXml(children[k], {}, imgMap); }
        return xParaXml(runs, '');
      }
      return xBlocksXml(td, imgMap);
    }

    function xTable(el, imgMap) {
      var rows = [];
      for (var i = 0; i < el.childNodes.length; i++) {
        var c = el.childNodes[i];
        if (c.nodeType === 1 && c.nodeName.toUpperCase() === 'TR') rows.push(c);
      }
      var realCols = 0;
      rows.forEach(function (tr) {
        var cnt = 0;
        for (var k = 0; k < tr.childNodes.length; k++) {
          var cc = tr.childNodes[k];
          if (cc.nodeType === 1 && (cc.nodeName.toUpperCase() === 'TD' || cc.nodeName.toUpperCase() === 'TH')) cnt++;
        }
        realCols = Math.max(realCols, cnt);
      });
      var totalW = 9360;
      var colW = realCols ? Math.floor(totalW / realCols) : totalW;
      var xml = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' +
        '<w:tblBorders>' +
        '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
        '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
        '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
        '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
        '</w:tblBorders></w:tblPr>';
      if (realCols > 0) {
        xml += '<w:tblGrid>';
        for (var g = 0; g < realCols; g++) xml += '<w:gridCol w:w="' + colW + '"/>';
        xml += '</w:tblGrid>';
      }
      rows.forEach(function (tr) {
        xml += '<w:tr>';
        for (var k = 0; k < tr.childNodes.length; k++) {
          var cc = tr.childNodes[k];
          if (cc.nodeType !== 1) continue;
          var t = cc.nodeName.toUpperCase();
          if (t !== 'TD' && t !== 'TH') continue;
          xml += '<w:tc><w:tcPr><w:tcW w:w="' + colW + '" w:type="dxa"/></w:tcPr>' + xCellBlocks(cc, imgMap) + '</w:tc>';
        }
        xml += '</w:tr>';
      });
      xml += '</w:tbl>';
      return xml + '<w:p/>';
    }

    // ── 块级标签判定（含 docx-preview / contenteditable 常用容器）──
    function xIsBlockTag(tag) {
      return ['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'FIGURE',
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'BLOCKQUOTE', 'PRE', 'HR'
      ].indexOf(tag) !== -1;
    }

    // 判断元素是否包含“直接的块级子元素”
    function xHasDirectBlockChild(el) {
      if (!el || !el.childNodes) return false;
      for (var i = 0; i < el.childNodes.length; i++) {
        var cn = el.childNodes[i];
        if (cn.nodeType !== 1) continue;
        if (xIsBlockTag(cn.nodeName ? cn.nodeName.toUpperCase() : '')) return true;
      }
      return false;
    }

    function xBlocksXml(parent, imgMap) {
      var xml = '';
      for (var i = 0; i < parent.childNodes.length; i++) {
        var c = parent.childNodes[i];
        if (c.nodeType === 3) {
          var t = c.nodeValue;
          if (t && t.trim()) { xml += xParaXml(xRunXml(t, {}), ''); }
          continue;
        }
        if (c.nodeType !== 1) continue;
        var tag = c.nodeName.toUpperCase();
        switch (tag) {
          case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
            xml += xHeading(c, parseInt(tag.charAt(1), 10), imgMap); break;
          case 'BLOCKQUOTE':
            xml += xParagraph(c, imgMap, { indent: true }); break;
          case 'PRE':
            xml += xPre(c); break;
          case 'UL': case 'OL':
            xml += xList(c, imgMap); break;
          case 'LI':
            xml += xParagraph(c, imgMap, { prefix: '\u2022  ', skipNestedList: true }); break;
          case 'TABLE':
            xml += xTable(c, imgMap); break;
          case 'HR':
            xml += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
            break;
          case 'IMG': {
            var src = c.getAttribute('src') || '';
            var info = imgMap ? imgMap[src] : null;
            xml += xParaXml(info ? xImgXml(info, {}) : '', '');
            break;
          }
          // ═══════════════════════════════════════════════════════════════
          //  docx-preview 渲染时会把整篇文档包在 <div class="docx-wrapper">、
          //  <section class="docx"> 等容器里（inWrapper:true / breakPages）。
          //  此前这些容器落入 default 分支被当成“一个段落”处理，导致整篇文档
          //  在导出时合并成单个 <w:p>，段落/标题/列表全部丢失 → 格式错乱。
          //  修复：容器若包含块级子元素则“拆包”递归处理；若只是纯行内内容
          //  （如 contenteditable 里回车产生的 <div>），仍按段落输出。
          // ═══════════════════════════════════════════════════════════════
          case 'DIV': case 'SECTION': case 'ARTICLE': case 'MAIN': case 'ASIDE':
          case 'HEADER': case 'FOOTER': case 'NAV': case 'FIGURE': {
            if (xHasDirectBlockChild(c)) {
              xml += xBlocksXml(c, imgMap);
            } else {
              xml += xParagraph(c, imgMap, {});
            }
            break;
          }
          default:
            xml += xParagraph(c, imgMap, {});
        }
      }
      return xml;
    }

    function xCollectImages(root) {
      var imgs = root.querySelectorAll ? root.querySelectorAll('img') : [];
      var map = {};
      var order = [];
      var seen = {};
      for (var i = 0; i < imgs.length; i++) {
        var src = imgs[i].getAttribute('src') || '';
        if (!src || src.indexOf('data:') !== 0) continue;
        if (!seen[src]) { seen[src] = 1; order.push(src); }
      }
      order.forEach(function (src, idx) {
        map[src] = { src: src, rid: 'rIdImage' + (idx + 1), docPr: idx + 1, cx: 5486400, cy: 4114800 };
      });
      return { map: map, order: order };
    }

    function xParseDataUrl(src) {
      var idx = src.indexOf(',');
      if (idx < 0) return null;
      var head = src.slice(0, idx);
      var data = src.slice(idx + 1);
      var mime = (head.match(/^data:([^;]+)/) || [])[1] || '';
      var isB64 = /;base64/i.test(head);
      return { mime: String(mime).toLowerCase(), data: data, isB64: isB64 };
    }

    function xExtForMime(mime) {
      if (/png/.test(mime)) return 'png';
      if (/jpe?g/.test(mime)) return 'jpeg';
      if (/gif/.test(mime)) return 'gif';
      if (/bmp/.test(mime)) return 'bmp';
      return 'png';
    }

    function xBase64ToBytes(b64) {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }

    function xLoadImageSize(src) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () { resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height }); };
        img.onerror = function () { resolve({ w: 0, h: 0 }); };
        img.src = src;
      });
    }

    function xContentTypesXml(images) {
      var s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
      s += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
      s += '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';
      s += '<Default Extension="xml" ContentType="application/xml"/>';
      s += '<Default Extension="png" ContentType="image/png"/>';
      s += '<Default Extension="jpeg" ContentType="image/jpeg"/>';
      s += '<Default Extension="gif" ContentType="image/gif"/>';
      s += '<Default Extension="bmp" ContentType="image/bmp"/>';
      s += '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>';
      s += '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>';
      s += '</Types>';
      return s;
    }

    function xRootRelsXml() {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>';
    }

    function xDocRelsXml(images) {
      var s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
      images.forEach(function (im) {
        var ext = xExtForMime(im.parsed.mime);
        s += '<Relationship Id="' + im.info.rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + im.idx + '.' + ext + '"/>';
      });
      s += '</Relationships>';
      return s;
    }

    function xStylesXml() {
      var dd = _docxOrigDocDefaults ||
        '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>';
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:docDefaults>' + dd + '</w:docDefaults>' +
        '</w:styles>';
    }

    function xDocumentXml(bodyXml) {
      var sp = _docxOrigSectPr ||
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
        ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
        ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<w:body>' + bodyXml + sp +
        '</w:body></w:document>';
    }

    // ── 从原文件提取页面设置(sectPr)与默认字体(docDefaults)，尽量沿用原排版 ──
    function xStripSectionRefs(sectXml) {
      // 去掉对页眉/页脚/脚注/尾注部件的引用（本导出器不携带这些部件，避免文档损坏）
      sectXml = sectXml.replace(/<w:headerReference\b[^>]*\/>/gi, '')
                       .replace(/<w:headerReference\b[\s\S]*?<\/w:headerReference>/gi, '')
                       .replace(/<w:footerReference\b[^>]*\/>/gi, '')
                       .replace(/<w:footerReference\b[\s\S]*?<\/w:footerReference>/gi, '')
                       .replace(/<w:footnotePr\b[\s\S]*?<\/w:footnotePr>/gi, '')
                       .replace(/<w:endnotePr\b[\s\S]*?<\/w:endnotePr>/gi, '');
      return sectXml;
    }

    function xNormalizeDocDefaults(inner) {
      // 去掉主题字体属性（本导出器无 theme 部件，避免 Word 打开异常）
      inner = inner.replace(/\s+w:(?:asciiTheme|hAnsiTheme|eastAsiaTheme|cstheme)="[^"]*"/g, '');
      return inner;
    }

    function xExtractOriginalSettings(arrayBuffer) {
      var ab = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : new Uint8Array(arrayBuffer).buffer;
      return JSZip.loadAsync(ab).then(function (zip) {
        var doc = zip.file('word/document.xml');
        var sty = zip.file('word/styles.xml');
        var pDoc = doc ? doc.async('string') : Promise.resolve('');
        var pSty = sty ? sty.async('string') : Promise.resolve('');
        return Promise.all([pDoc, pSty]).then(function (res) {
          var docXml = res[0] || '';
          var styXml = res[1] || '';
          // sectPr：取最后一个（body 级）
          var sects = docXml.match(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g);
          if (sects && sects.length) {
            _docxOrigSectPr = xStripSectionRefs(sects[sects.length - 1]);
          }
          // docDefaults：取内部内容
          var m = styXml.match(/<w:docDefaults\b[^>]*>([\s\S]*?)<\/w:docDefaults>/i);
          if (m && m[1]) {
            _docxOrigDocDefaults = xNormalizeDocDefaults(m[1]);
          }
        });
      }).catch(function () { /* 忽略提取失败 */ });
    }

    function xEnsureOriginalSettings() {
      if (!_docxSettingsPromise) {
        _docxSettingsPromise = _docxOrigBuffer ? xExtractOriginalSettings(_docxOrigBuffer) : Promise.resolve();
      }
      return _docxSettingsPromise;
    }

    async function xBuildRealDocx() {
      var content = cleanExportHtml(docxContainer.innerHTML);
      var temp = document.createElement('div');
      temp.innerHTML = content;
      var collected = xCollectImages(temp);
      // 预加载图片尺寸（用于绘制 EMU 尺寸）
      for (var i = 0; i < collected.order.length; i++) {
        var src0 = collected.order[i];
        var size = await xLoadImageSize(src0);
        var info = collected.map[src0];
        if (size.w > 0 && size.h > 0) {
          var emuW = Math.round(size.w * 9525);
          var emuH = Math.round(size.h * 9525);
          var maxW = 5486400;
          if (emuW > maxW) { var scale = maxW / emuW; emuW = maxW; emuH = Math.round(emuH * scale); }
          info.cx = emuW;
          info.cy = emuH;
        }
      }
      var bodyXml = xBlocksXml(temp, collected.map);
      var images = [];
      collected.order.forEach(function (src, idx) {
        var parsed = xParseDataUrl(src);
        if (!parsed) return;
        images.push({ idx: idx + 1, info: collected.map[src], parsed: parsed });
      });

      var zip = new JSZip();
      zip.file('[Content_Types].xml', xContentTypesXml(images));
      zip.file('_rels/.rels', xRootRelsXml());
      zip.folder('word').file('document.xml', xDocumentXml(bodyXml));
      zip.folder('word').file('styles.xml', xStylesXml());
      var rels = xDocRelsXml(images);
      if (rels.indexOf('media/') !== -1 || images.length === 0) {
        zip.folder('word').folder('_rels').file('document.xml.rels', rels);
      }
      images.forEach(function (im) {
        var ext = xExtForMime(im.parsed.mime);
        var bytes = im.parsed.isB64 ? xBase64ToBytes(im.parsed.data) : new TextEncoder().encode(decodeURIComponent(im.parsed.data));
        zip.folder('word').folder('media').file('image' + im.idx + '.' + ext, bytes);
      });
      return await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        compression: 'DEFLATE'
      });
    }

    async function exportDocxData() {
      // 1) 未做任何修改：直接把原文件字节原样返回，保证保存后格式与导入时 100% 一致
      if (_docxOrigBuffer && _docxOrigHtml !== null) {
        try {
          if (docxContainer.innerHTML === _docxOrigHtml) {
            return {
              blob: new Blob([_docxOrigBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
              real: true,
              unchanged: true
            };
          }
        } catch (e) {}
      }
      // 2) 有修改：沿用原文件页面设置(sectPr)/默认字体(docDefaults) 后重新生成
      try {
        await xEnsureOriginalSettings();
        var blob = await xBuildRealDocx();
        return { blob: blob, real: true, unchanged: false };
      } catch (e) {
        console.warn('真实 DOCX 导出失败，回退 html-docx:', e);
        if (typeof htmlDocx !== 'undefined' && typeof buildDocxBlob === 'function') {
          return { blob: buildDocxBlob(), real: false, unchanged: false };
        }
        throw e;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    //  docx-preview 渲染 + 兼容“html-docx 生成的 MHT/altChunk 文档”回退：
    //  这类文档 docx-preview 渲染不出正文，检测后直接从 MHT 中提取 HTML 显示，
    //  保证“修改 → 保存 → 再次打开”仍然可以正常浏览/继续编辑。
    // ═══════════════════════════════════════════════════════════════
    function docxIsAltChunkFile(arrayBuffer) {
      return JSZip.loadAsync(arrayBuffer).then(function (zip) {
        var hasMht = false;
        zip.forEach(function (path) { if (/\.mht$/i.test(path)) hasMht = true; });
        if (hasMht) return true;
        var doc = zip.file('word/document.xml');
        if (!doc) return false;
        return doc.async('string').then(function (txt) {
          return /altChunk|afchunk/i.test(txt);
        });
      }).catch(function () { return false; });
    }

    function xQpDecode(body) {
      // 先处理软换行，再解码 =XX
      body = body.replace(/=\r?\n/g, '').replace(/=\n/g, '');
      body = body.replace(/=([0-9A-Fa-f]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
      return body;
    }

    function xExtractHtmlFromMht(mht) {
      var boundaryMatch = mht.match(/boundary="?([^";\r\n]+)"?/i);
      if (!boundaryMatch) return null;
      var boundary = boundaryMatch[1];
      var esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var parts = mht.split(new RegExp('\\r?\\n--' + esc + '(?:--)?\\r?\\n'));
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        var sep = part.search(/\r?\n\r?\n/);
        if (sep < 0) continue;
        var head = part.slice(0, sep).toLowerCase();
        var body = part.slice(sep).replace(/^\r?\n?/, '');
        if (head.indexOf('text/html') === -1 && !/content-location:.*\.html/i.test(head)) continue;
        var html = null;
        if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
          var decoded = xQpDecode(body);
          var arr = new Uint8Array(decoded.length);
          for (var i = 0; i < decoded.length; i++) arr[i] = decoded.charCodeAt(i) & 0xff;
          try { html = new TextDecoder('utf-8').decode(arr); } catch (e) { html = decoded; }
        } else if (/content-transfer-encoding:\s*base64/i.test(head)) {
          var bin = atob(body.replace(/\s/g, ''));
          var u8 = new Uint8Array(bin.length);
          for (var j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
          html = new TextDecoder('utf-8').decode(u8);
        } else {
          html = body;
        }
        if (!html) return null;
        // 去掉 MHT 中可能混入的边界残余/前后杂讯，只保留完整 HTML 文档
        var sIdx = html.search(/<html[\s>]/i);
        if (sIdx > 0) html = html.slice(sIdx);
        var eIdx = html.search(/<\/html>/i);
        if (eIdx >= 0) html = html.slice(0, eIdx + 7);
        return html;
      }
      return null;
    }

    function xLoadHtmlAltChunk(arrayBuffer) {
      return JSZip.loadAsync(arrayBuffer).then(function (zip) {
        var mhtPath = null;
        zip.forEach(function (path) { if (!mhtPath && /\.mht$/i.test(path)) mhtPath = path; });
        if (!mhtPath) throw new Error('未找到 MHT 内容');
        return zip.file(mhtPath).async('string');
      }).then(function (mht) {
        var html = xExtractHtmlFromMht(mht);
        if (!html) throw new Error('无法从 MHT 提取 HTML');
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var inner = (doc.body && doc.body.innerHTML) ? doc.body.innerHTML : html;
        docxContainer.innerHTML = inner;
      });
    }

    function renderDocxSmart(arrayBuffer) {
      return new Promise(function (resolve) {
        docxContainer.innerHTML = '';
        statusSpan.textContent = '正在渲染文档...';
        function markDone() {
          statusSpan.textContent = '文档已就绪，可开始编辑';
          docxContainer.setAttribute('contenteditable', 'true');
          docxContainer.focus();
          savedSelection = null;
          updateCharCount();
          updateToolbarState();
          resolve(true);
        }
        function markFail() {
          docxContainer.innerHTML = '<p style="color: red; text-align: center;">错误：无法渲染该文档。请确保是有效的 .docx 文件。</p>';
          statusSpan.textContent = '文档渲染失败';
          resolve(false);
        }
        function tryHtmlFallback() {
          docxIsAltChunkFile(arrayBuffer).then(function (yes) {
            if (yes) {
              xLoadHtmlAltChunk(arrayBuffer).then(markDone).catch(markFail);
            } else {
              markFail();
            }
          }).catch(markFail);
        }
        // 优先用 docx-preview 渲染标准 OOXML；若渲染结果为空或抛错，
        // 再尝试从 MHT/altChunk（html-docx 生成的历史文件）中恢复 HTML。
        docx.renderAsync(arrayBuffer, docxContainer, null, {
          className: 'docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: true,
          trimXmlDeclaration: true,
          useBase64URL: true,
          useMathMLPolyfill: true,
          showChanges: false,
          debug: false
        }).then(function () {
          var text = (docxContainer.innerText || '').replace(/\s/g, '');
          if (text.length === 0) {
            tryHtmlFallback();
          } else {
            markDone();
          }
        }).catch(function (error) {
          console.error('渲染文档时出错：', error);
          tryHtmlFallback();
        });
      });
    }


    async function exportToWord() {
      const text = docxContainer.innerText.trim();

      //if (!text || docxContainer.innerHTML.includes("请上传 DOCX 文件或开始编辑新文档")) {
      //  alert("没有可导出的内容。请先上传文档或输入一些内容。");
      //  return;
      //}

      if (typeof htmlDocx === "undefined") {
        alert("html-docx-js 库加载失败，请检查网络或 CDN 地址。");
        statusSpan.textContent = "导出失败";
        return;
      }

      statusSpan.textContent = "正在生成 Word 文档...";

      try {
        const convertedBlob = buildDocxBlob();

        saveAs(convertedBlob, originalFileName || "document.docx");

        statusSpan.textContent = "文档已导出";
      } catch (error) {
        console.error("导出文档时出错：", error);
        statusSpan.textContent = "导出失败";
        alert("导出文档时出错：" + error.message);
      }
    }

    // ══════════════════════════════════════════════════════════
    //  almostnode 宿主集成（index.html 的 Office 编辑器 iframe）：
    //  - load  : 接收宿主传来的 DOCX 字节并渲染
    //  - export: 把当前编辑内容生成的 DOCX 字节回传给宿主
    // ══════════════════════════════════════════════════════════
    function pgpySend(msg) {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(Object.assign({ source: "pgpy" }, msg), "*");
        }
      } catch (e) {}
    }

    function pgpyToArrayBuffer(buf) {
      if (buf instanceof ArrayBuffer) return buf;
      return new Uint8Array(buf).buffer;
    }

    window.addEventListener("message", function(e) {
      const d = e.data || {};
      if (d.source !== "pgpy") return;

      if (d.type === "load") {
        if (!d.buffer) return;
        const name = d.fileName || "document.docx";
        originalFileName = name.replace(/\.docx$/i, "") + "_编辑版.docx";
        fileNameSpan.textContent = name;
        currentDocumentBuffer = pgpyToArrayBuffer(d.buffer);
        renderDocx(currentDocumentBuffer);
        pgpySend({ type: "loaded", fileName: originalFileName });
      } else if (d.type === "export") {
        const reqId = d.id;
        try {
          if (typeof htmlDocx === "undefined") {
            throw new Error("html-docx-js 库未加载");
          }
          const blob = buildDocxBlob();
          blob.arrayBuffer()
            .then(buf => pgpySend({ type: "export-result", id: reqId, buffer: buf, fileName: originalFileName || "document.docx" }))
            .catch(err => pgpySend({ type: "error", id: reqId, message: String((err && err.message) || err) }));
        } catch (err) {
          pgpySend({ type: "error", id: reqId, message: String((err && err.message) || err) });
        }
      }
    });

    pgpySend({ type: "ready" });

    document.addEventListener("DOMContentLoaded", init);
  


    // API 暴露给宿主 index.html
        window.__docxEditor = {
        load: function(arrayBuffer, fileName) {
            var ab = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : new Uint8Array(arrayBuffer).buffer;
            if (fileName) {
                fileNameSpan.textContent = fileName;
                originalFileName = String(fileName).replace(/\.docx$/i, "") + "_编辑版.docx";
            }
            _docxOrigBuffer = ab;
            _docxSettingsPromise = null;   // 新文件需重新提取原排版设置
            _docxOrigSectPr = '';
            _docxOrigDocDefaults = '';
            return renderDocxSmart(ab).then(function (ok) {
                _docxOrigHtml = ok ? docxContainer.innerHTML : null; // 未编辑快照
                return ok;
            });
        },
        export: function() {
            // 返回 ArrayBuffer（宿主保存/下载逻辑按 ArrayBuffer 处理）
            return exportDocxData().then(function(res){
                return res.blob.arrayBuffer().then(function(ab){
                    return { buffer: ab, fileName: originalFileName || "document.docx", real: !!res.real };
                });
            });
        }
    };
})();
