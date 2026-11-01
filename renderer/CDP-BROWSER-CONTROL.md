# 《CDP 直连：让 AI Agent 操控 Electron 内置浏览器》实现方案

> 目标：不引入 Puppeteer / Playwright / 外部 Chrome，直接用 Electron 的
> `webContents.debugger`（原生 CDP 通道）让 Agent 以高保真、`isTrusted=true`
> 的方式操作内置浏览器标签页；感知走无障碍树（a11y）而非截图。

---

## 1. 为什么选「方案一：CDP 直连」

| 维度 | CDP 直连（本方案） | 外部 Puppeteer | WebDriver | 注入 JS 模拟 |
|---|---|---|---|---|
| 依赖 | 0（Electron 自带 Chromium + debugger） | 需装 Chromium/Node | 需 chromedriver | 0 |
| 事件可信度 | `isTrusted=true`（原生 Input 域） | 高 | 高 | 低（合成事件易被风控识别） |
| 保真度 | 一跳直连，无中间层、无状态漂移 | 高 | 中 | 低 |
| 版本一致性 | 与宿主内核完全一致 | 需对齐版本 | 需对齐 | — |
| 感知方式 | a11y 树 → 带 ref 的语义元素 | 可用 a11y | 有限 | 手写 DOM 选择器 |

结论：本仓库已是 Electron 多标签浏览器（`BaseWindow` + 多个 `WebContentsView`，
见 `main.js` 的 `tabs` / `createTab`），天然满足「方案一」的前提。采用 CDP 直连。

---

## 2. 总体架构（分层）

```
┌──────────────────────────────────────────────────────────────┐
│ 渲染层（工作台主页 tab，注入 preload.js）                       │
│  · browser-control-bootstrap.js  → window.registerTools([...])  │
│    暴露给 LLM 的工具：browser_list_tabs / browser_snapshot /    │
│    browser_click / browser_type / browser_navigate /           │
│    browser_evaluate / browser_screenshot                       │
│  · window.browserControl.*  （preload 通过 contextBridge 注入） │
└───────────────▲──────────────────────────────────────────────┘
                │ ipcRenderer.invoke('bcdp:*')   ← 受 isTrustedSender 保护
┌───────────────┴──────────────────────────────────────────────┐
│ 主进程（main.js）                                              │
│  · browser-cdp.js：registerBrowserCdp(...)  注册 bcdp:* IPC     │
│    createBrowserCdpController({ getTab, ... })  真正的 CDP 驱动 │
│  · 目标 tab 的 webContents.debugger.attach('1.3')              │
│    sendCommand('Accessibility.getFullAXTree' /                 │
│      'DOM.getContentQuads' / 'Input.dispatchMouseEvent' / ...)  │
└───────────────▲──────────────────────────────────────────────┘
                │ webContents.debugger（原生 CDP，进程内直连）
┌───────────────┴──────────────────────────────────────────────┐
│ 目标网页 tab（WebContentsView，远程页面，无 preload）           │
└──────────────────────────────────────────────────────────────┘
```

纯逻辑（可 node 单测、无 Electron 依赖）：
- `renderer/cdp-core.js`：a11y→refs、四边形→视口坐标、输入命令构造、快照渲染。
- `browser-cdp.js`：CDP 会话驱动；`deps` 注入 `getTab/activeTabId/...`，可用
  fake `webContents` 单测。

---

## 3. 关键难点：坐标换算（几十行，参考 Puppeteer 的 clickablePoint）

`Input.dispatchMouseEvent` 的 `x/y` 是 **CSS 像素、相对视口左上角**。
元素位置不能靠猜，走 CDP 两步拿：

1. `DOM.scrollIntoViewIfNeeded({ backendNodeId })` —— 先滚到可见。
2. `DOM.getContentQuads({ backendNodeId })` —— 返回若干四边形，每个是 8 个数
   `[x1,y1, x2,y2, x3,y3, x4,y4]`，单位 CSS 像素、已含滚动偏移（即视口坐标）。
3. `Page.getLayoutMetrics` → `layoutViewport.clientWidth/clientHeight` 作为视口边界。

换算规则（`cdp-core.js`）：
- 点击点 = 四边形四顶点均值：
  `x=(q0+q2+q4+q6)/4, y=(q1+q3+q5+q7)/4`。
- 元素可能是多段（inline）→ 取“中心落在视口内且面积最大”的那一块；
  全都落在视口外 → 报 `visible:false`（上层提示或再滚动）。
- **不做 DPR 换算**：CDP 输入坐标本就是 CSS 像素，`devicePixelRatio` 由内核处理。
  只有 `Page.captureScreenshot` 的位图尺寸才受 DPR 影响，与点击无关。
- 页面缩放（pinch-zoom）场景可再乘 `visualViewport` 比例；桌面多标签默认 1，先不启用。

---

## 4. 感知：无障碍树 → 带 ref 的元素

`Accessibility.getFullAXTree` 返回扁平 `nodes[]`，每个含
`nodeId / role.value / name.value / value / backendDOMNodeId / ignored / childIds / properties`。

算法（`cdp-core.buildSnapshot`）：
1. 建 `nodeId → node` 索引，从根 DFS。
2. 命中「可交互 / 有语义」角色才产出 ref：
   `button, link, textbox, searchbox, checkbox, radio, switch, combobox, listbox,
   option, menuitem, menuitemcheckbox, menuitemradio, tab, slider, spinbutton, heading`。
   跳过 `ignored` 节点但仍下钻其子树。
3. 每个命中的、且带 `backendDOMNodeId` 的节点分配自增 `ref`（从 1 开始），
   记录 `{ ref, role, name, value, backendNodeId, disabled, checked }`。
4. 渲染为紧凑文本，例如：

   ```
   Page: 登录 — https://example.com/login
   [1] textbox "邮箱"
   [2] textbox "密码"
   [3] checkbox "记住我" checked
   [4] button "登录"
   [5] link "忘记密码"
   ```

`ref` 只在「同一次 snapshot」内有效；控制器按 tabId 缓存最近一次快照的
`ref → backendNodeId` 映射，`browser_click/type` 用 ref 反查 backendNodeId。
（因此约束：先 `browser_snapshot`，再按 ref 操作。）

---

## 5. 真实输入（isTrusted）

- 点击：`Input.dispatchMouseEvent` 序列
  `mouseMoved → mousePressed → mouseReleased`，带 `button/buttons/clickCount`。
  产生的事件 `isTrusted=true`，能过支付控件、防爬校验。
- 输入：先点击聚焦目标元素 → `Input.insertText`（触发可信 `input` 事件）；
  需要真实键盘事件流时用 `buildKeyTypeCommands`（逐字符 `keyDown/char/keyUp`）。
- 回车提交：`Input.dispatchKeyEvent` `Enter` 的 down/up。

---

## 6. 对外接口

### 6.1 主进程 IPC（均校验 `isTrustedSender`）
| 通道 | 入参 | 出参 |
|---|---|---|
| `bcdp:list-tabs` | — | `{ tabs:[{id,url,title,active}], activeId }` |
| `bcdp:snapshot` | `{ tabId }` | `{ ok, text, refs:[...], url, title }` |
| `bcdp:click` | `{ tabId, ref \| x,y, button?, clickCount? }` | `{ ok, x, y }` |
| `bcdp:type` | `{ tabId, ref?, text, submit?, mode? }` | `{ ok }` |
| `bcdp:navigate` | `{ tabId, url }` | `{ ok, url }` |
| `bcdp:evaluate` | `{ tabId, expression }` | `{ ok, value }` / `{ ok:false, error }` |
| `bcdp:screenshot` | `{ tabId, format? }` | `{ ok, data(base64 png) }` |

### 6.2 preload（仅工作台主页注入）→ `window.browserControl`
`listTabs / snapshot / click / type / navigate / evaluate / screenshot`
（内部 `ipcRenderer.invoke('bcdp:*')`）。

### 6.3 渲染层工具（LLM 可见，经 `window.registerTools`）
`browser_list_tabs`、`browser_snapshot`、`browser_click`、`browser_type`、
`browser_navigate`、`browser_evaluate`、`browser_screenshot`。
描述里写清「先 snapshot 拿 ref 再操作、evaluate 等高危动作的使用边界」。

---

## 7. 安全边界

- 只有工作台主页（`preload=true`）登记为 `trustedSenders`，远程网页 tab 无 preload，
  无法触达 `bcdp:*`；主进程再以 `isTrustedSender(e)` 二次校验（双保险）。
- `browser_evaluate` 只在目标 tab 自身上下文执行（无法触达主进程/Node），
  但可读页面数据，属高危 → 在工具描述中提示，可纳入审批闸门。
- `browser_screenshot` 返回 base64，由渲染层决定是否落盘，不自动外发。
- 调试器复用：attach 幂等；tab 关闭时 webContents 销毁，debugger 自动解绑。

---

## 8. 文件清单（本次改动）

| 文件 | 作用 | 可否 node 单测 |
|---|---|---|
| `renderer/cdp-core.js` | 纯逻辑核心 | ✅ `cdp-core.test.js` |
| `browser-cdp.js` | 主进程 CDP 驱动 + IPC 注册 | ✅ `browser-cdp.test.js`（fake wc） |
| `renderer/browser-control-bootstrap.js` | 注册 `browser_*` 工具 | 加载即注册 |
| `preload.js` | 暴露 `window.browserControl` | — |
| `main.js` | 引入并 `registerBrowserCdp(...)` | 语法检查 |
| `renderer/index.html` | 引入两个脚本 | — |

## 9. 验证方式

1. `node --check`：所有改动 JS 语法通过。
2. `node renderer/cdp-core.test.js`：a11y→refs、坐标换算、命令构造全绿。
3. `node browser-cdp.test.js`：用 fake `webContents.debugger` 验证
   snapshot/click（ref→backend→quads→dispatch）/type/navigate/evaluate 全链路。
4. 既有模块加载不受影响（均为新增文件 + 少量增量接线）。
```
