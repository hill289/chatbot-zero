(function(){

    // 状态管理
    let slides = [
      {
        html: '<h1>幻灯片标题</h1><p>请输入演示文稿正文内容...</p>',
        bgColor: '#ffffff'
      }
    ];
    let currentSlideIndex = 0;
    let originalFileName = "演示文稿.pptx";
    let savedSelection = null;

    // DOM 元素引用
    const fileInput = document.getElementById("pptx_fileInput");
    const imageInput = document.getElementById("pptx_imageInput");
    const fileNameSpan = document.getElementById("pptx_fileName");
    const slideCanvas = document.getElementById("pptx_slide-canvas");
    const selectFileBtn = document.getElementById("pptx_selectFileBtn");
    const exportBtn = document.getElementById("pptx_exportBtn");
    const newDocBtn = document.getElementById("pptx_newDocBtn");
    const charCountSpan = document.getElementById("pptx_charCount");
    const slideIndexStatus = document.getElementById("pptx_slideIndexStatus");
    const statusSpan = document.getElementById("pptx_status");
    const richToolbar = document.getElementById("pptx_richToolbar");
    const formatBlockSelect = document.getElementById("pptx_formatBlockSelect");
    const fontNameSelect = document.getElementById("pptx_fontNameSelect");
    const fontSizeSelect = document.getElementById("pptx_fontSizeSelect");
    const foreColorPicker = document.getElementById("pptx_foreColorPicker");
    const slideBgColorPicker = document.getElementById("pptx_slideBgColorPicker");
    const createLinkBtn = document.getElementById("pptx_createLinkBtn");
    const unlinkBtn = document.getElementById("pptx_unlinkBtn");
    const insertImageBtn = document.getElementById("pptx_insertImageBtn");
    const insertTableBtn = document.getElementById("pptx_insertTableBtn");
    const insertHrBtn = document.getElementById("pptx_insertHrBtn");
    const thumbnailList = document.getElementById("pptx_thumbnailList");
    const addSlideBtn = document.getElementById("pptx_addSlideBtn");
    const deleteSlideBtn = document.getElementById("pptx_deleteSlideBtn");
    const slideCountTag = document.getElementById("pptx_slideCountTag");

    function init() {
      slideCanvas.setAttribute("contenteditable", "true");
      document.execCommand("styleWithCSS", false, true);

      // 事件监听
      slideCanvas.addEventListener("input", onSlideContentChange);
      slideCanvas.addEventListener("keyup", updateToolbarState);
      slideCanvas.addEventListener("mouseup", updateToolbarState);
      slideCanvas.addEventListener("blur", saveSelection);
      slideCanvas.addEventListener("focus", restoreSelection);
      slideCanvas.addEventListener("paste", handlePaste);

      fileInput.addEventListener("change", handleFileSelect);
      imageInput.addEventListener("change", handleImageSelect);
      selectFileBtn.addEventListener("click", () => fileInput.click());
      exportBtn.addEventListener("click", exportToPptx);
      newDocBtn.addEventListener("click", createNewPresentation);

      addSlideBtn.addEventListener("click", addNewSlide);
      deleteSlideBtn.addEventListener("click", deleteCurrentSlide);

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

      slideBgColorPicker.addEventListener("input", () => {
        slides[currentSlideIndex].bgColor = slideBgColorPicker.value;
        slideCanvas.style.backgroundColor = slideBgColorPicker.value;
        renderThumbnails();
      });

      createLinkBtn.addEventListener("click", createLink);
      unlinkBtn.addEventListener("click", () => executeCommand("unlink"));
      insertImageBtn.addEventListener("click", () => imageInput.click());
      insertTableBtn.addEventListener("click", insertTable);
      insertHrBtn.addEventListener("click", () => executeCommand("insertHorizontalRule"));

      renderSlide(0);
      statusSpan.textContent = "就绪";
    }

    // 切换与渲染 Slide
    function renderSlide(index) {
      if (index < 0 || index >= slides.length) return;
      currentSlideIndex = index;
      
      // 加载内容与背景
      slideCanvas.innerHTML = slides[currentSlideIndex].html;
      const bgImg = slides[currentSlideIndex].bgImage;
      const bgGrad = slides[currentSlideIndex].bgGradient;
      if (bgImg) {
        slideCanvas.style.backgroundImage = 'url("' + bgImg + '")';
        slideCanvas.style.backgroundSize = '100% 100%';
        slideCanvas.style.backgroundRepeat = 'no-repeat';
      } else if (bgGrad) {
        slideCanvas.style.backgroundImage = bgGrad;
        slideCanvas.style.backgroundSize = '100% 100%';
        slideCanvas.style.backgroundRepeat = 'no-repeat';
      } else {
        slideCanvas.style.backgroundImage = '';
      }
      slideCanvas.style.backgroundColor = slides[currentSlideIndex].bgColor || '#ffffff';
      slideBgColorPicker.value = slides[currentSlideIndex].bgColor || '#ffffff';

      renderThumbnails();
      updateCharCount();
      updateSlideStatus();
    }

    function onSlideContentChange() {
      slides[currentSlideIndex].html = slideCanvas.innerHTML;
      renderThumbnails();
      updateCharCount();
    }

    function renderThumbnails() {
      thumbnailList.innerHTML = "";
      slideCountTag.textContent = slides.length;

      slides.forEach((slide, idx) => {
        const thumb = document.createElement("div");
        thumb.className = `slide-thumb ${idx === currentSlideIndex ? 'active' : ''}`;
        thumb.style.backgroundColor = slide.bgColor || '#ffffff';
        if (slide.bgImage) {
          thumb.style.backgroundImage = 'url("' + slide.bgImage + '")';
          thumb.style.backgroundSize = '100% 100%';
          thumb.style.backgroundRepeat = 'no-repeat';
        } else if (slide.bgGradient) {
          thumb.style.backgroundImage = slide.bgGradient;
        }

        const num = document.createElement("span");
        num.className = "thumb-number";
        num.textContent = idx + 1;

        // 简易缩略图预览文本
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = slide.html;
        const textContent = tempDiv.innerText || "";
        const previewText = document.createElement("div");
        previewText.style.fontSize = "9px";
        previewText.style.color = "#666";
        previewText.style.overflow = "hidden";
        previewText.style.height = "100%";
        previewText.textContent = textContent.substring(0, 40) + "...";

        thumb.appendChild(num);
        thumb.appendChild(previewText);

        thumb.addEventListener("click", () => {
          slides[currentSlideIndex].html = slideCanvas.innerHTML;
          renderSlide(idx);
        });

        thumbnailList.appendChild(thumb);
      });
    }

    function addNewSlide() {
      slides[currentSlideIndex].html = slideCanvas.innerHTML;
      slides.push({
        html: '<h2>新幻灯片</h2><p>点击此处编辑内容...</p>',
        bgColor: '#ffffff'
      });
      renderSlide(slides.length - 1);
      statusSpan.textContent = "已新增幻灯片";
    }

    function deleteCurrentSlide() {
      if (slides.length <= 1) {
        alert("至少需要保留一张幻灯片。");
        return;
      }
      if (confirm(`确定要删除第 ${currentSlideIndex + 1} 页幻灯片吗？`)) {
        slides.splice(currentSlideIndex, 1);
        const nextIdx = Math.min(currentSlideIndex, slides.length - 1);
        renderSlide(nextIdx);
        statusSpan.textContent = "已删除幻灯片";
      }
    }

    function updateSlideStatus() {
      slideIndexStatus.textContent = `页码: ${currentSlideIndex + 1} / ${slides.length}`;
    }

    function focusEditor() {
      slideCanvas.focus();
      restoreSelection();
    }

    function saveSelection() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      if (slideCanvas.contains(range.commonAncestorContainer)) {
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
      onSlideContentChange();
      updateToolbarState();
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
      saveSelection();
      onSlideContentChange();
      statusSpan.textContent = "已插入链接";
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
        onSlideContentChange();
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
          html += "<td>文本</td>";
        }
        html += "</tr>";
      }
      html += "</tbody></table><p><br></p>";

      document.execCommand("insertHTML", false, html);
      saveSelection();
      onSlideContentChange();
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

      onSlideContentChange();
      statusSpan.textContent = "已粘贴内容";
    }

    function sanitizePastedHtml(html) {
      const temp = document.createElement("div");
      temp.innerHTML = html;
      temp.querySelectorAll("script, style, iframe, object, embed").forEach((el) => el.remove());
      return temp.innerHTML;
    }

    // 解析 PPTX 字节：优先用 pptx-import-core.js 还原「原始版式 + 文字格式」，
    // 核心脚本不可用时退回“只取文字”的解析。
    async function parsePptxBuffer(arrayBuffer) {
      try {
        let parsedSlides;

        if (window.PPTXImporter && typeof window.PPTXImporter.parsePptxToSlides === "function") {
          // 保留原始版式：位置/大小、字体/字号/颜色/加粗斜体、背景色、图片、表格等
          parsedSlides = await window.PPTXImporter.parsePptxToSlides(arrayBuffer, {
            JSZip: JSZip,
            DOMParser: DOMParser
          });
        } else {
          // 兜底：核心脚本未加载时退回“只取文字”的解析
          parsedSlides = await parsePptxTextOnly(arrayBuffer);
        }

        if (!parsedSlides || parsedSlides.length === 0) {
          alert("无法在 PPTX 中找到幻灯片页面。");
          statusSpan.textContent = "解析失败";
          return;
        }

        slides = parsedSlides;
        renderSlide(0);
        statusSpan.textContent = `成功导入 ${parsedSlides.length} 页幻灯片（已保留原始版式与格式）`;

      } catch (err) {
        console.error("解析 PPTX 异常:", err);
        alert("解析 PPTX 失败，格式可能不合规或受密码保护。");
        statusSpan.textContent = "导入失败";
      }
    }

    // 兜底解析：只提取文字（核心脚本不可用或解析异常时使用）
    async function parsePptxTextOnly(arrayBuffer) {
      const zip = await JSZip.loadAsync(arrayBuffer);
      const slideFiles = [];

      zip.forEach((relativePath) => {
        if (/^ppt\/slides\/slide\d+\.xml$/.test(relativePath)) {
          slideFiles.push(relativePath);
        }
      });

      slideFiles.sort((a, b) => {
        const numA = parseInt((a.match(/slide(\d+)\.xml/) || [])[1] || 0, 10);
        const numB = parseInt((b.match(/slide(\d+)\.xml/) || [])[1] || 0, 10);
        return numA - numB;
      });

      const parser = new DOMParser();
      const parsedSlides = [];
      for (const slidePath of slideFiles) {
        const xmlText = await zip.file(slidePath).async("string");
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const pElements = xmlDoc.getElementsByTagName("a:p");
        let slideHtml = "";
        for (let i = 0; i < pElements.length; i++) {
          const tElements = pElements[i].getElementsByTagName("a:t");
          let lineText = "";
          for (let j = 0; j < tElements.length; j++) lineText += tElements[j].textContent;
          if (lineText.trim().length > 0) {
            slideHtml += i === 0
              ? `<h1>${escapeHtml(lineText)}</h1>`
              : `<p>${escapeHtml(lineText)}</p>`;
          }
        }
        if (!slideHtml) slideHtml = "<h2>幻灯片</h2><p>（空幻灯片或未解析出文本）</p>";
        parsedSlides.push({ html: slideHtml, bgColor: "#ffffff" });
      }
      return parsedSlides;
    }
    // 解析导入 PPTX 文件
    async function handleFileSelect(event) {
      const file = event.target.files[0];
      if (!file) return;

      if (!file.name.toLowerCase().endsWith(".pptx")) {
        alert("请选择有效的 .pptx 文件");
        return;
      }

      originalFileName = file.name.replace(/\.pptx$/i, "") + "_编辑版.pptx";
      fileNameSpan.textContent = file.name;
      statusSpan.textContent = "正在解压与解析 PPTX 文件...";

      try {
        await parsePptxBuffer(await file.arrayBuffer());
      } catch (err) {
        console.error("读取 PPTX 文件失败:", err);
        statusSpan.textContent = "导入失败";
      }
    }


    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function updateCharCount() {
      let totalChar = 0;
      slides.forEach(s => {
        const temp = document.createElement("div");
        temp.innerHTML = s.html;
        totalChar += (temp.innerText || "").replace(/\s/g, "").length;
      });
      charCountSpan.textContent = "全案字符数: " + totalChar;
    }

    function createNewPresentation() {
      const confirmed = confirm("确定要新建演示文稿吗？当前未保存的更改将丢失。");
      if (!confirmed) return;

      slides = [
        {
          html: '<h1>新演示文稿标题</h1><p>在此输入第一页内容...</p>',
          bgColor: '#ffffff'
        }
      ];
      fileNameSpan.textContent = "";
      originalFileName = "演示文稿.pptx";
      renderSlide(0);
      statusSpan.textContent = "已新建演示文稿";
    }

    // PptxGenJS 由 almostnode 运行时内置提供（不再依赖 pptxgen.bundle.js）：
    // 等待引导脚本把库注入 window（幂等）。
    async function ensurePptxLib() {
      if (typeof PptxGenJS === "undefined" && window.__waitOfficeLibs) {
        try { await window.__waitOfficeLibs(30000); } catch (_) {}
      }
    }

    // 由当前 slides 构建 PptxGenJS 对象（导出下载 / 宿主页面保存到沙箱共用）
    function buildPptxObject() {
      slides[currentSlideIndex].html = slideCanvas.innerHTML;

      if (typeof PptxGenJS === "undefined") {
        throw new Error("PptxGenJS 库未加载：almostnode 运行时未提供 pptxgenjs。");
      }

      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_16x9';

      slides.forEach((slideData, index) => {
        const slide = pptx.addSlide();
        
        // 设置背景（图片优先，其次纯色；去除 # 号）
        if (slideData.bgColor) {
          if (slideData.bgImage) {
            slide.background = { data: slideData.bgImage };
          } else {
            slide.background = { color: slideData.bgColor.replace('#', '') };
          }
        }

        // 解析 HTML 结构转为 PPTX 元素
        const tempContainer = document.createElement("div");
        tempContainer.innerHTML = slideData.html;

        let currentY = 0.8; // 垂直起始位置 (Inches)

        Array.from(tempContainer.children).forEach((node) => {
          const tagName = node.tagName ? node.tagName.toUpperCase() : "";
          const text = node.innerText || node.textContent || "";

          // —— 导入版式产生的绝对定位节点：按原始位置导出 ——
          if (node.classList && node.classList.contains("pptx-shape")) {
            exportShapeNode(slide, node);
            return;
          }
          if (node.classList && node.classList.contains("pptx-pic")) {
            exportPictureNode(slide, node);
            return;
          }
          if (node.classList && node.classList.contains("pptx-table")) {
            exportTableNode(slide, node);
            return;
          }

          if (!text.trim() && tagName !== "TABLE" && tagName !== "IMG") return;

          if (tagName === "H1") {
            slide.addText(text, {
              x: 0.8,
              y: currentY,
              w: '80%',
              fontSize: 28,
              bold: true,
              color: '1A252C',
              align: 'left'
            });
            currentY += 1.0;
          } else if (tagName === "H2") {
            slide.addText(text, {
              x: 0.8,
              y: currentY,
              w: '80%',
              fontSize: 22,
              bold: true,
              color: '2C3E50',
              align: 'left'
            });
            currentY += 0.8;
          } else if (tagName === "H3" || tagName === "H4") {
            slide.addText(text, {
              x: 0.8,
              y: currentY,
              w: '80%',
              fontSize: 18,
              bold: true,
              color: '34495E',
              align: 'left'
            });
            currentY += 0.6;
          } else if (tagName === "P" || tagName === "BLOCKQUOTE") {
            slide.addText(text, {
              x: 0.8,
              y: currentY,
              w: '80%',
              fontSize: 14,
              color: '333333',
              align: 'left'
            });
            currentY += 0.5;
          } else if (tagName === "UL" || tagName === "OL") {
            const listItems = Array.from(node.querySelectorAll("li")).map(li => ({
              text: li.innerText,
              options: { bullet: true, fontSize: 14, color: '333333' }
            }));
            if (listItems.length > 0) {
              slide.addText(listItems, {
                x: 0.8,
                y: currentY,
                w: '80%'
              });
              currentY += 0.4 * listItems.length + 0.2;
            }
          } else if (tagName === "TABLE") {
            const rows = [];
            node.querySelectorAll("tr").forEach(tr => {
              const rowCells = [];
              tr.querySelectorAll("td, th").forEach(td => {
                rowCells.push({ text: td.innerText || "" });
              });
              if (rowCells.length > 0) rows.push(rowCells);
            });
            if (rows.length > 0) {
              slide.addTable(rows, {
                x: 0.8,
                y: currentY,
                w: 8.0,
                colW: Array(rows[0].length).fill(8.0 / rows[0].length),
                border: { pt: '1', color: '888888' },
                fill: 'F8F9FA',
                fontSize: 12
              });
              currentY += 0.4 * rows.length + 0.3;
            }
          } else if (tagName === "IMG") {
            const imgSrc = node.getAttribute("src");
            if (imgSrc && imgSrc.startsWith("data:image")) {
              slide.addImage({
                data: imgSrc,
                x: 0.8,
                y: currentY,
                w: 3.5,
                h: 2.5
              });
              currentY += 2.7;
            }
          }
        });
      });

      return pptx;
    }

    // ===== 导出辅助：把导入时生成的“绝对定位”节点还原为 PPTX 元素 =====
    const EXPORT_CANVAS_W = 896;   // 幻灯片画布宽度(px)
    const EXPORT_SLIDE_W_IN = 10;  // PptxGenJS LAYOUT_16x9 宽度(英寸)

    function pxToInch(px) {
      const n = parseFloat(px);
      return isNaN(n) ? 0 : n / (EXPORT_CANVAS_W / EXPORT_SLIDE_W_IN);
    }

    function pxToPt(px) {
      const n = parseFloat(px);
      return isNaN(n) ? 0 : n * (EXPORT_SLIDE_W_IN * 72) / EXPORT_CANVAS_W;
    }

    function cssColorToHex(color) {
      if (!color) return null;
      color = String(color).trim();
      if (color.charAt(0) === "#") {
        let hex = color.slice(1);
        if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
        return hex.slice(0, 6).toUpperCase();
      }
      const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (m) {
        return [m[1], m[2], m[3]]
          .map((n) => parseInt(n, 10).toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase();
      }
      return null;
    }

    function elementGeometry(el) {
      return {
        x: pxToInch(el.style.left),
        y: pxToInch(el.style.top),
        w: pxToInch(el.style.width) || 4,
        h: pxToInch(el.style.height) || 1
      };
    }

    function runOptionsFromSpan(span) {
      const style = span.style || {};
      const opts = {};
      if (style.fontSize) {
        const pt = pxToPt(style.fontSize);
        if (pt > 0) opts.fontSize = Math.round(pt * 10) / 10;
      }
      const fw = style.fontWeight;
      if (fw === "bold" || fw === "700" || parseInt(fw, 10) >= 600) opts.bold = true;
      if (style.fontStyle === "italic") opts.italic = true;
      const deco = style.textDecorationLine || style.textDecoration || "";
      if (deco.indexOf("underline") !== -1) opts.underline = true;
      if (deco.indexOf("line-through") !== -1) opts.strike = true;
      if (style.color) {
        const c = cssColorToHex(style.color);
        if (c) opts.color = c;
      }
      if (style.fontFamily) opts.fontFace = style.fontFamily.replace(/['"]/g, "").split(",")[0].trim();
      if (style.backgroundColor && style.backgroundColor !== "transparent") {
        const h = cssColorToHex(style.backgroundColor);
        if (h) opts.highlight = h;
      }
      return opts;
    }

    function exportShapeNode(slide, node) {
      const geo = elementGeometry(node);
      const paragraphs = Array.from(node.children).filter((c) => c.tagName === "P");
      const runs = [];

      paragraphs.forEach((p) => {
        const pOpts = {};
        const align = p.style.textAlign;
        if (align) pOpts.align = align === "start" ? "left" : align === "end" ? "right" : align;
        const isBullet = !!p.querySelector(".pptx-bullet");
        let firstOfPara = true;

        Array.from(p.childNodes).forEach((childNode) => {
          if (childNode.nodeType === 3) {
            const t = childNode.textContent;
            if (!t) return;
            const o = Object.assign({}, pOpts);
            if (isBullet && firstOfPara) o.bullet = true;
            firstOfPara = false;
            runs.push({ text: t, options: o });
          } else if (childNode.nodeType === 1) {
            if (childNode.classList && childNode.classList.contains("pptx-bullet")) return;
            if (childNode.tagName === "BR") {
              runs.push({ text: "", options: { breakLine: true } });
              return;
            }
            const o = Object.assign({}, pOpts, runOptionsFromSpan(childNode));
            if (isBullet && firstOfPara) o.bullet = true;
            firstOfPara = false;
            runs.push({ text: childNode.textContent, options: o });
          }
        });

        if (runs.length) {
          const last = runs[runs.length - 1];
          last.options = Object.assign({}, last.options, { breakLine: true });
        }
      });

      if (!runs.length) return;
      runs[runs.length - 1].options.breakLine = false;

      const jc = node.style.justifyContent;
      const valign = jc === "center" ? "middle" : jc === "flex-end" ? "bottom" : "top";
      slide.addText(runs, Object.assign({ valign: valign }, geo));
    }

    function exportPictureNode(slide, node) {
      const src = node.getAttribute("src");
      if (!src || src.indexOf("data:image") !== 0) return;
      slide.addImage(Object.assign({ data: src }, elementGeometry(node)));
    }

    function exportTableNode(slide, node) {
      const geo = elementGeometry(node);
      const rows = [];
      node.querySelectorAll("tr").forEach((tr) => {
        const rowCells = [];
        tr.querySelectorAll("td, th").forEach((td) => {
          const cellOpts = {};
          const h = cssColorToHex(td.style.backgroundColor);
          if (h) cellOpts.fill = h;
          rowCells.push({ text: td.textContent || "", options: cellOpts });
        });
        if (rowCells.length) rows.push(rowCells);
      });
      if (!rows.length) return;
      slide.addTable(rows, {
        x: geo.x,
        y: geo.y,
        w: geo.w,
        h: geo.h,
        colW: Array(rows[0].length).fill(geo.w / rows[0].length),
        border: { pt: 1, color: "888888" },
        fontSize: 12,
        valign: "middle"
      });
    }

    // 导出 PPTX
    async function exportToPptx() {
      statusSpan.textContent = "正在生成 PPTX 演示文稿...";

      try {
        await ensurePptxLib();

        const pptx = buildPptxObject();
        await pptx.writeFile({ fileName: originalFileName || "演示文稿.pptx" });
        statusSpan.textContent = "PPTX 演示文稿导出成功";

      } catch (err) {
        console.error("导出 PPTX 失败:", err);
        alert("导出 PPTX 时发生错误：" + err.message);
        statusSpan.textContent = "导出失败";
      }
    }

    // ══════════════════════════════════════════════════════════
    //  almostnode 宿主集成（index.html 的 Office 编辑器 iframe）：
    //  - load  : 接收宿主传来的 PPTX 字节并解析为幻灯片
    //  - export: 把当前演示文稿生成的 PPTX 字节回传给宿主
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

    window.addEventListener("message", async function(e) {
      const d = e.data || {};
      if (d.source !== "pgpy") return;

      if (d.type === "load") {
        if (!d.buffer) return;
        const name = d.fileName || "演示文稿.pptx";
        originalFileName = name.replace(/\.pptx$/i, "") + "_编辑版.pptx";
        fileNameSpan.textContent = name;
        statusSpan.textContent = "正在解压与解析 PPTX 文件...";
        try {
          await parsePptxBuffer(pgpyToArrayBuffer(d.buffer));
          pgpySend({ type: "loaded", fileName: originalFileName });
        } catch (err) {
          pgpySend({ type: "error", message: String((err && err.message) || err) });
        }
      } else if (d.type === "export") {
        const reqId = d.id;
        try {
          await ensurePptxLib();

          const pptx = buildPptxObject();
          // PptxGenJS 支持 write('blob') 返回 Blob
          const blob = await pptx.write('blob');
          blob.arrayBuffer()
            .then(buf => pgpySend({ type: "export-result", id: reqId, buffer: buf, fileName: originalFileName || "演示文稿.pptx" }))
            .catch(err => pgpySend({ type: "error", id: reqId, message: String((err && err.message) || err) }));
        } catch (err) {
          console.error("导出 PPTX 失败:", err);
          pgpySend({ type: "error", id: reqId, message: String((err && err.message) || err) });
        }
      }
    });

    pgpySend({ type: "ready" });

    document.addEventListener("DOMContentLoaded", init);
  


    // API 暴露给宿主 index.html
    window.__pptxEditor = {
        load: function(arrayBuffer, fileName) {
            var ab = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : new Uint8Array(arrayBuffer).buffer;
            if (fileName) {
                fileNameSpan.textContent = fileName;
                originalFileName = String(fileName).replace(/\.pptx$/i, "") + "_编辑版.pptx";
            }
            return parsePptxBuffer(ab);
        },
        export: function() {
            return ensurePptxLib().then(function () {
                var pptx = buildPptxObject();
                return pptx.write('blob').then(function(blob){
                    return blob.arrayBuffer().then(function(buf){
                        return { buffer: buf, fileName: originalFileName || "演示文稿.pptx" };
                    });
                });
            });
        }
    };

})();
