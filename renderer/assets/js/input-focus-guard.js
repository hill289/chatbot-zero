/*!
 * input-focus-guard.js — 输入框「随时可点、可输入」的兜底保护
 * ══════════════════════════════════════════════════════════════════════
 * 背景 / 现象：
 *   页面看起来一切正常，但点输入框毫无反应、打不了字，必须刷新页面才好——
 *   典型原因是**有一层（往往是透明的）全屏浮层/残留遮罩压在输入框上方**：
 *   点击数被浮层接走，`e.target` 不再是 textarea，焦点就落不回输入框。
 *
 * 现有护栏（17-pgpy-fsui.js · wireInputFocusGuard）只在
 *   `e.target === userInput` 时才补聚焦，一旦被浮层遮挡就失效。
 *
 * 本模块改为**按坐标判定**：只要按下的位置正落在输入框（#inputBox/textarea）矩形内，
 * 且命中的最上层元素不是「合法交互控件」（按钮/链接/输入框等——那些要尊重用户意图），
 * 就视为被浮层遮挡，强制把焦点抢回 textarea，并阻止这次按下被浮层吞掉。
 * 这样无论被什么浮层盖住，用户点输入框都能立刻打字。
 *
 * 纯逻辑（pointInRect / shouldRescuePoint）与真实 DOM 解耦，便于用假 DOM 单测。
 * ══════════════════════════════════════════════════════════════════════
 */
(function (root) {
    'use strict';

    // 点 (x,y) 是否落在矩形 r={left,top,right,bottom} 内
    function pointInRect(x, y, r) {
        if (!r) return false;
        if (x == null || y == null || isNaN(x) || isNaN(y)) return false;
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    // 是否应把焦点抢回输入框：
    //   · 必须是左键（或非鼠标的 button==null）
    //   · 落点必须在输入框矩形内
    //   · 真实事件目标必须不是 textarea 本身（是则交给浏览器默认聚焦）
    //   · 命中的最上层元素必须不是合法交互控件（是则尊重控件，例如浮层上的按钮）
    function shouldRescuePoint(opts) {
        opts = opts || {};
        if (opts.button != null && opts.button !== 0) return false;
        if (!pointInRect(opts.x, opts.y, opts.rect)) return false;
        if (opts.userInput && opts.target === opts.userInput) return false;
        if (opts.userInput && opts.topEl === opts.userInput) return false;
        if (opts.topElIsControl) return false;
        return true;
    }

    // 命中的元素是否是可以合法交互的控件（这些不抢焦点）
    function defaultIsControl(el) {
        if (!el || !el.closest) return false;
        return !!el.closest('button, a, input, select, textarea, label, ' +
            '[contenteditable="true"], [role="button"], .attach-chip, .attach-del');
    }

    // 挂载到 document：返回 { destroy }
    function install(doc, opts) {
        opts = opts || {};
        var userInput = opts.userInput;
        if (!doc || !userInput || typeof doc.addEventListener !== 'function') return { destroy: function () {} };

        var getBox = opts.getBox || function () { return userInput.getBoundingClientRect(); };
        var isControl = opts.isControl || defaultIsControl;
        var focusUserInput = opts.focus || function () {
            try { userInput.focus({ preventScroll: true }); }
            catch (_) { try { userInput.focus(); } catch (__) {} }
        };

        function onMouseDown(e) {
            var rect = getBox();
            if (!pointInRect(e.clientX, e.clientY, rect)) return;
            if (e.target === userInput) return;              // 正常点在输入框上：交给默认行为定位光标
            var topEl = null;
            try { topEl = doc.elementFromPoint(e.clientX, e.clientY); } catch (_) {}
            var rescue = shouldRescuePoint({
                button: e.button, x: e.clientX, y: e.clientY, rect: rect,
                target: e.target, userInput: userInput, topEl: topEl,
                topElIsControl: isControl(topEl)
            });
            if (!rescue) return;
            try { e.preventDefault(); } catch (_) {}
            focusUserInput();
            try { var n = userInput.value.length; userInput.setSelectionRange(n, n); } catch (_) {}
        }

        doc.addEventListener('mousedown', onMouseDown, true);
        return {
            destroy: function () {
                try { doc.removeEventListener('mousedown', onMouseDown, true); } catch (_) {}
            }
        };
    }

    var api = { pointInRect: pointInRect, shouldRescuePoint: shouldRescuePoint, install: install };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.InputFocusGuard = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
