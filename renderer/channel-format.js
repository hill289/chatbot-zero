/*!
 * channel-format.js — 多信道输出规范（Super-agent 模块 4.2）
 * =============================================================================
 * 对齐优化方案 4.2：Router 按「来源信道」套用输出规范：
 *   · IM（IM/chat/slack/wechat…）→ ≤100 词；
 *   · GitHub → 结构化（markdown PR/评审，原样传递，由上层组织结构）；
 *   · 邮件 → 原样（草稿）；
 *   · 未知信道 → 原样透传。
 * 纯逻辑、零依赖、可 Node 单测。
 *
 * formatForChannel(text, channel, opts) -> { channel, text, wordCount, truncated, finalWords }
 *
 * UMD：浏览器挂 globalThis.ChannelFormat / Node module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChannelFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
  var CJK_ALL = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;
  var IM_CHANNELS = { im: 1, chat: 1, slack: 1, imessage: 1, wechat: 1, whatsapp: 1, sms: 1 };

  // 词数：CJK 每字记 1 词 + 拉丁按空白分词
  function countWords(text) {
    text = String(text == null ? '' : text);
    var cjk = (text.match(CJK_ALL) || []).length;
    // 拉丁词：只统计「含字母/数字」的 token（排除 … 等纯标点，避免把省略号算作一个词）
    var latin = text.replace(CJK_ALL, ' ').split(/\s+/).filter(function (t) { return /[A-Za-z0-9]/.test(t); }).length;
    return cjk + latin;
  }

  // 截断到最多 maxWords 个词（CJK 逐字、拉丁逐词），末尾补 …
  function truncateToWords(text, maxWords) {
    text = String(text == null ? '' : text);
    var out = '';
    var words = 0;
    var inLatinWord = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (CJK_RE.test(ch)) {
        if (words + 1 > maxWords) break;
        out += ch; words++; inLatinWord = false;
      } else if (/\s/.test(ch)) {
        out += ch; inLatinWord = false;
      } else {
        if (!inLatinWord) {
          if (words + 1 > maxWords) break;
          words++; inLatinWord = true;
        }
        out += ch;
      }
    }
    out = out.replace(/\s+$/, '');
    return out ? (out + '…') : '…';
  }

  function formatForChannel(text, channel, opts) {
    text = String(text == null ? '' : text);
    var op = { maxWords: 100 };
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) op[k] = opts[k];
    var ch = String(channel == null ? '' : channel).toLowerCase();
    var wc = countWords(text);

    if (IM_CHANNELS[ch]) {
      if (wc > op.maxWords) {
        var t = truncateToWords(text, op.maxWords);
        return { channel: ch, text: t, wordCount: wc, truncated: true, finalWords: countWords(t) };
      }
      return { channel: ch, text: text, wordCount: wc, truncated: false, finalWords: wc };
    }
    // github / email / 未知：结构化或原样透传
    return { channel: ch || 'default', text: text, wordCount: wc, truncated: false, finalWords: wc };
  }

  return {
    countWords: countWords,
    truncateToWords: truncateToWords,
    formatForChannel: formatForChannel
  };
});
