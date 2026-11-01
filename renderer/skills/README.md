# 技能层 · Skills（SKILL.md）

给「chatbot-zero」补上**一等公民的技能体系**：把「方法论 + 输出模板 + 工具白名单 + 规则」
打包成标准 `SKILL.md`，让模型按手册干活，而不是每次从头推理。

> 兼容 **OpenClaw / WorkBuddy** 的 `SKILL.md` 生态（可双向导入导出），但宿主是你自己的、可离线的工作台。

```
renderer/skills/
├── skill-store.js       # 纯逻辑：SKILL.md 解析(front-matter) + 校验 + 存储(localStorage/内存)
├── skill-compose.js     # 编译：激活技能 → system 片段（确定性、前缀缓存友好）
├── builtin-skills.js    # 内置技能（weekly-report / meeting-minutes / data-report）
├── skill-bootstrap.js   # 接线：注册 skill_* 工具 + getSystem 追加 + 变更失效
├── skills-ui.js         # 面板（🧩）：技能库 / 启停 / 导入导出 / 查看
├── skill-layer.test.js  # Node 自检（零依赖）
└── README.md
```

## SKILL.md 规范

```markdown
---
name: weekly-report
description: 根据本周工作记录生成结构化周报
version: 1
toolWhitelist: [read_file, write_file, markdown_to_pdf]
rules:
  - 数据必须来自实际记录，不得编造
outputTemplate: |
  # 周报（{{week}}）
  ## 本周成果
  ## 下周计划
---
## 适用场景
## 执行步骤
1. ...
```

- `name` / `description` 必填；`toolWhitelist` / `rules` / `outputTemplate` 可选。
- 正文（`---` 之后）= 方法论，会一并进 system 片段。

## 接线（零侵入，不改 07-mcp.js）

- `skill-bootstrap.js` 包一层 `prefixManager.getSystem()`，把**已启用技能**编译的片段追加到 system 末尾；
  **只改对话之外的前缀**，技能集合变化时 `invalidateSystem()`（一次 cache miss），之后保持**字节稳定**。
- 注册 `skill_*` 工具（走 `window.registerTool` → 可插拔注册表），自动进入工具循环与工具指纹。

| 工具 | 作用 |
|---|---|
| `skill_list` | 列出技能库（含启用状态） |
| `skill_get` | 读取某技能完整 SKILL.md |
| `skill_install` | 安装技能（`text` / `path` / `url`） |
| `skill_create` | 创建技能（自动组装 SKILL.md） |
| `skill_toggle` | 启用 / 停用技能 |

## 面板

工具箱 🧩 → 技能库：启用开关、查看 SKILL.md、导入（粘贴/JSON）、导出全部、删除。

## 前缀缓存说明

`skill-compose.composeSystem()` **按 name 排序 + 固定分隔符**，保证同一技能集合产出**逐字节相同**的文本；
因此「启用一次技能」只造成**一次** cache miss，之后持续命中。

## 测试

```bash
node renderer/skills/skill-layer.test.js
```
