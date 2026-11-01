# site/ · 一页式官网 Demo

`index.html` 是一个**可运行**的单页官网演示：不是录屏，也不是写死的数据。

## 怎么打开

```bash
npx serve renderer          # 然后访问 /site/index.html
# 或
npm start                   # Electron 外壳里直接打开 renderer/site/index.html
```

> 必须与 `renderer/` 下的真实模块一起部署（页面用相对路径引用 `../hunk-select.js` 等）。
> 单独把 `index.html` 拷走会退化成一个静态页（脚本会提示模块未加载，而不是假装能跑）。

## 页面里什么是真的

| 区块 | 数据来源 |
|---|---|
| 差异与变更块划分 | `../hunk-select.js`（与工作台界面同一份实现） |
| 风险识别、交付摘要、Markdown 导出 | `../delivery-summary.js` |
| 门禁结论与诊断 | `../type-gate.js` + 浏览器内真实运行的 tsserver（`../lsp/typescript.js`，懒加载） |
| 磁盘风格档案（编码 / EOL / BOM） | `../eol-meta.js` |
| 写回前的磁盘状态判定 | `../sync-guard.js` |
| 成本滑块的算术 | 页面内联（示例单价，口径写在卡片底部） |

`demo-core.js` 把上述模块编排成「输入 → 计算 → 对象」，**不碰 DOM**，因此可以在 Node 下直接测试：

```bash
node --test renderer/site/demo-core.test.js
```

7 项断言覆盖：块划分、全接受→通过、只接受调用点→TS2304 阻断、摘要风险项与「绝不出现假绿勾」、引擎缺失→unavailable、部分落盘后剩余差异恰好等于被拒块、全部落盘后剩余为 0。

## 深链

- `index.html?preset=broken` —— 直接呈现「门禁阻断」那一刻（拒绝改名定义块，只接受调用点）
- `index.html?preset=none` —— 全部拒绝
- `index.html?probe=1` —— 在页面尾部输出一段布局几何 JSON（`vw / scrollWidth / 溢出元素 / 各 section 高度`），供无头浏览器做响应式回归

## 首次加载说明

门禁需要 tsserver，页面会在空闲时预取 `../lsp/ts-libs.js`（1.7MB）与 `../lsp/typescript.js`（8.5MB）。
滚到演示区时通常已就绪；没就绪时门禁显示「未检查」，摘要会把它写进「无法验证」清单，**不会**给出假的通过结论。
