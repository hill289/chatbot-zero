/* ══════════════════════════════════════════════════════════════════════
 *  renderer/drop-grant.js —— 「拖入路径」免确认授权的证明校验
 *
 *  背景：主进程的 fs:grant 对未授权路径会弹原生确认框（防 XSS 自行
 *  grant('C:\\Users\\me') 后读全盘）。但**拖放本身就是用户的显式动作**，
 *  再让用户点一次「允许访问」纯属重复确认，体验割裂。
 *
 *  做法：拖放链路另开一条免确认通道 fs:grant-dropped，但渲染层不能空手扩权，
 *  必须随请求提交「证明」：webUtils.getPathForFile() 取到的**真实文件路径**。
 *  该 API 对渲染层用 `new File()` 合成出来的对象返回空串，脚本无法凭空伪造；
 *  只有用户真的把文件/文件夹拖进窗口，才拿得到这些路径。
 *
 *  校验规则（纯逻辑、零依赖、可 node --test）：
 *    对每条待授权路径 P，必须存在一条证明路径 F，使得
 *      F === P（单个文件）  或  F 位于 P 之下（拖入目录）；
 *    即：授权范围不得超出「用户实际拖入的内容」，P 也不能是 F 的祖先之外的东西。
 *  敏感路径（系统目录 / 密钥 / 应用配置）由 fs-grant.js 的 add() 继续兜底拒绝，
 *  本模块只负责「有没有资格申请授权」。
 * ══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');

/**
 * @param {{platform?: string}} [options] 注入平台，便于单测（默认 process.platform）
 */
function createDropGrantVerifier(options) {
    const opts = options || {};
    const platform = opts.platform || process.platform;
    const P = platform === 'win32' ? path.win32 : path.posix;
    const sep = platform === 'win32' ? '\\' : '/';
    const caseInsensitive = platform === 'win32' || platform === 'darwin';

    // 归一化：只接受绝对路径；折叠 . / ..、去掉尾分隔符；按平台决定大小写
    function normalize(p) {
        let s = String(p == null ? '' : p).trim();
        if (!s) return '';
        if (!P.isAbsolute(s)) return '';
        let abs;
        try { abs = P.resolve(s); } catch (_) { return ''; }
        if (!P.isAbsolute(abs)) return '';
        if (abs.length > 1) {
            const t = abs.replace(/[\\/]+$/, '');
            if (t && !/^[a-zA-Z]:$/.test(t)) abs = t;
        }
        return caseInsensitive ? abs.toLowerCase() : abs;
    }

    // child 是否等于 parent，或位于 parent 之下（两者都应已 normalize）
    function isWithin(child, parent) {
        if (!child || !parent) return false;
        if (child === parent) return true;
        return child.indexOf(parent + sep) === 0;
    }

    // 证明路径去重并归一化（非绝对 / 空串一律丢弃 —— 合成 File 的路径就是空串）
    function proofKeysOf(proofs) {
        const out = [];
        const seen = Object.create(null);
        (Array.isArray(proofs) ? proofs : []).forEach(function (p) {
            const k = normalize(p);
            if (!k || seen[k]) return;
            seen[k] = true;
            out.push(k);
        });
        return out;
    }

    /**
     * 校验一批待授权路径。
     * @param {string[]} requested 待授权路径（拖入的顶层目录 / 单个文件）
     * @param {string[]} proofs    拖入文件在磁盘上的真实路径（getPathForFile）
     * @returns {{ allowed: string[], rejected: Array<{path:string, reason:string}> }}
     *          allowed 里是入参原样字符串（保留调用方的原始大小写 / 分隔符）
     */
    function verify(requested, proofs) {
        const proofKeys = proofKeysOf(proofs);
        const allowed = [];
        const rejected = [];
        const seen = Object.create(null);

        (Array.isArray(requested) ? requested : []).forEach(function (raw) {
            const key = normalize(raw);
            if (!key) {
                rejected.push({ path: String(raw == null ? '' : raw), reason: 'EPERM_BAD_PATH' });
                return;
            }
            if (seen[key]) return;          // 重复申请：静默去重
            seen[key] = true;
            // 至少要有一条真实拖入的文件路径落在该授权范围内（或就是它本身）
            let proven = false;
            for (let i = 0; i < proofKeys.length; i++) {
                if (isWithin(proofKeys[i], key)) { proven = true; break; }
            }
            if (!proven) {
                rejected.push({ path: String(raw), reason: 'EPERM_NO_DROP_PROOF' });
                return;
            }
            allowed.push(String(raw));
        });

        return { allowed: allowed, rejected: rejected };
    }

    return {
        platform: platform,
        normalize: normalize,
        isWithin: isWithin,
        proofKeysOf: proofKeysOf,
        verify: verify
    };
}

module.exports = { createDropGrantVerifier };
