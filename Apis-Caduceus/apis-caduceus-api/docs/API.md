# Apis Caduceus — API 参考文档

> 版本：1.0.5 · 所有管理接口均需携带 `Authorization: Bearer <PROXY_API_KEY>` 请求头

---

## 目录

1. [推理代理接口](#1-推理代理接口)
2. [子 Key 管理](#2-子-key-管理)
3. [安全与封禁](#3-安全与封禁)
4. [日志与状态](#4-日志与状态)

---

## 认证说明

Apis Caduceus 使用单一密钥认证：

- **管理员操作**：使用自身的 `PROXY_API_KEY` 环境变量值
- **推理接口**：使用 `PROXY_API_KEY`，或通过子 Key 管理接口生成的子 Key（`sk-` 前缀）
- **来自 Mercury Hermes 主节点的转发请求**：Hermes 转发时以自身的 `PROXY_API_KEY` 为 Bearer Token。因此，**Hermes 与 Caduceus 的 `PROXY_API_KEY` 必须设置为完全相同的值**，否则 Caduceus 将返回 403 拒绝请求。

---

## 1. 推理代理接口

Apis Caduceus 专为 Anthropic Claude 代理优化，支持 OpenAI 兼容格式与 Anthropic 原生格式两种接口。

### `POST /v1/chat/completions`（OpenAI 兼容）

标准 OpenAI 格式聊天补全接口，兼容 SillyTavern、Open WebUI 等客户端。

```http
POST /v1/chat/completions
Authorization: Bearer <your_api_key>
Content-Type: application/json

{
  "model": "claude-opus-4-5",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": true
}
```

**消息格式处理**：Caduceus 自动处理以下消息格式兼容：

- 移除尾部空白 assistant 消息
- 从尾部非空 assistant 消息中提取角色前缀（SillyTavern prefill 场景）
- 确保最终消息以 user 角色结尾（Anthropic API 要求）
- SillyTavern 兼容模式下自动补充 `继续` 消息

**当请求来自 Hermes 主节点转发时**：Caduceus 收到的是客户端原始消息（Hermes 不做预处理），Caduceus 自行负责所有格式兼容处理。

### `POST /v1/messages`（Anthropic 原生）

Anthropic Messages API 原生格式，适合直接对接 Anthropic SDK 或 SillyTavern Anthropic 模式。

```http
POST /v1/messages
Authorization: Bearer <your_api_key>
Content-Type: application/json

{
  "model": "claude-opus-4-5",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

### 思考模式模型别名

| 别名 | 效果 |
|---|---|
| `<model>-thinking` | 启用扩展思考，思考过程不包含在响应内容中 |
| `<model>-thinking-visible` | 启用扩展思考并将思考内容一并返回 |

示例：`claude-sonnet-4-5-thinking`、`claude-opus-4-5-thinking-visible`

### 工具调用（Tool Calling）

支持完整的 OpenAI 工具调用格式（`tools` / `tool_choice`），Caduceus 自动转换为 Anthropic 原生格式。代码执行类工具名称（如 `python`、`execute_code` 等）会被自动识别并剥离，来源 IP 同时被封禁。

---

## 2. 子 Key 管理

Caduceus 拥有独立的子 Key 系统，可为下游客户端生成专属密钥，无需共享 `PROXY_API_KEY`。

### `GET /api/admin/subkeys`（需管理员）

列出所有已生成的子 Key（脱敏展示）。

```json
{
  "keys": [
    {
      "id": "uuid",
      "label": "客户端标签",
      "maskedKey": "sk-****xxxx",
      "createdAt": "2026-04-10T...",
      "enabled": true
    }
  ]
}
```

### `POST /api/admin/subkeys`（需管理员）

生成新子 Key（仅在响应中返回明文一次）。

```json
{ "label": "客户端A" }
```

**响应**：

```json
{
  "ok": true,
  "key": "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
  "label": "客户端A"
}
```

### `DELETE /api/admin/subkeys/:id`（需管理员）

删除指定子 Key 并立即失效。

### `PATCH /api/admin/subkeys/:id`（需管理员）

启用或禁用子 Key。

```json
{ "enabled": false }
```

### `POST /api/admin/subkeys/bulk`（需管理员）

批量启用/禁用子 Key。

```json
{ "ids": ["id1", "id2"], "enabled": true }
```

---

## 3. 安全与封禁

### `GET /api/admin/banned-ips`（需管理员）

列出封禁 IP 列表。

### `POST /api/admin/ban-ip`（需管理员）

手动封禁 IP。

```json
{ "ip": "1.2.3.4", "reason": "滥用" }
```

### `DELETE /api/admin/ban-ip/:ip`（需管理员）

解封指定 IP。

> 本地回环地址与 RFC 1918 私有地址永久豁免封禁。

---

## 4. 日志与状态

### `GET /api/admin/logs`（需管理员）

返回最近请求日志数组。每条日志包含：时间戳、请求 IP、模型、Token 使用量、耗时、状态码。

### `GET /api/admin/logs/stream`（需管理员）

Server-Sent Events 实时日志流。

### `GET /api/version`（公开）

返回 Caduceus 版本信息。

```json
{
  "version": "1.0.5",
  "releaseDate": "2026-04-10"
}
```

---

## 错误码

| HTTP 状态码 | 含义 |
|---|---|
| 400 | 请求体格式错误 |
| 401 | 未提供 Authorization 头 |
| 403 | Key 无效、已禁用，或与 Hermes 的 PROXY_API_KEY 不匹配 |
| 404 | 资源不存在 |
| 429 | 频率超限 |
| 500 | 服务器内部错误 |
| 503 | 无可用 Anthropic 后端 |
