/*!
 * markview-web — pure-web, justified typesetting for Markdown.
 *
 * Re-implements the *observable* typography of the Markview reader in the
 * browser with no WebAssembly and no canvas painting:
 *
 *   1. measure glyph boxes with `CanvasRenderingContext2D.measureText`,
 *   2. break paragraphs with a bounded Knuth–Plass optimiser,
 *   3. render each decided line as one absolutely-sized DOM line box, and
 *      express justification with `word-spacing` / `letter-spacing`.
 *
 * This is the "looks the same" tier: justification, sensible (sometimes
 * hyphenated) line breaking, and KaTeX/Mermaid formulas and diagrams. It is
 * not glyph-for-glyph identical to the native reader — the browser's own
 * shaper still decides the advance of each cluster.
 *
 * Depends (all optional except a Markdown parser) on the page providing:
 *   window.markdownit, window.katex, window.mermaid, window.Hypher, window.HyphenationPatterns
 */
(function (global) {
	'use strict';

	// ------------------------------------------------------------------ utils
	function escapeHtml(s) {
		return s.replace(/[&<>"]/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
		});
	}

	// ------------------------------------------------------------- measurement
	var canvas =
		typeof OffscreenCanvas !== 'undefined'
			? new OffscreenCanvas(8, 8)
			: document.createElement('canvas');
	var ctx2d = canvas.getContext('2d');
	var measureCache = new Map();

	function fontOf(style, info) {
		var weight = style.bold ? '700' : '400';
		var italic = style.italic ? 'italic ' : '';
		var family = style.code ? info.monoFamily : info.family;
		return italic + weight + ' ' + info.size + 'px ' + family;
	}

	function measure(text, font) {
		if (!text) return 0;
		var key = font + '\u0000' + text;
		var w = measureCache.get(key);
		if (w === undefined) {
			ctx2d.font = font;
			w = ctx2d.measureText(text).width;
			measureCache.set(key, w);
		}
		return w;
	}

	function runsWidth(runs, limit) {
		var w = 0,
			left = limit === undefined ? Infinity : limit;
		for (var i = 0; i < runs.length && left > 0; i++) {
			var t = left === Infinity ? runs[i].text : runs[i].text.slice(0, left);
			w += measure(t, fontOf(runs[i].style, runs[i].info));
			left -= runs[i].text.length;
		}
		return w;
	}

	function runsChars(runs) {
		var n = 0;
		for (var i = 0; i < runs.length; i++) n += runs[i].text.length;
		return n;
	}

	function runsText(runs) {
		var s = '';
		for (var i = 0; i < runs.length; i++) s += runs[i].text;
		return s;
	}

	// Slice runs to the character window [from, to). `to` defaults to the end.
	function sliceRuns(runs, from, to) {
		var out = [],
			pos = 0;
		for (var i = 0; i < runs.length; i++) {
			var r = runs[i];
			var a = Math.max(0, from - pos);
			var b = (to === undefined ? r.text.length : to - pos);
			a = Math.min(a, r.text.length);
			b = Math.min(b, r.text.length);
			if (b > a) out.push({ text: r.text.slice(a, b), style: r.style, info: r.info });
			pos += r.text.length;
		}
		return out;
	}

	// ------------------------------------------------------- CJK break points
	// CJK text is written without word spaces, so a run of it must be split at
	// its own boundaries. UAX #14 offers a break between two ideographs, but
	// none before a closing mark (a comma or a full stop) nor after an opening
	// one; the native reader gets the same set from ICU, with the CJK quotes
	// reclassified so a quoted phrase is not glued together.
	function isCjkChar(c) {
		var u = c.codePointAt(0);
		return (
			(u >= 0x2e80 && u <= 0x2fdf) || // CJK radicals and Kangxi
			(u >= 0x3000 && u <= 0x303f) || // CJK symbols and punctuation
			(u >= 0x3040 && u <= 0x30ff) || // Hiragana and Katakana
			(u >= 0x3100 && u <= 0x312f) || // Bopomofo
			(u >= 0x31a0 && u <= 0x31bf) ||
			(u >= 0x3400 && u <= 0x4dbf) || // CJK Unified Ideographs Extension A
			(u >= 0x4e00 && u <= 0x9fff) || // CJK Unified Ideographs
			(u >= 0xf900 && u <= 0xfaff) || // CJK Compatibility Ideographs
			(u >= 0x20000 && u <= 0x3134f) || // CJK Unified Ideographs Extensions B–G
			(u >= 0xff00 && u <= 0xffef) // Fullwidth forms
		);
	}

	// A closing mark never begins a line and an opening mark never ends one.
	// The CJK quotes are shared with Latin, so they are listed here rather than
	// in `isCjkChar`, which keeps a break out of ordinary English quotation.
	var CJK_NO_START = '。，、；：！？．…‥）】》」』〕〉］｝〗〙〟｠”’';
	var CJK_NO_END = '（【《「『〔〈［｛〖〘｟“‘';

	// The character offsets at which `text` may break between two written
	// characters, inserting no hyphen and no other mark.
	function cjkBreakPoints(text) {
		var cuts = [];
		for (var i = 1; i < text.length; i++) {
			// Never cut a surrogate pair in half.
			var unit = text.charCodeAt(i);
			if (unit >= 0xdc00 && unit <= 0xdfff) continue;
			var before = text.charAt(i - 1);
			var after = text.charAt(i);
			if (!isCjkChar(before) && !isCjkChar(after)) continue;
			if (CJK_NO_START.indexOf(after) >= 0) continue;
			if (CJK_NO_END.indexOf(before) >= 0) continue;
			cuts.push(i);
		}
		return cuts;
	}

	// ----------------------------------------------------------- inline → items
	// An `item` is one unbreakable unit on a line:
	//   { kind:'word', runs, text, width, chars, hyps:[cut, ...], cuts:[cut, ...] }
	//   { kind:'space', width }
	//   { kind:'atom', width, html, chars:1 }         // inline math, etc.
	//   { kind:'hard' }                               // explicit <br>
	function inlineToItems(children, baseStyle, info) {
		var items = [];
		var pending = []; // runs of the word currently being accumulated
		var styleStack = [
			{ bold: baseStyle.bold, italic: baseStyle.italic, code: false, link: null },
		];

		function style() {
			return styleStack[styleStack.length - 1];
		}
		function flushWord() {
			if (!pending.length) return;
			var text = runsText(pending);
			var item = {
				kind: 'word',
				runs: pending,
				text: text,
				width: runsWidth(pending),
				chars: text.length,
				hyps: info.hyphenate ? info.hyphenate(text) : [],
				// Break points inside the run that take a hyphen (hyphenation)
				// and those that fall between two written characters (CJK).
				cuts: cjkBreakPoints(text),
			};
			items.push(item);
			pending = [];
		}
		function pushText(text, st) {
			// Split on whitespace: runs of non-space become word runs, each run
			// of whitespace becomes one inter-word space.
			var parts = text.split(/(\s+)/);
			for (var i = 0; i < parts.length; i++) {
				var p = parts[i];
				if (!p) continue;
				if (/^\s+$/.test(p)) {
					flushWord();
					items.push({ kind: 'space', width: info.spaceWidth });
				} else {
					pending.push({ text: p, style: st, info: info });
				}
			}
		}

		for (var i = 0; i < children.length; i++) {
			var t = children[i];
			switch (t.type) {
				case 'text':
					pushText(t.content, style());
					break;
				case 'strong_open':
					styleStack.push(Object.assign({}, style(), { bold: true }));
					break;
				case 'em_open':
					styleStack.push(Object.assign({}, style(), { italic: true }));
					break;
				case 'strong_close':
				case 'em_close':
					if (styleStack.length > 1) styleStack.pop();
					break;
				case 'link_open':
					styleStack.push(Object.assign({}, style(), { link: t.attrGet('href') }));
					break;
				case 'link_close':
					if (styleStack.length > 1) styleStack.pop();
					break;
				case 'code_inline':
					pending.push({
						text: t.content,
						style: Object.assign({}, style(), { code: true }),
						info: info,
					});
					break;
				case 'math_inline':
					flushWord();
					var atom = info.renderMath(t.content);
					if (atom) items.push(atom);
					break;
				case 'softbreak':
					flushWord();
					items.push({ kind: 'space', width: info.spaceWidth });
					break;
				case 'hardbreak':
					flushWord();
					items.push({ kind: 'hard' });
					break;
				case 'image':
					flushWord();
					var img = info.renderImage(t);
					if (img) items.push(img);
					break;
				default:
					if (t.content) pushText(t.content, style());
					break;
			}
		}
		flushWord();
		return items;
	}

	// ------------------------------------------------------------- break points
	// A break candidate is where a line may end. Each carries the cumulative
	// geometry needed to measure any line between two candidates in O(1):
	//   endW/endChars/endSpaces    — for the line that ends here
	//   startW/startChars/startSpaces — for the line that starts here next
	//   endItem/endCut, startItem/startCut — the item window to render
	function buildBreaks(items, info) {
		var breaks = [];
		var cumW = 0,
			cumChars = 0,
			cumSpaces = 0;
		var hyphenW = measure('-', info.bodyFont);

		breaks.push({
			endW: 0, startW: 0,
			endChars: 0, startChars: 0,
			endSpaces: 0, startSpaces: 0,
			endItem: -1, endCut: 0, startItem: 0, startCut: 0,
			hyphen: false, hard: false, final: false,
		});

		var n = items.length;
		var lastContent = -1;

		for (var k = 0; k < n; k++) {
			var it = items[k];
			if (it.kind === 'space') continue;
			if (it.kind === 'hard') {
				breaks.push({
					endW: cumW, startW: cumW,
					endChars: cumChars, startChars: cumChars,
					endSpaces: cumSpaces, startSpaces: cumSpaces,
					endItem: lastContent, endCut: Infinity,
					startItem: k + 1, startCut: 0,
					hyphen: false, hard: true, final: false,
				});
				continue;
			}
			lastContent = k;
			if (it.kind === 'word') {
				// A hyphenation point inserts a hyphen; a CJK point falls
				// between two written characters and inserts nothing. Merge
				// both lists into one run ordered by position.
				var points = [];
				for (var h = 0; h < it.hyps.length; h++) {
					points.push({ at: it.hyps[h], hyphen: true });
				}
				for (var c = 0; c < it.cuts.length; c++) {
					points.push({ at: it.cuts[c], hyphen: false });
				}
				points.sort(function (a, b) { return a.at - b.at; });
				for (var q = 0; q < points.length; q++) {
					var p = points[q].at;
					if (p <= 0 || p >= it.text.length) continue;
					var pw = runsWidth(it.runs, p);
					var hyphen = points[q].hyphen;
					breaks.push({
						endW: cumW + pw + (hyphen ? hyphenW : 0), startW: cumW + pw,
						endChars: cumChars + p + (hyphen ? 1 : 0), startChars: cumChars + p,
						endSpaces: cumSpaces, startSpaces: cumSpaces,
						endItem: k, endCut: p, startItem: k, startCut: p,
						hyphen: hyphen, hard: false, final: false,
					});
				}
			}
			cumW += it.width;
			cumChars += it.chars;
			// A space follows unless the next item is a hard break or the end.
			var next = items[k + 1];
			if (next && next.kind !== 'hard') {
				breaks.push({
					endW: cumW, startW: cumW + info.spaceWidth,
					endChars: cumChars, startChars: cumChars + 1,
					endSpaces: cumSpaces, startSpaces: cumSpaces + 1,
					endItem: k, endCut: Infinity, startItem: k + 1, startCut: 0,
					hyphen: false, hard: false, final: false,
				});
				cumW += info.spaceWidth;
				cumChars += 1;
				cumSpaces += 1;
			}
		}

		breaks.push({
			endW: cumW, startW: cumW,
			endChars: cumChars, startChars: cumChars,
			endSpaces: cumSpaces, startSpaces: cumSpaces,
			endItem: n - 1, endCut: Infinity, startItem: n, startCut: 0,
			hyphen: false, hard: false, final: true,
		});
		return breaks;
	}

	// --------------------------------------------------- Knuth–Plass line break
	function breakLines(breaks, target, info) {
		var INF = Infinity;
		var n = breaks.length;
		var dp = new Array(n);
		for (var z = 0; z < n; z++) dp[z] = { d: INF, prev: -1, r: 0 };
		dp[0] = { d: 0, prev: -1, r: 0 };

		for (var j = 1; j < n; j++) {
			var bj = breaks[j];
			var last = bj.final;
			for (var i = 0; i < j; i++) {
				if (dp[i].d === INF) continue;
				var a = breaks[i];
				var w = bj.endW - a.startW;
				var s = bj.endSpaces - a.startSpaces;
				var c = bj.endChars - a.startChars;
				if (c <= 0) continue;
				var stretch = s * info.wordStretch * info.spaceWidth + c * info.letterfit * info.size;
				var shrink = s * info.wordShrink * info.spaceWidth + c * info.letterfit * info.size;
				var need = target - w;
				var r;
				if (need < 0) {
					r = shrink > 0 ? need / shrink : -INF;
					if (r < -1) continue; // overfull is never legal
				} else if (last) {
					r = 0; // the final line is set ragged
				} else {
					r = stretch > 0 ? need / stretch : INF;
				}
				// Badness is graded well past r=1 so a very loose line is genuinely
				// discouraged (a capped-and-equal penalty makes the optimiser
				// indifferent and it may accept absurd letterfit instead).
				var badness = Math.min(1e7, 100 * Math.pow(Math.abs(r), 3));
				var d = Math.pow(info.linePenalty + badness, 2);
				if (bj.hyphen) {
					d += info.hyphenPenalty * info.hyphenPenalty;
					if (a.hyphen) d += info.doubleHyphen;
				}
				if (last && a.hyphen) d += info.finalHyphen;
				var total = dp[i].d + d;
				if (total < dp[j].d) dp[j] = { d: total, prev: i, r: r };
			}
		}

		if (dp[n - 1].d === INF) return null;
		var lines = [];
		var j2 = n - 1;
		while (j2 > 0) {
			var i2 = dp[j2].prev;
			lines.push(makeLine(breaks, i2, j2, dp[j2].r));
			j2 = i2;
		}
		lines.reverse();
		return lines;
	}

	function makeLine(breaks, i, j, ratio) {
		var a = breaks[i],
			b = breaks[j];
		return {
			startItem: a.startItem,
			startCut: a.startCut,
			endItem: b.endItem,
			endCut: b.endCut,
			hyphenEnd: b.hyphen,
			last: b.final,
			width: b.endW - a.startW,
			spaces: b.endSpaces - a.startSpaces,
			chars: b.endChars - a.startChars,
			ratio: ratio,
		};
	}

	// Greedy fallback: break at the last candidate that still fits, set ragged.
	function greedyLines(breaks, target) {
		var lines = [];
		var n = breaks.length;
		var i = 0;
		while (i < n - 1) {
			var best = -1;
			for (var j = i + 1; j < n; j++) {
				if (breaks[j].endW - breaks[i].startW <= target) best = j;
				else break;
			}
			if (best <= i) best = i + 1; // a single unbreakable unit overflows
			var line = makeLine(breaks, i, best, 0);
			line.justify = false;
			lines.push(line);
			i = best;
		}
		return lines;
	}

	// ------------------------------------------------------------- render lines
	function lineHtml(line, items) {
		var html = '';
		for (var k = line.startItem; k <= line.endItem && k < items.length; k++) {
			var it = items[k];
			if (it.kind === 'hard') continue;
			if (it.kind === 'space') {
				html += ' ';
				continue;
			}
			if (it.kind === 'atom') {
				html += it.html;
				continue;
			}
			// word: truncate the first/last fragment of a hyphenated word
			var runs = it.runs;
			var from = k === line.startItem ? line.startCut : 0;
			var to = k === line.endItem ? line.endCut : undefined;
			var view = sliceRuns(runs, from, to);
			for (var r = 0; r < view.length; r++) {
				html += runHtml(view[r]);
			}
			if (line.hyphenEnd && k === line.endItem) html += '-';
		}
		return html;
	}

	function runHtml(run) {
		var st = run.style;
		var attrs = '';
		if (st.bold) attrs += 'font-weight:700;';
		if (st.italic) attrs += 'font-style:italic;';
		if (st.link) attrs += 'color:inherit;';
		var inner = escapeHtml(run.text);
		if (st.link) inner = '<a href="' + escapeHtml(st.link) + '" class="mvw-link">' + inner + '</a>';
		var cls = st.code ? ' class="mvw-code"' : '';
		return '<span' + cls + ' style="' + attrs + '">' + inner + '</span>';
	}

	function spacingFor(line, target, info) {
		var need = target - line.width;
		var wordExtra = 0,
			letterExtra = 0;
		if (Math.abs(need) > 0.01) {
			if (line.spaces > 0) {
				var per = need / line.spaces;
				wordExtra = Math.max(
					-info.spaceWidth * info.wordShrink,
					Math.min(info.spaceWidth * info.wordStretch, per)
				);
			}
			var remaining = need - wordExtra * line.spaces;
			var denom = Math.max(1, line.chars - 1);
			letterExtra = remaining / denom;
			// Bound the letterfit so a line that cannot be closed tastefully is
			// left slightly short of the margin rather than spaced into a ladder.
			var cap = 0.25 * info.size;
			if (letterExtra > cap) letterExtra = cap;
			else if (letterExtra < -cap) letterExtra = -cap;
		}
		return { wordExtra: wordExtra, letterExtra: letterExtra };
	}

	// ------------------------------------------------------------ block walker
	function toTree(tokens) {
		var root = { type: 'root', children: [] };
		var stack = [root];
		for (var i = 0; i < tokens.length; i++) {
			var t = tokens[i];
			if (t.nesting === 1) {
				var node = {
					type: t.type.replace(/_open$/, ''),
					tag: t.tag,
					attrs: t.attrs,
					info: t.info,
					content: t.content,
					children: [],
					token: t,
				};
				stack[stack.length - 1].children.push(node);
				stack.push(node);
			} else if (t.nesting === -1) {
				stack.pop();
			} else {
				stack[stack.length - 1].children.push({
					type: t.type,
					tag: t.tag,
					content: t.content,
					info: t.info,
					token: t,
					children: t.children || null,
				});
			}
		}
		return root;
	}

	function inlineOf(node) {
		for (var i = 0; i < node.children.length; i++) {
			if (node.children[i].type === 'inline') return node.children[i].children || [];
		}
		return [];
	}

	var HEADING_SCALE = { h1: 1.9, h2: 1.5, h3: 1.25, h4: 1.1, h5: 1.0, h6: 0.95 };

	function renderBlocks(parent, node, info, ctx) {
		for (var i = 0; i < node.children.length; i++) {
			var child = node.children[i];
			switch (child.type) {
				case 'heading':
					renderHeading(parent, child, info, ctx);
					break;
				case 'paragraph':
					renderParagraph(parent, child, info, ctx);
					break;
				case 'bullet_list':
				case 'ordered_list':
					renderList(parent, child, info, ctx);
					break;
				case 'blockquote':
					renderQuote(parent, child, info, ctx);
					break;
				case 'fence':
				case 'code_block':
					renderCode(parent, child);
					break;
				case 'math_block':
					renderDisplayMath(parent, child, info);
					break;
				case 'hr':
					parent.appendChild(document.createElement('hr'));
					break;
				case 'table':
					renderTable(parent, child, info, ctx);
					break;
				case 'html_block':
					break;
				default:
					break;
			}
		}
	}

	function layoutParagraph(el, children, info, ctx) {
		var items = inlineToItems(children, { bold: false, italic: false }, info);
		if (!items.length) return;
		var width = ctx.width;
		var breaks = buildBreaks(items, info);
		var lines = breakLines(breaks, width, info);
		if (!lines) {
			lines = greedyLines(breaks, width);
			for (var g = 0; g < lines.length; g++) lines[g].justify = false;
		} else {
			for (var l = 0; l < lines.length; l++) {
				lines[l].justify = !lines[l].last; // final line stays ragged
			}
		}
		el.classList.add('mvw');
		el.style.width = width + 'px';
		for (var m = 0; m < lines.length; m++) {
			var line = lines[m];
			var div = document.createElement('div');
			div.className = 'mvw-line';
			// Use min-height, not a fixed height: a line holding a tall inline
			// atom (e.g. an inline \dfrac or an image) then grows to contain it,
			// instead of overflowing its box and colliding with the lines or
			// table rows around it. Plain text lines are unchanged (== lineHeight).
			div.style.minHeight = info.lineHeight + 'px';
			div.style.lineHeight = info.lineHeight + 'px';
			div.style.fontSize = info.size + 'px';
			div.innerHTML = lineHtml(line, items);
			if (ctx.justify && line.justify) {
				var sp = spacingFor(line, width, info);
				if (sp.wordExtra) div.style.wordSpacing = sp.wordExtra + 'px';
				if (sp.letterExtra) div.style.letterSpacing = sp.letterExtra + 'px';
			}
			el.appendChild(div);
		}
	}

	function renderHeading(parent, node, info, ctx) {
		var scale = HEADING_SCALE[node.tag] || 1;
		// A heading is a block of line boxes, so it must be a <div>: a <p>/<h1>
		// held in the DOM directly would still be invalid flow content.
		var el = document.createElement('div');
		el.className = 'mvw-heading mvw-' + (node.tag || 'h2');
		var blocked = el.style;
		blocked.margin = scale > 1.4 ? '0.7em 0 0.35em' : '0.6em 0 0.3em';
		var scaled = Object.assign({}, info, { size: info.size * scale });
		scaled.bodyFont = fontOf({ bold: false, italic: false }, scaled);
		scaled.spaceWidth = measure(' ', scaled.bodyFont);
		scaled.lineHeight = Math.round(scaled.size * 1.28);
		layoutParagraph(el, inlineOf(node), scaled, ctx);
		parent.appendChild(el);
	}

	function renderParagraph(parent, node, info, ctx) {
		var el = document.createElement('div');
		el.className = 'mvw-p';
		el.style.margin = '0 0 ' + info.size * 0.85 + 'px';
		layoutParagraph(el, inlineOf(node), info, ctx);
		parent.appendChild(el);
	}

	function renderList(parent, node, info, ctx) {
		var el = document.createElement(node.type === 'ordered_list' ? 'ol' : 'ul');
		el.className = 'mvw-list';
		var indent = info.size * 1.6;
		for (var i = 0; i < node.children.length; i++) {
			var li = document.createElement('li');
			li.style.marginLeft = indent + 'px';
			var sub = { width: ctx.width - indent, justify: ctx.justify };
			var kids = node.children[i].children;
			for (var k = 0; k < kids.length; k++) {
				if (kids[k].type === 'paragraph') {
					var p = document.createElement('div');
					p.className = 'mvw-p';
					layoutParagraph(p, inlineOf(kids[k]), info, sub);
					li.appendChild(p);
				} else if (kids[k].type === 'bullet_list' || kids[k].type === 'ordered_list') {
					renderList(li, kids[k], info, sub);
				}
			}
			el.appendChild(li);
		}
		parent.appendChild(el);
	}

	function renderQuote(parent, node, info, ctx) {
		var el = document.createElement('blockquote');
		el.className = 'mvw-quote';
		var indent = info.size * 1.4;
		el.style.paddingLeft = indent + 'px';
		renderBlocks(el, node, info, { width: ctx.width - indent, justify: ctx.justify });
		parent.appendChild(el);
	}

	function renderCode(parent, node) {
		var info = (node.info || '').trim();
		if (/^mermaid/.test(info) && global.mermaid) {
			var div = document.createElement('div');
			div.className = 'mvw-mermaid';
			div.textContent = node.content;
			parent.appendChild(div);
			return;
		}
		var pre = document.createElement('pre');
		pre.className = 'mvw-pre';
		var code = document.createElement('code');
		code.textContent = node.content.replace(/\n$/, '');
		pre.appendChild(code);
		parent.appendChild(pre);
	}

	function renderDisplayMath(parent, node, info) {
		var el = document.createElement('div');
		el.className = 'mvw-display-math';
		if (global.katex) {
			try {
				global.katex.render(node.content, el, { displayMode: true, throwOnError: false });
			} catch (e) {
				el.textContent = node.content;
			}
		} else {
			el.textContent = node.content;
		}
		parent.appendChild(el);
	}

	function renderTable(parent, node, info, ctx) {
		var table = document.createElement('table');
		table.className = 'mvw-table';
		var body = document.createElement('tbody');
		for (var i = 0; i < node.children.length; i++) {
			var section = node.children[i];
			var rows = section.type === 'thead' || section.type === 'tbody' ? section.children : [section];
			for (var r = 0; r < rows.length; r++) {
				var tr = document.createElement('tr');
				var cells = rows[r].children;
				for (var c = 0; c < cells.length; c++) {
					var cell = document.createElement(cells[c].tag || 'td');
					var cellWidth = ctx.width / Math.max(1, cells.length) - info.size;
					layoutParagraph(cell, inlineOf(cells[c]), info, { width: cellWidth, justify: false });
					tr.appendChild(cell);
				}
				body.appendChild(tr);
			}
		}
		table.appendChild(body);
		parent.appendChild(table);
	}

	// ------------------------------------------------------------------ atoms
	function measureAtomHtml(html, size, family) {
		var host = document.createElement('span');
		host.className = 'mvw-atom-measure';
		host.style.cssText =
			'position:absolute;left:-99999px;top:0;visibility:hidden;font-size:' +
			size +
			'px;font-family:' +
			family +
			';';
		host.innerHTML = html;
		document.body.appendChild(host);
		var w = host.getBoundingClientRect().width;
		document.body.removeChild(host);
		return w;
	}

	function renderMathAtom(content, info) {
		if (!global.katex) return null;
		var html;
		try {
			html = global.katex.renderToString(content, { displayMode: false, throwOnError: false });
		} catch (e) {
			return null;
		}
		var width = measureAtomHtml(html, info.size, info.family);
		return { kind: 'atom', width: width, html: html, chars: 1 };
	}

	function renderImageAtom(token, info) {
		var src = token.attrGet('src') || '';
		if (!src) return null;
		var w = parseFloat(token.attrGet('width'));
		if (!isFinite(w) || w <= 0) return null; // unknown size → treat as text
		var alt = token.content || '';
		return {
			kind: 'atom',
			width: w,
			html:
				'<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '" style="width:' + w + 'px">',
			chars: 1,
		};
	}

	// --------------------------------------------------------------- public op
	function withDefaults(options) {
		options = options || {};
		var size = options.fontSize || 18;
		var family =
			options.fontFamily || '"Noto Serif", Georgia, "Times New Roman", serif';
		var monoFamily =
			options.monoFamily || '"Noto Sans Mono", ui-monospace, SFMono-Regular, monospace';
		var info = {
			size: size,
			family: family,
			monoFamily: monoFamily,
			lineHeight: options.lineHeight || Math.round(size * 1.55),
			wordStretch: options.wordStretch != null ? options.wordStretch : 0.5,
			wordShrink: options.wordShrink != null ? options.wordShrink : 1 / 3,
			letterfit: options.letterfit != null ? options.letterfit : 0.01,
			linePenalty: options.linePenalty != null ? options.linePenalty : 10,
			hyphenPenalty: options.hyphenPenalty != null ? options.hyphenPenalty : 50,
			doubleHyphen: options.doubleHyphen != null ? options.doubleHyphen : 10000,
			finalHyphen: options.finalHyphen != null ? options.finalHyphen : 5000,
			hyphenate: options.hyphenate || null,
		};
		info.bodyFont = fontOf({ bold: false, italic: false }, info);
		info.spaceWidth = measure(' ', info.bodyFont);
		info.renderMath = function (tex) {
			return renderMathAtom(tex, info);
		};
		info.renderImage = function (token) {
			return renderImageAtom(token, info);
		};
		return info;
	}

	// A hyphenation helper built from Hypher, if the page loaded it.
	function hypherHyphenate(word) {
		if (!global.Hypher || !global.HyphenationPatterns) return null;
		var hyph = hypherHyphenate._engine;
		if (!hyph) {
			hyph = new global.Hypher(global.HyphenationPatterns.en);
			hypherHyphenate._engine = hyph;
		}
		if (!/^[A-Za-z\u00C0-\u024F]+$/.test(word) || word.length < 5) return [];
		var syllables = hyph.hyphenate(word);
		var cuts = [];
		var pos = 0;
		for (var i = 0; i < syllables.length - 1; i++) {
			pos += syllables[i].length;
			cuts.push(pos);
		}
		return cuts;
	}

	// ------------------------------------------------------------ document build
	// Make `$$…$$` display math able to interrupt a paragraph. Markdown
	// normally needs a blank line before a block-level construct, but authors
	// naturally write a formula right under a lead-in line such as
	// "**解答**：" with no blank line between them. texmath's block rule is not
	// registered as a paragraph terminator, so in that case the formula gets
	// merged into the paragraph and printed as raw TeX. Re-registering the
	// rule with `alt` marks it as a terminator (that is what `ruler.at` is
	// for; poking `rule.alt` directly does not clear markdown-it's cache).
	function hardenDisplayMath(md) {
		var ruler = md && md.block && md.block.ruler;
		if (!ruler || !ruler.__rules__) return;
		var names = ['math_block', 'math_block_eqno'];
		for (var n = 0; n < names.length; n++) {
			var rule = null;
			for (var i = 0; i < ruler.__rules__.length; i++) {
				if (ruler.__rules__[i].name === names[n]) {
					rule = ruler.__rules__[i];
					break;
				}
			}
			if (rule && rule.fn) {
				ruler.at(names[n], rule.fn, {
					alt: ['paragraph', 'reference', 'blockquote', 'list'],
				});
			}
		}
	}

	function parseInto(container, markdown, info, ctx, opts) {
		var md = opts.markdownit || global.markdownit;
		if (!md) return false;
		// markdown-it-texmath is published as a bare `function texmath`, so the
		// global is `texmath` (some bundlers re-export it as markdownitTexmath).
		var texmath = opts.texmath || global.texmath || global.markdownitTexmath;
		if (texmath) {
			md = md().use(texmath, {
				engine: global.katex || undefined,
				delimiters: opts.delimiters || 'dollars',
				katexOptions: { throwOnError: false },
			});
			hardenDisplayMath(md);
		} else {
			md = md();
		}
		renderBlocks(container, toTree(md.parse(markdown, {})), info, ctx);
		return true;
	}

	function runMermaid(root) {
		if (!global.mermaid) return Promise.resolve();
		var nodes = root.querySelectorAll('.mvw-mermaid');
		if (!nodes || !nodes.length) return Promise.resolve();
		try {
			return Promise.resolve(global.mermaid.run({ nodes: nodes })).catch(function () {});
		} catch (e) {
			return Promise.resolve();
		}
	}

	function render(container, markdown, options) {
		var opts = options || {};
		var info = withDefaults(opts);
		if (!info.hyphenate && global.Hypher && global.HyphenationPatterns) {
			info.hyphenate = hypherHyphenate;
		}
		var width = opts.width || 760;
		var ctx = { width: width, justify: opts.justify !== false };
		if (typeof container === 'string') container = document.querySelector(container);
		container.classList.add('markview');
		container.innerHTML = '';
		if (!parseInto(container, markdown, info, ctx, opts)) {
			container.textContent = 'markview-web: a Markdown parser (markdown-it) is required.';
			return;
		}
		runMermaid(container);
	}

	// ---------------------------------------------------- A4 / paginated output
	// One CSS reference pixel is 1/96 in, so a millimetre is 96/25.4 px.
	var MM = 96 / 25.4;

	function blockHeight(el) {
		var rect = el.getBoundingClientRect();
		var cs = global.getComputedStyle ? global.getComputedStyle(el) : null;
		var mb = cs ? parseFloat(cs.marginBottom) || 0 : 0;
		return rect.height + mb;
	}

	// Distribute laid-out blocks into fixed-height pages. Paragraphs and
	// headings split at line boundaries with widow/orphan control; anything
	// else (code, formulas, diagrams, tables, quotes) is atomic.
	function paginate(flow, o) {
		var pageW = o.pageWidth,
			pageH = o.pageHeight,
			margin = o.margin;
		var contentH = pageH - 2 * margin;
		var sheets = [],
			body = null,
			used = 0;

		function newPage() {
			var sheet = document.createElement('div');
			sheet.className = 'mvw-sheet markview';
			sheet.style.width = pageW + 'px';
			sheet.style.height = pageH + 'px';
			sheet.style.fontFamily = o.family;
			body = document.createElement('div');
			body.className = 'mvw-page-body';
			body.style.width = pageW + 'px';
			body.style.height = pageH + 'px';
			body.style.padding = margin + 'px';
			sheet.appendChild(body);
			var num = document.createElement('div');
			num.className = 'mvw-page-number';
			sheet.appendChild(num);
			sheets.push(sheet);
			used = 0;
		}
		function place(el, h) {
			body.appendChild(el);
			used += h;
		}
		newPage();

		var blocks = Array.prototype.slice.call(flow.children);
		for (var bi = 0; bi < blocks.length; bi++) {
			var el = blocks[bi];
			var cls = ' ' + (el.className || '') + ' ';
			var heading = cls.indexOf(' mvw-heading ') >= 0;
			var splittable = heading || cls.indexOf(' mvw-p ') >= 0;
			var h = blockHeight(el);
			// Keep a heading with at least two lines of what follows it.
			if (heading && used > 0 && contentH - used < h + 2 * o.lineHeight) newPage();
			if (splittable) {
				var lines = el.querySelectorAll('.mvw-line');
				var n = lines.length;
				if (!n) {
					place(el, h);
					continue;
				}
				var lh = lines[0].offsetHeight || o.lineHeight;
				var avail = contentH - used;
				if (h <= avail) {
					place(el, h);
					continue;
				}
				// It has to break. Prefer a break that satisfies widow/orphan; if
				// this page cannot give one, try a fresh page before forcing it.
				var fit = Math.floor(avail / lh);
				if (used > 0 && !(fit >= o.orphans && n - fit >= o.widows)) {
					newPage();
					avail = contentH;
					if (h <= avail) {
						place(el, h);
						continue;
					}
					fit = Math.floor(avail / lh);
				}
				if (fit < 1) fit = 1;
				if (fit > n - 1) fit = n - 1;
				var head = el.cloneNode(false);
				for (var a = 0; a < fit; a++) head.appendChild(lines[a]);
				body.appendChild(head);
				used += fit * lh;
				newPage();
				var tail = el.cloneNode(false);
				for (var b = fit; b < n; b++) tail.appendChild(lines[b]);
				body.appendChild(tail);
				used += (n - fit) * lh;
			} else if (h <= contentH - used) {
				place(el, h);
			} else {
				newPage();
				place(el, h);
			}
		}

		for (var i = 0; i < sheets.length; i++) {
			var num = sheets[i].querySelector ? sheets[i].querySelector('.mvw-page-number') : null;
			if (num) num.textContent = i + 1 + ' / ' + sheets.length;
		}
		return sheets;
	}

	/// Lay the document out as fixed A4 (or given) sheets, split at line
	/// boundaries. Needs a real DOM to measure; resolves to the sheet elements.
	function renderPages(container, markdown, options) {
		var opts = options || {};
		var info = withDefaults(opts);
		if (!info.hyphenate && global.Hypher && global.HyphenationPatterns) {
			info.hyphenate = hypherHyphenate;
		}
		var pageW = opts.pageWidth || 210 * MM;
		var pageH = opts.pageHeight || 297 * MM;
		var margin = (opts.margin != null ? opts.margin : 20) * MM;
		var contentW = pageW - 2 * margin;
		if (typeof container === 'string') container = document.querySelector(container);

		// Build the whole document off-screen at the page's text measure, so the
		// same lines are decided before any of them is placed on a sheet.
		var flow = document.createElement('div');
		flow.className = 'markview';
		flow.style.cssText =
			'position:absolute;left:-100000px;top:0;width:' +
			contentW +
			'px;visibility:hidden;';
		document.body.appendChild(flow);
		var ctx = { width: contentW, justify: opts.justify !== false };
		if (!parseInto(flow, markdown, info, ctx, opts)) {
			document.body.removeChild(flow);
			container.textContent = 'markview-web: a Markdown parser (markdown-it) is required.';
			return Promise.resolve([]);
		}
		return runMermaid(flow).then(function () {
			var sheets = paginate(flow, {
				pageWidth: pageW,
				pageHeight: pageH,
				margin: margin,
				family: info.family,
				lineHeight: info.lineHeight,
				orphans: opts.orphans || 2,
				widows: opts.widows || 2,
			});
			container.classList.add('markview-pages');
			container.innerHTML = '';
			for (var i = 0; i < sheets.length; i++) container.appendChild(sheets[i]);
			document.body.removeChild(flow);
			return sheets;
		});
	}

	/// Export the document as a PDF via the browser's own print-to-PDF pipeline.
	///
	/// Given a container and markdown it first lays the document out as A4
	/// sheets; either way it then opens the print dialog, where the destination
	/// "Save as PDF" writes a vector PDF — one sheet per page, selectable text,
	/// and the same justified lines — with no dependency and no server.
	function exportPdf(container, markdown, options) {
		var ready =
			container && markdown ? renderPages(container, markdown, options) : Promise.resolve();
		return Promise.resolve(ready)
			.then(function () {
				return global.document && global.document.fonts ? global.document.fonts.ready : null;
			})
			.then(function () {
				if (typeof global.print === 'function') global.print();
			});
	}

	/// Download the document as a real PDF **file** (no print dialog).
	///
	/// This is the fix for "Export PDF" appearing to do nothing: `exportPdf`
	/// only opens the browser's print dialog (and, because it is invoked from a
	/// promise continuation rather than the click itself, some browsers and
	/// embedded previews silently drop it). `downloadPdf` instead produces a
	/// PDF the browser actually saves.
	///
	/// The A4 sheets are first laid out (when a container *and* markdown are
	/// given), then each sheet is rasterised to a canvas with `html2canvas` and
	/// written as one A4 page with `jsPDF`. Both are read from the page
	/// (`window.html2canvas` / `window.jspdf`) or from `options`, so the library
	/// itself keeps no hard dependency. When either helper is missing it falls
	/// back to `exportPdf` (the print / vector route).
	function downloadPdf(container, markdown, options) {
		options = options || {};
		var ready =
			container && markdown ? renderPages(container, markdown, options) : Promise.resolve();
		return Promise.resolve(ready)
			.then(function () {
				return global.document && global.document.fonts ? global.document.fonts.ready : null;
			})
			.then(function () {
				var target =
					typeof container === 'string' ? document.querySelector(container) : container;
				var h2c = options.html2canvas || global.html2canvas;
				var ns = options.jspdf || global.jspdf;
				var JsPDF = ns && (ns.jsPDF || ns.default || ns);
				// No rasteriser / writer on the page → keep the old print route.
				if (!target || !h2c || !JsPDF) {
					if (typeof global.print === 'function') global.print();
					return null;
				}

				var sheets = Array.prototype.slice.call(target.querySelectorAll('.mvw-sheet'));
				if (!sheets.length) sheets = [target];

				// Flatten the on-screen chrome so the capture is clean paper.
				sheets.forEach(function (s) {
					s.style.boxShadow = 'none';
					s.style.borderRadius = '0';
				});
				function restore() {
					sheets.forEach(function (s) {
						s.style.boxShadow = '';
						s.style.borderRadius = '';
					});
				}

				var pdf = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
				var chain = Promise.resolve();
				sheets.forEach(function (sheet, idx) {
					chain = chain.then(function () {
						return h2c(sheet, {
							scale: options.pdfScale || 2,
							backgroundColor: '#ffffff',
							useCORS: true,
							logging: false,
						}).then(function (canvas) {
							var img = canvas.toDataURL('image/jpeg', 0.92);
							if (idx > 0) pdf.addPage();
							pdf.addImage(img, 'JPEG', 0, 0, 210, 297);
						});
					});
				});
				return chain
					.then(function () {
						restore();
						pdf.save(options.filename || 'markview.pdf');
					})
					.catch(function (err) {
						restore();
						if (global.console && global.console.error) global.console.error(err);
						if (typeof global.print === 'function') global.print();
					});
			});
	}

	global.Markview = {
		render: render,
		renderPages: renderPages,
		exportPdf: exportPdf,
		downloadPdf: downloadPdf,
		measure: measure,
		buildBreaks: buildBreaks,
		breakLines: breakLines,
		paginate: paginate,
		MM: MM,
		version: '0.1.0',
	};
})(typeof window !== 'undefined' ? window : this);
