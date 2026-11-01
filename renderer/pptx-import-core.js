/*
 * pptx-import-core.js
 * PPTX 导入解析核心：把 .pptx 解析成尽可能还原「原始版式 + 文字格式」的 HTML。
 *
 * 关键能力（相比只抽取 <a:t> 纯文本的旧实现）：
 *   - 幻灯片尺寸与形状几何（a:xfrm 的 off/ext，EMU -> px；支持组合变换）
 *   - 按 PowerPoint 的合成模型渲染：母版(master) -> 版式(layout) -> 幻灯片(slide)
 *       * 版式/母版上的装饰图形、图片、连接线也会被绘制
 *       * 占位符没有自己的 xfrm 时，从版式/母版继承位置与大小
 *       * 文字默认样式从母版 txStyles(titleStyle/bodyStyle/otherStyle)、
 *         各级占位符 lstStyle 逐级继承
 *   - 文字：字号(sz)、字体(latin/ea/cs/主题字体)、加粗/斜体/下划线/删除线、
 *           颜色(srgbClr/schemeClr/sysClr/prstClr 及 alpha/tint/shade/lum 修饰)、
 *           高亮、对齐、缩进(悬挂缩进)、行距、段前段后、项目符号
 *   - 形状填充(纯色/渐变/noFill/样式引用)与边框、文本框内边距与垂直对齐
 *   - 图片 ppt/media/*（含 a:srcRect 裁剪）转 dataURL；表格 a:tbl
 *   - 背景：纯色 / 图片(blipFill) / 渐变(gradFill)，优先级 slide > layout > master
 *
 * 用法（浏览器）：
 *   const slides = await PPTXImporter.parsePptxToSlides(file, { JSZip, DOMParser });
 * 用法（Node 测试）：
 *   const { parsePptxToSlides } = require('./pptx-import-core.js');
 *
 * 返回：[{ html, bgColor, bgImage, bgGradient }, ...]
 */
(function (global) {
  "use strict";

  var R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  var CANVAS_W = 896;   // 编辑器 .slide-canvas 默认像素尺寸（16:9）
  var CANVAS_H = 504;
  var EMU_PER_PT = 12700; // 1pt = 12700 EMU

  // ------------------------------------------------------------------ 小工具
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  function children(parent, tag) {
    var out = [];
    if (!parent) return out;
    for (var n = parent.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && (!tag || n.tagName === tag)) out.push(n);
    }
    return out;
  }
  function child(parent, tag) {
    if (!parent) return null;
    for (var n = parent.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && n.tagName === tag) return n;
    }
    return null;
  }
  function firstDesc(parent, tag) {
    if (!parent || !parent.getElementsByTagName) return null;
    var list = parent.getElementsByTagName(tag);
    return list && list.length ? list[0] : null;
  }
  function attr(el, name) {
    if (!el || !el.getAttribute) return null;
    var v = el.getAttribute(name);
    if (v != null) return v;
    if (name.indexOf(":") > 0) {
      try { return el.getAttributeNS(R_NS, name.split(":")[1]); } catch (e) { return null; }
    }
    return null;
  }
  function resolvePath(baseDir, target) {
    if (!target) return "";
    if (target.charAt(0) === "/") return target.replace(/^\//, "");
    var parts = (baseDir + "/" + target).split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === "" || p === ".") continue;
      if (p === "..") out.pop(); else out.push(p);
    }
    return out.join("/");
  }
  function baseName(path) { var s = path.split("/"); return s[s.length - 1]; }

  // ------------------------------------------------------------------ 颜色
  var PRESET_COLORS = {
    black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF",
    yellow: "FFFF00", cyan: "00FFFF", magenta: "FF00FF", gray: "808080", grey: "808080",
    orange: "FFA500", purple: "800080", brown: "A52A2A", pink: "FFC0CB", lime: "00FF00",
    navy: "000080", teal: "008080", silver: "C0C0C0", maroon: "800000", olive: "808000",
    gold: "FFD700", darkblue: "00008B", darkred: "8B0000", darkgreen: "006400",
    lightgray: "D3D3D3", lightgrey: "D3D3D3", lightblue: "ADD8E6"
  };
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function hexToRgb(hex) {
    hex = hex.replace("#", "");
    if (hex.length === 3) hex = hex.replace(/./g, function (c) { return c + c; });
    return { r: parseInt(hex.slice(0, 2), 16) || 0, g: parseInt(hex.slice(2, 4), 16) || 0, b: parseInt(hex.slice(4, 6), 16) || 0 };
  }
  function toHex(r, g, b) {
    return "#" + [r, g, b].map(function (n) { return clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0"); }).join("").toUpperCase();
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h, s: s, l: l };
  }
  function hslToRgb(h, s, l) {
    function hue(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else { var q = l < 0.5 ? l * (1 + s) : l + s - l * s; var p = 2 * l - q; r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3); }
    return { r: r * 255, g: g * 255, b: b * 255 };
  }
  // 处理 a:alpha / a:tint / a:shade / a:lumMod / a:lumOff
  function applyColorMods(hex, colorEl) {
    var c = hexToRgb(hex), a = 1;
    var kids = colorEl.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType !== 1) continue;
      var v = num(n.getAttribute("val")) / 100000;
      if (n.tagName === "a:alpha") a *= v;
      else if (n.tagName === "a:tint") { c.r += (255 - c.r) * v; c.g += (255 - c.g) * v; c.b += (255 - c.b) * v; }
      else if (n.tagName === "a:shade") { c.r *= (1 - v); c.g *= (1 - v); c.b *= (1 - v); }
      else if (n.tagName === "a:lumMod") { var h1 = rgbToHsl(c.r, c.g, c.b); h1.l *= v; var x1 = hslToRgb(h1.h, h1.s, clamp(h1.l, 0, 1)); c = x1; }
      else if (n.tagName === "a:lumOff") { var h2 = rgbToHsl(c.r, c.g, c.b); h2.l = clamp(h2.l + v, 0, 1); var x2 = hslToRgb(h2.h, h2.s, h2.l); c = x2; }
    }
    if (a >= 0.999) return toHex(c.r, c.g, c.b);
    return "rgba(" + clamp(Math.round(c.r), 0, 255) + "," + clamp(Math.round(c.g), 0, 255) + "," + clamp(Math.round(c.b), 0, 255) + "," + a.toFixed(3) + ")";
  }
  function schemeColor(name, ctx) {
    if (!name) return null;
    var slot = (ctx.clrMap && ctx.clrMap[name]) || name;
    if (ctx.themeColors && ctx.themeColors[slot]) return ctx.themeColors[slot];
    var alias = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };
    var k2 = alias[name] || name;
    return (ctx.themeColors && ctx.themeColors[k2]) || null;
  }
  function cssColorFromEl(el, ctx) {
    var hex = null, tag = el.tagName;
    if (tag === "a:srgbClr") hex = "#" + (el.getAttribute("val") || "000000");
    else if (tag === "a:schemeClr") hex = schemeColor(el.getAttribute("val"), ctx);
    else if (tag === "a:sysClr") hex = "#" + (el.getAttribute("lastClr") || "000000");
    else if (tag === "a:prstClr") hex = "#" + (PRESET_COLORS[(el.getAttribute("val") || "").toLowerCase()] || "000000");
    if (!hex) return null;
    return applyColorMods(hex, el);
  }
  // 在容器里找第一个颜色（solidFill/highlight/ln/fillRef 等）
  function findColor(container, ctx) {
    if (!container) return null;
    var tags = ["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr"];
    for (var i = 0; i < tags.length; i++) {
      var e = container.getElementsByTagName(tags[i])[0];
      if (e) return cssColorFromEl(e, ctx);
    }
    return null;
  }
  function gradientCss(gf, ctx) {
    var stops = [];
    var gs = children(child(gf, "a:gsLst"), "a:gs");
    gs.forEach(function (g) {
      var pos = num(g.getAttribute("pos")) / 1000;
      var c = findColor(g, ctx);
      if (c) stops.push(c + " " + pos.toFixed(1) + "%");
    });
    if (stops.length < 2) return null;
    var lin = child(gf, "a:lin");
    var ang = lin ? num(lin.getAttribute("ang")) / 60000 : 0;
    return "linear-gradient(" + ((ang + 90) % 360) + "deg, " + stops.join(", ") + ")";
  }

  function resolveTypeface(tf, ctx) {
    if (!tf) return null;
    if (tf.charAt(0) !== "+") return tf.replace(/"/g, "");
    var m = { "+mj-lt": "majorLatin", "+mj-ea": "majorEa", "+mj-cs": "majorCs", "+mn-lt": "minorLatin", "+mn-ea": "minorEa", "+mn-cs": "minorCs" };
    return (ctx.themeFonts && ctx.themeFonts[m[tf.toLowerCase()]]) || null;
  }

  // ------------------------------------------------------------------ 几何
  function rectFromXfrm(xfrm) {
    if (!xfrm) return null;
    var off = child(xfrm, "a:off"), ext = child(xfrm, "a:ext");
    if (!off || !ext) return null;
    return { x: num(off.getAttribute("x")), y: num(off.getAttribute("y")), cx: num(ext.getAttribute("cx")), cy: num(ext.getAttribute("cy")) };
  }
  function applyTransform(rect, t) {
    if (!rect || !t) return rect;
    return { x: t.ox + (rect.x - t.chx) * t.sx, y: t.oy + (rect.y - t.chy) * t.sy, cx: rect.cx * t.sx, cy: rect.cy * t.sy };
  }
  function rectToCss(rect, ctx) {
    return { x: ctx.offX + rect.x * ctx.scale, y: ctx.offY + rect.y * ctx.scale, w: rect.cx * ctx.scale, h: rect.cy * ctx.scale };
  }

  // ------------------------------------------------------------------ 文字样式继承
  function mergeProps(target, src) {
    if (!src) return target;
    for (var k in src) { if (src[k] !== undefined) target[k] = src[k]; }
    return target;
  }
  function pPrProps(pPr, ctx) {
    var o = {};
    if (!pPr) return o;
    var algn = pPr.getAttribute("algn");
    if (algn) o.algn = algn;
    if (pPr.getAttribute("marL") != null) o.marL = num(pPr.getAttribute("marL"));
    if (pPr.getAttribute("indent") != null) o.indent = num(pPr.getAttribute("indent"));
    if (pPr.getAttribute("lvl")) o.lvl = num(pPr.getAttribute("lvl"));
    if (child(pPr, "a:buNone")) o.bullet = false;
    else { var buChar = child(pPr, "a:buChar"); var buAuto = child(pPr, "a:buAutoNum");
      if (buChar) o.bullet = buChar.getAttribute("char") || "•";
      else if (buAuto) o.bullet = "•"; }
    var lnSpc = child(pPr, "a:lnSpc");
    if (lnSpc) {
      var pct = child(lnSpc, "a:spcPct"), pts = child(lnSpc, "a:spcPts");
      if (pct) o.lnSpc = num(pct.getAttribute("val")) / 100000;
      else if (pts) o.lnSpcPt = num(pts.getAttribute("val")) / 100;
    }
    var spcBef = child(child(pPr, "a:spcBef"), "a:spcPts"); if (spcBef) o.spcBef = num(spcBef.getAttribute("val")) / 100;
    var spcAft = child(child(pPr, "a:spcAft"), "a:spcPts"); if (spcAft) o.spcAft = num(spcAft.getAttribute("val")) / 100;
    return o;
  }
  function rPrProps(rPr, ctx) {
    var o = {};
    if (!rPr) return o;
    if (rPr.getAttribute("sz")) o.sz = num(rPr.getAttribute("sz")) / 100;
    var b = rPr.getAttribute("b"); if (b === "1") o.b = true; else if (b === "0") o.b = false;
    var i = rPr.getAttribute("i"); if (i === "1") o.i = true; else if (i === "0") o.i = false;
    var u = rPr.getAttribute("u"); if (u && u !== "none") o.u = true; else if (u === "none") o.u = false;
    var st = rPr.getAttribute("strike"); if (st && st !== "noStrike" && st !== "none") o.strike = true;
    var ea = child(rPr, "a:ea"), latin = child(rPr, "a:latin"), cs = child(rPr, "a:cs");
    var face = resolveTypeface(ea && ea.getAttribute("typeface"), ctx) || resolveTypeface(latin && latin.getAttribute("typeface"), ctx) || resolveTypeface(cs && cs.getAttribute("typeface"), ctx);
    if (face) o.font = face;
    var fill = child(rPr, "a:solidFill"); if (fill) { var c = findColor(fill, ctx); if (c) o.color = c; }
    var hl = child(rPr, "a:highlight"); if (hl) { var h = findColor(hl, ctx); if (h) o.highlight = h; }
    return o;
  }
  function parseLvlMap(container, ctx) {
    var map = {};
    if (!container) return map;
    children(container).forEach(function (lvlPr) {
      var m = /lvl(\d+)pPr/.exec(lvlPr.tagName);
      if (!m) return;
      var lvl = parseInt(m[1], 10) - 1;
      var props = {};
      mergeProps(props, pPrProps(lvlPr, ctx));
      mergeProps(props, rPrProps(child(lvlPr, "a:defRPr"), ctx));
      map[lvl] = props;
    });
    return map;
  }
  function mergeLevel(sources, lvl) {
    var out = {};
    sources.forEach(function (map) {
      if (!map) return;
      var p = map[lvl];
      if (!p) { for (var k = lvl - 1; k >= 0; k--) { if (map[k]) { p = map[k]; break; } } }
      if (p) mergeProps(out, p);
    });
    return out;
  }

  // <a:normAutofit fontScale=".." lnSpcReduction=".."/>：PowerPoint 自动缩放文字
  function autofitFactor(txBody) {
    var bodyPr = txBody ? child(txBody, "a:bodyPr") : null;
    var na = bodyPr ? child(bodyPr, "a:normAutofit") : null;
    var fs = 1, ls = 1;
    if (na) {
      var f = na.getAttribute("fontScale");
      if (f) { var v = num(f) / 100000; if (v > 0) fs = v; }
      var r = na.getAttribute("lnSpcReduction");
      if (r) ls = 1 - num(r) / 100000;
    }
    return { fs: fs, ls: ls };
  }
  function runStyleCss(props, ctx, fscale) {
    var css = [];
    fscale = fscale || 1;
    if (props.sz) css.push("font-size:" + (props.sz * fscale * ctx.ptToPx).toFixed(2) + "px");
    if (props.font) css.push("font-family:'" + String(props.font).replace(/'/g, "") + "','Microsoft YaHei','微软雅黑','PingFang SC','Hiragino Sans GB',sans-serif");
    if (props.b === true) css.push("font-weight:700");
    if (props.i === true) css.push("font-style:italic");
    if (props.u === true && props.strike === true) css.push("text-decoration:underline line-through");
    else if (props.u === true) css.push("text-decoration:underline");
    else if (props.strike === true) css.push("text-decoration:line-through");
    if (props.color) css.push("color:" + props.color);
    if (props.highlight) css.push("background-color:" + props.highlight);
    return css.join(";");
  }
  function paraStyleCss(props, ctx, lnScale) {
    var css = [];
    lnScale = lnScale || 1;
    if (props.algn === "ctr") css.push("text-align:center");
    else if (props.algn === "r") css.push("text-align:right");
    else if (props.algn === "just" || props.algn === "dist") css.push("text-align:justify");
    if (props.marL != null) css.push("margin-left:" + (props.marL * ctx.scale).toFixed(2) + "px");
    if (props.indent != null) css.push("text-indent:" + (props.indent * ctx.scale).toFixed(2) + "px");
    if (props.lnSpc) css.push("line-height:" + (props.lnSpc * lnScale).toFixed(3));
    else if (props.lnSpcPt) css.push("line-height:" + (props.lnSpcPt * lnScale * ctx.ptToPx).toFixed(2) + "px");
    if (props.spcBef) css.push("margin-top:" + (props.spcBef * ctx.ptToPx).toFixed(2) + "px");
    if (props.spcAft) css.push("margin-bottom:" + (props.spcAft * ctx.ptToPx).toFixed(2) + "px");
    return css.join(";");
  }

  function renderTextBody(txBody, ctx, sources) {
    var paras = children(txBody, "a:p");
    if (!paras.length) return "";
    var af = autofitFactor(txBody);
    var html = "";
    paras.forEach(function (p) {
      var pPr = child(p, "a:pPr");
      var lvl = pPr && pPr.getAttribute("lvl") ? num(pPr.getAttribute("lvl")) : 0;
      var base = mergeLevel(sources, lvl);
      var para = {};
      mergeProps(para, base);
      mergeProps(para, pPrProps(pPr, ctx));
      mergeProps(para, rPrProps(child(pPr, "a:defRPr"), ctx));

      var inner = "";
      for (var n = p.firstChild; n; n = n.nextSibling) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "a:r") {
          var t = child(n, "a:t");
          var text = t ? t.textContent : "";
          var rp = {}; mergeProps(rp, base); mergeProps(rp, rPrProps(child(n, "a:rPr"), ctx));
          var style = runStyleCss(rp, ctx, af.fs);
          inner += style ? '<span style="' + style + '">' + esc(text) + "</span>" : esc(text);
        } else if (n.tagName === "a:br") {
          inner += "<br>";
        } else if (n.tagName === "a:fld") {
          var ft = child(n, "a:t");
          if (ft) inner += esc(ft.textContent);
        }
      }

      if (typeof para.bullet === "string" && para.bullet) {
        inner = '<span class="pptx-bullet">' + esc(para.bullet) + " </span>" + inner;
      }
      if (inner === "") inner = "<br>";
      var ps = paraStyleCss(para, ctx, af.ls);
      html += ps ? '<p style="' + ps + '">' + inner + "</p>" : "<p>" + inner + "</p>";
    });
    return html;
  }

  // ------------------------------------------------------------------ 形状
  function shapeFillCss(sp, spPr, ctx) {
    if (spPr) {
      var sf = child(spPr, "a:solidFill"); if (sf) { var c = findColor(sf, ctx); return c ? "background-color:" + c : ""; }
      var gf = child(spPr, "a:gradFill"); if (gf) { var g = gradientCss(gf, ctx); if (g) return "background:" + g; }
      if (child(spPr, "a:noFill")) return "";
    }
    var style = child(sp, "p:style");
    if (style) {
      var fr = child(style, "a:fillRef");
      if (fr && num(fr.getAttribute("idx")) > 0) { var c2 = findColor(fr, ctx); if (c2) return "background-color:" + c2; }
    }
    return "";
  }
  function shapeLine(sp, spPr, ctx) {
    var ln = spPr ? child(spPr, "a:ln") : null;
    var color = null, w = 0;
    if (ln) {
      if (child(ln, "a:noFill")) return null;
      color = findColor(ln, ctx); w = num(ln.getAttribute("w"));
    }
    if (!color) {
      var style = child(sp, "p:style");
      var lr = style ? child(style, "a:lnRef") : null;
      if (lr && num(lr.getAttribute("idx")) > 0) color = findColor(lr, ctx);
    }
    if (!color) return null;
    return { color: color, width: Math.max(1, w * ctx.scale) };
  }
  function bodyPrPadding(txBody, ctx) {
    var insets = { l: 91440, t: 45720, r: 91440, b: 45720 };
    var css = ["display:flex", "flex-direction:column", "justify-content:flex-start"];
    var bodyPr = txBody ? child(txBody, "a:bodyPr") : null;
    if (bodyPr) {
      var anchor = bodyPr.getAttribute("anchor");
      if (anchor === "ctr") css[2] = "justify-content:center";
      else if (anchor === "b") css[2] = "justify-content:flex-end";
      ["lIns", "tIns", "rIns", "bIns"].forEach(function (k) {
        var v = bodyPr.getAttribute(k);
        if (v != null && v !== "" && v !== "-") insets[k.charAt(0)] = num(v);
      });
    }
    css.push("padding:" + (insets.t * ctx.scale).toFixed(1) + "px " + (insets.r * ctx.scale).toFixed(1) + "px " + (insets.b * ctx.scale).toFixed(1) + "px " + (insets.l * ctx.scale).toFixed(1) + "px");
    return css.join(";");
  }

  function renderSp(sp, ctx, t, sources, rectOverride) {
    var spPr = child(sp, "p:spPr");
    var rect = applyTransform(rectOverride || rectFromXfrm(child(spPr, "a:xfrm")), t);
    var txBody = child(sp, "p:txBody");
    var content = txBody ? renderTextBody(txBody, ctx, sources) : "";
    var fill = shapeFillCss(sp, spPr, ctx);
    var line = shapeLine(sp, spPr, ctx);

    if (!rect) {
      if (!content) return "";
      var top = ctx.flowY;
      ctx.flowY += (children(txBody, "a:p").length || 1) * 34;
      return '<div class="pptx-shape pptx-flow" style="left:' + (ctx.offX + 20) + "px;top:" + top + "px;width:" + (CANVAS_W - 40) + "px;" + fill + '">' + content + "</div>";
    }
    var r = rectToCss(rect, ctx);
    var style = "left:" + r.x.toFixed(1) + "px;top:" + r.y.toFixed(1) + "px;width:" + r.w.toFixed(1) + "px;height:" + r.h.toFixed(1) + "px;";
    if (content) style += bodyPrPadding(txBody, ctx) + ";";
    if (fill) style += fill + ";";
    if (line) style += "border:" + line.width.toFixed(1) + "px solid " + line.color + ";";
    return '<div class="pptx-shape" style="' + style + '">' + content + "</div>";
  }

  function renderPic(pic, ctx, t, rectOverride) {
    var spPr = child(pic, "p:spPr");
    var rect = applyTransform(rectOverride || rectFromXfrm(child(spPr, "a:xfrm")), t);
    if (!rect) return "";
    var blipFill = child(pic, "p:blipFill");
    var blip = blipFill ? child(blipFill, "a:blip") : null;
    var embed = blip ? (attr(blip, "r:embed") || attr(blip, "r:link")) : null;
    var src = embed && ctx.rels[embed] ? ctx.getDataUrl(ctx.rels[embed].target || ctx.rels[embed]) : "";
    if (!src) return "";
    var r = rectToCss(rect, ctx);

    var srcRect = blipFill ? child(blipFill, "a:srcRect") : null;
    var l = srcRect ? num(srcRect.getAttribute("l")) / 100000 : 0;
    var tp = srcRect ? num(srcRect.getAttribute("t")) / 100000 : 0;
    var rr = srcRect ? num(srcRect.getAttribute("r")) / 100000 : 0;
    var bb = srcRect ? num(srcRect.getAttribute("b")) / 100000 : 0;

    if (l || tp || rr || bb) {
      var iw = r.w / Math.max(0.0001, 1 - l - rr);
      var ih = r.h / Math.max(0.0001, 1 - tp - bb);
      return '<div class="pptx-pic-crop" style="left:' + r.x.toFixed(1) + "px;top:" + r.y.toFixed(1) + "px;width:" + r.w.toFixed(1) + "px;height:" + r.h.toFixed(1) + 'px;">' +
        '<img class="pptx-pic-inner" alt="" src="' + src + '" style="left:' + (-l * iw).toFixed(1) + "px;top:" + (-tp * ih).toFixed(1) + "px;width:" + iw.toFixed(1) + "px;height:" + ih.toFixed(1) + 'px;" /></div>';
    }
    return '<img class="pptx-pic" alt="" src="' + src + '" style="left:' + r.x.toFixed(1) + "px;top:" + r.y.toFixed(1) + "px;width:" + r.w.toFixed(1) + "px;height:" + r.h.toFixed(1) + 'px;" />';
  }

  function renderCxnSp(sp, ctx, t) {
    var spPr = child(sp, "p:spPr");
    var rect = applyTransform(rectFromXfrm(child(spPr, "a:xfrm")), t);
    if (!rect) return "";
    var line = shapeLine(sp, spPr, ctx);
    if (!line) return "";
    var r = rectToCss(rect, ctx);
    var h = Math.max(line.width, r.h);
    var w = Math.max(r.w, line.width);
    return '<div class="pptx-cxn" style="left:' + r.x.toFixed(1) + "px;top:" + (r.y + r.h / 2 - line.width / 2).toFixed(1) + "px;width:" + w.toFixed(1) + "px;height:" + line.width.toFixed(1) + "px;background:" + line.color + ';"></div>';
  }

  function renderTable(gf, ctx, t) {
    var rect = applyTransform(rectFromXfrm(child(gf, "p:xfrm")), t);
    var tbl = firstDesc(gf, "a:tbl");
    if (!rect || !tbl) return "";
    var r = rectToCss(rect, ctx);
    var gridCols = children(child(tbl, "a:tblGrid"), "a:gridCol");
    var totalW = gridCols.reduce(function (s, c) { return s + num(c.getAttribute("w")); }, 0);
    var rowsHtml = "";
    children(tbl, "a:tr").forEach(function (tr) {
      var cells = "";
      children(tr, "a:tc").forEach(function (tc) {
        var span = num(tc.getAttribute("gridSpan")) || 1;
        var txBody = child(tc, "a:txBody") || child(tc, "p:txBody");
        var inner = txBody ? renderTextBody(txBody, ctx, []) : "";
        var tcPr = child(tc, "a:tcPr");
        var fillCss = "";
        if (tcPr) { var sf = child(tcPr, "a:solidFill"); if (sf) { var c = findColor(sf, ctx); if (c) fillCss = "background-color:" + c + ";"; } }
        cells += "<td" + (span > 1 ? ' colspan="' + span + '"' : "") + (fillCss ? ' style="' + fillCss + '"' : "") + ">" + inner + "</td>";
      });
      rowsHtml += "<tr>" + cells + "</tr>";
    });
    var colgroup = "";
    if (gridCols.length && totalW > 0) {
      colgroup = "<colgroup>" + gridCols.map(function (c) { return '<col style="width:' + ((num(c.getAttribute("w")) / totalW) * 100).toFixed(3) + '%">'; }).join("") + "</colgroup>";
    }
    return '<table class="pptx-table" style="left:' + r.x.toFixed(1) + "px;top:" + r.y.toFixed(1) + "px;width:" + r.w.toFixed(1) + "px;height:" + r.h.toFixed(1) + 'px;">' + colgroup + "<tbody>" + rowsHtml + "</tbody></table>";
  }

  function groupTransform(grp, ctx, t) {
    var grpSpPr = child(grp, "p:grpSpPr");
    var xfrm = grpSpPr ? child(grpSpPr, "a:xfrm") : null;
    var own = applyTransform(rectFromXfrm(xfrm), t);
    if (!own || !xfrm) return null;
    var chOff = child(xfrm, "a:chOff"), chExt = child(xfrm, "a:chExt");
    if (!chOff || !chExt) return null;
    return { ox: own.x, oy: own.y, sx: num(chExt.getAttribute("cx")) ? own.cx / num(chExt.getAttribute("cx")) : 1, sy: num(chExt.getAttribute("cy")) ? own.cy / num(chExt.getAttribute("cy")) : 1, chx: num(chOff.getAttribute("x")), chy: num(chOff.getAttribute("y")) };
  }

  function getPh(el) {
    var nvPr = firstDesc(el, "p:nvPr");
    return nvPr ? child(nvPr, "p:ph") : null;
  }
  function phType(ph) { return (ph && ph.getAttribute("type")) || "body"; }
  function phIdx(ph) { return (ph && ph.getAttribute("idx")) || "0"; }

  function findPlaceholder(map, type, idx) {
    if (!map) return null;
    if (map[type + "|" + idx]) return map[type + "|" + idx];
    for (var k in map) {
      var parts = k.split("|");
      if (parts[1] === idx) return map[k];
    }
    for (var k2 in map) {
      if (k2.split("|")[0] === type) return map[k2];
    }
    return null;
  }

  function buildSources(ctx, type, lph, mph, shapeLstMap) {
    var sources = [];
    var tx = (ctx.master && ctx.master.txStyles) || {};
    if (type === "title" || type === "ctrTitle") {
      if (tx.title) sources.push(tx.title);
      else if (tx.other) sources.push(tx.other);
    } else if (type === "body" || type === "obj" || type === "subTitle") {
      if (tx.body) sources.push(tx.body);
      else if (tx.other) sources.push(tx.other);
    } else if (type) {
      // 其它类型占位符（日期/页脚/页码等）用 otherStyle
      if (tx.other) sources.push(tx.other);
    } else {
      // 普通文本框/自选图形：用 presentation.xml 的 defaultTextStyle
      if (ctx.defaultTextStyle) sources.push(ctx.defaultTextStyle);
      else if (tx.other) sources.push(tx.other);
    }
    if (mph && mph.lst) sources.push(mph.lst);
    if (lph && lph.lst) sources.push(lph.lst);
    if (shapeLstMap) sources.push(shapeLstMap);
    return sources;
  }

  function renderShapeTree(node, ctx, out, t, opts) {
    opts = opts || {};
    var kids = children(node);
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i], tag = n.tagName;
      var ph = getPh(n);
      if (opts.skipPlaceholders && ph) continue;

      if (tag === "p:sp") {
        var spPr = child(n, "p:spPr");
        var rect = rectFromXfrm(child(spPr, "a:xfrm"));
        var sources;
        if (ph && opts.inherit) {
          var type = phType(ph), idx = phIdx(ph);
          var lph = findPlaceholder(ctx.layout.phMap, type, idx);
          var mph = findPlaceholder(ctx.master.phMap, type, idx);
          if (!rect) rect = (lph && lph.xfrm) || (mph && mph.xfrm) || null;
          var txBody = child(n, "p:txBody");
          var shapeLstMap = txBody && child(txBody, "a:lstStyle") ? parseLvlMap(child(txBody, "a:lstStyle"), ctx) : null;
          sources = buildSources(ctx, type, lph, mph, shapeLstMap);
        } else {
          var tb = child(n, "p:txBody");
          var sl = tb && child(tb, "a:lstStyle") ? parseLvlMap(child(tb, "a:lstStyle"), ctx) : null;
          sources = buildSources(ctx, null, null, null, sl);
        }
        out.push(renderSp(n, ctx, t, sources, rect));
      } else if (tag === "p:pic") {
        out.push(renderPic(n, ctx, t));
      } else if (tag === "p:cxnSp") {
        out.push(renderCxnSp(n, ctx, t));
      } else if (tag === "p:graphicFrame") {
        out.push(renderTable(n, ctx, t));
      } else if (tag === "p:grpSp") {
        renderShapeTree(n, ctx, out, groupTransform(n, ctx, t), opts);
      }
    }
  }

  // ------------------------------------------------------------------ 主题 / 关系 / 部件
  function parseTheme(themeXml, ctx) {
    if (!themeXml) return;
    var clr = firstDesc(themeXml, "a:clrScheme");
    if (clr) {
      children(clr).forEach(function (node) {
        var name = node.tagName.replace(/^a:/, "");
        var srgb = child(node, "a:srgbClr"), sys = child(node, "a:sysClr");
        var val = srgb ? srgb.getAttribute("val") : (sys ? sys.getAttribute("lastClr") : null);
        if (val) ctx.themeColors[name] = "#" + val;
      });
    }
    var fonts = firstDesc(themeXml, "a:fontScheme");
    if (fonts) {
      var major = child(fonts, "a:majorFont"), minor = child(fonts, "a:minorFont");
      function face(ff, tag) { var e = ff && child(ff, tag); return e && e.getAttribute("typeface"); }
      ctx.themeFonts = {
        majorLatin: face(major, "a:latin"), majorEa: face(major, "a:ea"), majorCs: face(major, "a:cs"),
        minorLatin: face(minor, "a:latin"), minorEa: face(minor, "a:ea"), minorCs: face(minor, "a:cs")
      };
    }
  }
  function parseRels(relsXml, baseDir) {
    var map = {};
    if (!relsXml) return map;
    var rels = relsXml.getElementsByTagName("Relationship");
    for (var i = 0; i < rels.length; i++) {
      var r = rels[i];
      map[r.getAttribute("Id")] = { target: resolvePath(baseDir, r.getAttribute("Target")), type: r.getAttribute("Type") || "", mode: r.getAttribute("TargetMode") || "" };
    }
    return map;
  }
  function relByType(rels, suffix) {
    for (var id in rels) { if (rels[id].type.indexOf(suffix) !== -1) return rels[id]; }
    return null;
  }
  function parseClrMap(masterXml) {
    var cm = firstDesc(masterXml, "p:clrMap");
    if (!cm) return null;
    var out = {};
    ["bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"].forEach(function (k) {
      var v = cm.getAttribute(k); if (v) out[k] = v;
    });
    return out;
  }
  function collectPlaceholders(spTree, map, ctx) {
    children(spTree).forEach(function (el) {
      var ph = getPh(el);
      if (!ph) return;
      var type = phType(ph), idx = phIdx(ph);
      var spPr = child(el, "p:spPr");
      var rect = rectFromXfrm(spPr ? child(spPr, "a:xfrm") : null);
      var txBody = child(el, "p:txBody") || child(el, "a:txBody");
      var lst = txBody ? child(txBody, "a:lstStyle") : null;
      map[type + "|" + idx] = { xfrm: rect, lst: lst ? parseLvlMap(lst, ctx) : null };
    });
  }

  // ------------------------------------------------------------------ 主入口
  async function parsePptxToSlides(input, deps) {
    deps = deps || {};
    var JSZip = deps.JSZip || (typeof global !== "undefined" && global.JSZip);
    var DOMParserCtor = deps.DOMParser || (typeof global !== "undefined" && global.DOMParser);
    if (!JSZip) throw new Error("缺少 JSZip");
    if (!DOMParserCtor) throw new Error("缺少 DOMParser");

    var zip = await JSZip.loadAsync(input);
    var parser = new DOMParserCtor();

    async function readXml(path) {
      var f = zip.file(path);
      if (!f) return null;
      return parser.parseFromString(await f.async("string"), "text/xml");
    }

    var MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff" };
    var dataUrlCache = {};
    function getDataUrl(path) { return dataUrlCache[path] || ""; }
    async function preloadImage(path) {
      if (dataUrlCache[path] !== undefined) return;
      dataUrlCache[path] = "";
      var f = zip.file(path); if (!f) return;
      var ext = (path.split(".").pop() || "").toLowerCase();
      var mime = MIME[ext]; if (!mime) return;
      try { dataUrlCache[path] = "data:" + mime + ";base64," + (await f.async("base64")); } catch (e) { /* ignore */ }
    }

    var ctx = {
      themeColors: {}, themeFonts: { majorLatin: null, majorEa: null, minorLatin: null, minorEa: null },
      clrMap: { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2", accent1: "accent1", accent2: "accent2", accent3: "accent3", accent4: "accent4", accent5: "accent5", accent6: "accent6", hlink: "hlink", folHlink: "folHlink" },
      rels: {}, master: null, layout: null, getDataUrl: getDataUrl,
      scale: 1, offX: 0, offY: 0, ptToPx: 1, flowY: 0
    };

    // 主题
    var themeXml = await readXml("ppt/theme/theme1.xml");
    if (!themeXml) {
      var themePath = null;
      zip.forEach(function (p) { if (!themePath && /^ppt\/theme\/theme\d+\.xml$/.test(p)) themePath = p; });
      themeXml = themePath ? await readXml(themePath) : null;
    }
    parseTheme(themeXml, ctx);

    // 幻灯片尺寸
    var slideW = 12192000, slideH = 6858000;
    var presXml = await readXml("ppt/presentation.xml");
    var presRels = parseRels(await readXml("ppt/_rels/presentation.xml.rels"), "ppt");
    ctx.defaultTextStyle = presXml ? parseLvlMap(firstDesc(presXml, "p:defaultTextStyle"), ctx) : null;
    if (presXml) { var sz = firstDesc(presXml, "p:sldSz"); if (sz) { slideW = num(sz.getAttribute("cx")) || slideW; slideH = num(sz.getAttribute("cy")) || slideH; } }
    ctx.scale = Math.min(CANVAS_W / slideW, CANVAS_H / slideH);
    ctx.offX = (CANVAS_W - slideW * ctx.scale) / 2;
    ctx.offY = (CANVAS_H - slideH * ctx.scale) / 2;
    ctx.ptToPx = EMU_PER_PT * ctx.scale;

    // 部件缓存 & 解析
    var partCache = {};
    async function getPart(path, kind, baseDir) {
      if (partCache[path]) return partCache[path];
      partCache[path] = (async function () {
        var xml = await readXml(path);
        if (!xml) return null;
        var rels = parseRels(await readXml(baseDir + "/_rels/" + baseName(path) + ".rels"), baseDir);
        for (var id in rels) { if (rels[id].type.indexOf("/image") !== -1) await preloadImage(rels[id].target); }
        var spTree = firstDesc(xml, "p:spTree");
        var phMap = {};
        if (spTree) collectPlaceholders(spTree, phMap, ctx);
        var txStyles = kind === "master" ? {
          title: parseLvlMap(firstDesc(xml, "p:titleStyle"), ctx),
          body: parseLvlMap(firstDesc(xml, "p:bodyStyle"), ctx),
          other: parseLvlMap(firstDesc(xml, "p:otherStyle"), ctx)
        } : null;
        return { xml: xml, rels: rels, spTree: spTree, phMap: phMap, txStyles: txStyles };
      })();
      return partCache[path];
    }
    function parseBg(xml, rels) {
      var bg = firstDesc(xml, "p:bg"); if (!bg) return null;
      var bgPr = child(bg, "p:bgPr");
      if (bgPr) {
        var sf = child(bgPr, "a:solidFill"); if (sf) { var c = findColor(sf, ctx); if (c) return { color: c }; }
        var bf = child(bgPr, "a:blipFill");
        if (bf) { var blip = child(bf, "a:blip"); var embed = blip ? attr(blip, "r:embed") : null; if (embed && rels[embed]) { var u = getDataUrl(rels[embed].target); if (u) return { image: u }; } }
        var gf = child(bgPr, "a:gradFill"); if (gf) { var g = gradientCss(gf, ctx); if (g) return { gradient: g }; }
      }
      var bgRef = firstDesc(bg, "a:bgRef"); if (bgRef) { var c2 = findColor(bgRef, ctx); if (c2) return { color: c2 }; }
      return null;
    }

    // 收集并排序幻灯片
    var slideFiles = [];
    zip.forEach(function (p) { if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) slideFiles.push(p); });
    slideFiles.sort(function (a, b) { return num((a.match(/slide(\d+)\.xml/) || [])[1]) - num((b.match(/slide(\d+)\.xml/) || [])[1]); });

    var result = [];
    for (var i = 0; i < slideFiles.length; i++) {
      var slidePath = slideFiles[i];
      var slidePart = await getPart(slidePath, "slide", "ppt/slides");
      if (!slidePart) continue;

      var layoutRel = relByType(slidePart.rels, "slideLayout");
      var layoutPart = layoutRel ? await getPart(layoutRel.target, "layout", "ppt/slideLayouts") : null;
      var masterPart = null;
      var masterRel = layoutPart ? relByType(layoutPart.rels, "slideMaster") : relByType(presRels, "slideMaster");
      if (masterRel) masterPart = await getPart(masterRel.target, "master", "ppt/slideMasters");

      if (masterPart) {
        var cm = parseClrMap(masterPart.xml);
        if (cm) ctx.clrMap = Object.assign({}, ctx.clrMap, cm);
      }
      ctx.master = masterPart || { phMap: {}, txStyles: { title: {}, body: {}, other: {} } };
      ctx.layout = layoutPart || { phMap: {} };
      ctx.flowY = ctx.offY;

      var out = [];
      // 1) 母版装饰（非占位符）
      if (masterPart && masterPart.spTree) { ctx.rels = masterPart.rels; renderShapeTree(masterPart.spTree, ctx, out, null, { skipPlaceholders: true, inherit: false }); }
      // 2) 版式装饰（非占位符）
      if (layoutPart && layoutPart.spTree) { ctx.rels = layoutPart.rels; renderShapeTree(layoutPart.spTree, ctx, out, null, { skipPlaceholders: true, inherit: false }); }
      // 3) 幻灯片自身（占位符继承版式/母版几何与样式）
      ctx.rels = slidePart.rels;
      renderShapeTree(slidePart.spTree, ctx, out, null, { skipPlaceholders: false, inherit: true });

      var html = out.filter(Boolean).join("");
      if (!html) html = '<div class="pptx-shape" style="left:40px;top:40px;width:816px;"><p>（空白幻灯片）</p></div>';

      // 背景：slide > layout > master
      var bg = parseBg(slidePart.xml, slidePart.rels) || (layoutPart && parseBg(layoutPart.xml, layoutPart.rels)) || (masterPart && parseBg(masterPart.xml, masterPart.rels));
      result.push({
        html: html,
        bgColor: bg && bg.color ? bg.color : "#ffffff",
        bgImage: bg && bg.image ? bg.image : "",
        bgGradient: bg && bg.gradient ? bg.gradient : ""
      });
    }
    return result;
  }

  var api = { parsePptxToSlides: parsePptxToSlides, CANVAS_W: CANVAS_W, CANVAS_H: CANVAS_H };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.PPTXImporter = api;
})(typeof window !== "undefined" ? window : this);
