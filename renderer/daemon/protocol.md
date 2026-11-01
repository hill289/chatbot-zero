# 端侧 Agent Daemon 协议（A 档 · 模块 5.2）

> 目标：把「计算」与「执行环境」解耦。Agent Loop（Router/Worker 推理）可在主进程或远端；
> 真实命令/文件操作由**端侧 daemon** 按本协议执行。daemon **不持任何会话状态**，随时可重启。

## 传输

- 本机 A 档：daemon = Electron 主进程内的本地子进程（复用 `sandbox-policy` 的 `spawnSandboxed`）。
- 远端 B 档（后续）：同一协议，经 WebSocket / stdio 连接各设备 daemon；BYOM = 接入用户某台机器。
- 每消息是一条 JSON（单行）。

## 请求 `Request`

```json
{ "v": "1", "id": 123, "op": "exec", "args": { "command": "npm test", "cwd": "." } }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | string | 协议版本（当前 `"1"`） |
| `id` | number\|string | 请求关联 id（响应原样回传） |
| `op` | string | 操作：`exec` / `readFile` / `writeFile` / `listDir` / `ping` |
| `args` | object | 操作参数 |

### op 语义

- `exec` → `{ command, cwd?, timeoutMs?, env? }`：在隔离沙箱执行命令，返回 `{ code, stdout, stderr }`。
- `readFile` → `{ path }`：返回 `{ data(base64), eol? }`。
- `writeFile` → `{ path, data(base64) }`：返回 `{ bytes }`。
- `listDir` → `{ path }`：返回 `{ entries:[{name,dir,size}] }`。
- `ping` → `{}`：返回 `{ pong:true, version }`（健康检查）。

## 响应 `Response`

```json
{ "v": "1", "id": 123, "ok": true, "result": { "code": 0, "stdout": "…", "stderr": "" } }
```

失败：

```json
{ "v": "1", "id": 123, "ok": false, "error": "timeout" }
```

## 约束

1. **无状态**：daemon 不保存会话/对话；每次请求自包含。恢复靠主进程读 `messages/<sid>/events.jsonl`。
2. **审批与沙箱不可绕过**：`exec` 在 daemon 侧仍走 `sandbox-policy`（fail-closed）；危险命令拒绝。
3. **模型透明**：A 档下 `run_shell` 对模型仍是「一次请求/响应」，行为不变。

## 编解码

见 `renderer/daemon/agentd.js`（`makeRequest` / `parseRequest` / `makeResponse` / `parseResponse` / `isOp`，纯逻辑，可单测）。
