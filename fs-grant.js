/* ══════════════════════════════════════════════════════════════════════
 *  fs-grant.js —— fileAPI 的「路径授权」模型（主进程使用，纯逻辑可单测）
 *
 *  问题：preload 把 fileAPI 暴露给工作台页面后，只要页面里跑起一段脚本
 *  （XSS / 恶意插件 / 被注入的模型输出），就能 fs.read('C:\\Users\\me\\.ssh\\id_rsa')
 *  再把内容发出去。企业安全评估第一轮就卡死。
 *
 *  做法：默认「零授权」。只有用户显式动作（把文件/文件夹拖进工作台、
 *  在系统对话框里选目录）才会登记一条授权：
 *    · file：精确匹配该路径；
 *    · dir ：该目录及其子目录。
 *  另外永远拒绝系统目录与密钥/凭据类路径（.ssh / .aws / Cookies / 应用自身配置目录等），
 *  即使它们正好落在某个授权目录里。
 *
 *  设计成纯函数式对象（注入 platform / protectedPaths），便于 node --test。
 * ══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');

const SENSITIVE_NAMES = [
    '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.netrc', '.npmrc',
    '.pypirc', '.git-credentials', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
    'login data', 'cookies', 'local state', 'secrets.json', 'fs-grants.json'
];

const SYSTEM_ROOTS = {
    win32: [
        process.env.SystemRoot || 'C:\\Windows',
        process.env.ProgramFiles || 'C:\\Program Files',
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        process.env.ProgramW6432 || 'C:\\Program Files'
    ],
    darwin: ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/private/var', '/Applications'],
    linux: ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev', '/root', '/var/lib']
};

function createGrantStore(options) {
    const opts = options || {};
    const platform = opts.platform || process.platform;
    const P = platform === 'win32' ? path.win32 : path.posix;
    const sep = platform === 'win32' ? '\\' : '/';
    const caseInsensitive = platform === 'win32' || platform === 'darwin';

    const dirGrants = new Map();   // key -> original path
    const fileGrants = new Map();
    const protectedRoots = new Set();

    function toKey(p) {
        let s = String(p == null ? '' : p).trim();
        if (!s) return '';
        // 只接受绝对路径（在 resolve 之前判断，否则相对路径会被拼到 cwd 上）
        if (!P.isAbsolute(s)) return '';
        // 去掉结尾分隔符（盘符根 / 文件系统根除外）
        if (s.length > 1) {
            const t = s.replace(/[\\/]+$/, '');
            if (t && !/^[a-zA-Z]:$/.test(t)) s = t;
        }
        let abs;
        try { abs = P.resolve(s); } catch (_) { return ''; }
        // 只接受绝对路径
        if (!P.isAbsolute(abs)) return '';
        return caseInsensitive ? abs.toLowerCase() : abs;
    }

    function isInside(childKey, parentKey) {
        if (!childKey || !parentKey) return false;
        if (childKey === parentKey) return true;
        return childKey.indexOf(parentKey + sep) === 0;
    }

    function addProtected(p) {
        const k = toKey(p);
        if (k) protectedRoots.add(k);
    }

    (opts.protectedPaths || []).forEach(addProtected);
    (SYSTEM_ROOTS[platform] || []).forEach(addProtected);

    function isSensitive(p) {
        const key = toKey(p);
        if (!key) return true;
        for (const root of protectedRoots) {
            if (isInside(key, root)) return true;
        }
        const parts = key.split(/[\\/]+/);
        for (const part of parts) {
            if (SENSITIVE_NAMES.indexOf(part) !== -1) return true;
            if (part.indexOf('id_rsa') === 0 || part.indexOf('id_ed25519') === 0) return true;
        }
        return false;
    }

    function add(p, kind) {
        const key = toKey(p);
        if (!key) {
            const err = new Error('EPERM_BAD_PATH：需要绝对路径');
            err.code = 'EPERM_BAD_PATH';
            throw err;
        }
        if (isSensitive(key)) {
            const err = new Error('EPERM_SENSITIVE：拒绝授权敏感路径（系统目录 / 密钥 / 应用配置）');
            err.code = 'EPERM_SENSITIVE';
            throw err;
        }
        const original = String(p);
        if (kind === 'file') fileGrants.set(key, original);
        else dirGrants.set(key, original);
        return { path: original, kind: kind === 'file' ? 'file' : 'dir' };
    }

    function isGranted(p) {
        const key = toKey(p);
        if (!key) return false;
        if (isSensitive(key)) return false;
        if (fileGrants.has(key)) return true;
        for (const root of dirGrants.keys()) {
            if (isInside(key, root)) return true;
        }
        return false;
    }

    function allows(p) {
        return isGranted(p);
    }

    function list() {
        const out = [];
        dirGrants.forEach((original) => out.push({ path: original, kind: 'dir' }));
        fileGrants.forEach((original) => out.push({ path: original, kind: 'file' }));
        return out;
    }

    function revokeAll() {
        dirGrants.clear();
        fileGrants.clear();
    }

    return {
        add,
        allows,
        isGranted,
        isSensitive,
        list,
        revokeAll,
        addProtected,
        toKey,
        isInside
    };
}

module.exports = { createGrantStore, SENSITIVE_NAMES };
