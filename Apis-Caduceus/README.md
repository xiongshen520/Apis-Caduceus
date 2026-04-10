# Mercury Hermes

**Mercury Hermes** 是一个统一的 AI 代理网关，支持多提供商路由、子节点分发和深度 SillyTavern 兼容，以闭源形式分发。

---

## 声明与致谢

本项目参考并基于 **[ReplitApi](https://github.com/replit/ReplitAPI)** 开发，在其架构思路与接口设计上受到了重要启发。特此鸣谢原作者及所有贡献者的开创性工作。

> This project is inspired by and built upon concepts from **ReplitApi**. We sincerely thank the original authors for their foundational work.

---

## 功能特性

- **多提供商路由**：OpenAI · Anthropic Claude · Google Gemini · OpenRouter 自动路由
- **SillyTavern 深度兼容**：自动修复 Claude 接口的 user/assistant 交替限制
- **Claude 官方格式**：直接调用 Anthropic SDK，最大回复 64,000 tokens，最低 4,096 tokens
- **子节点管理**：动态添加好友代理节点（支持 ENV 永久节点 `HERMES_FRIEND_NODES`）
- **假流式输出（fakeStream）**：子节点返回 JSON 时自动转换为 SSE 逐字流
- **IP 伪装**：对外转发请求时自动注入随机 X-Forwarded-For，请求结束即销毁
- **IP 永久封禁**：检测到 openClaw、代码执行类工具（bash/python/shell 等）自动封 IP
- **API 子 Key 生成**：项目拥有者可生成分发给团队成员的子 Key，子 Key 无管理员权限
- **安全管理控制台**：IP 封禁列表查看、手动封/解封、导出/导入；子 Key 生成与吊销
- **实时日志（LiveFeed）**：SSE 推送请求记录，含 USD 费用估算
- **模型管理（ModelVault）**：按提供商启用/禁用模型，支持模型分组
- **统计报表**：按后端/模型分类的调用次数、Token 消耗、估算费用

---

## 部署要求

- Replit 账号，已配置以下 AI Integrations：
  - `AI_INTEGRATIONS_ANTHROPIC_*`
  - `AI_INTEGRATIONS_OPENAI_*`
  - `AI_INTEGRATIONS_GEMINI_*`
  - `AI_INTEGRATIONS_OPENROUTER_*`
- Replit Secrets 中配置：
  - `PROXY_API_KEY` — 项目拥有者主密钥（管理员权限）
  - `SESSION_SECRET` — 会话密钥
  - `HERMES_FRIEND_NODES`（可选）— 永久子节点 URL 列表，逗号分隔

---

## 快速开始

```bash
# 解压发行包
tar -xzf mercury-hermes-*.tgz
cd mercury-hermes

# 安装依赖（需 pnpm）
pnpm install

# 启动（开发模式）
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/control-panel run dev
```

控制面板默认地址：`http://localhost:23401`
API 网关地址：`http://localhost:8080`
OpenAI 兼容接入点：`{网关地址}/v1/chat/completions`

---

## API 认证

所有 `/v1/*` 和 `/api/*` 端点均需 Bearer Token 认证：

```
Authorization: Bearer your_key_name
```

- `PROXY_API_KEY`：拥有全部权限（含管理端点）
- 子 Key（`hk-` 前缀）：可调用 AI 接口，无法访问管理端点

---

## 管理端点（仅 PROXY_API_KEY）

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/admin/bans` | 查看全部封禁 IP |
| POST | `/api/admin/bans` | 手动封禁 IP |
| DELETE | `/api/admin/bans/:ip` | 解封单个 IP |
| GET | `/api/admin/bans/export` | 导出封禁列表（JSON） |
| POST | `/api/admin/bans/import` | 导入封禁列表 |
| GET | `/api/admin/keys` | 查看全部子 Key（脱敏） |
| POST | `/api/admin/keys` | 生成新子 Key |
| DELETE | `/api/admin/keys/:id` | 吊销子 Key |

---

## ENV 永久节点

在 Replit Secrets 中配置 `HERMES_FRIEND_NODES`，值为逗号分隔的节点 URL：

```
HERMES_FRIEND_NODES=https://node1.replit.app,https://node2.replit.app
```

ENV 节点在每次服务启动时自动加载，Publish 后不会丢失，优先级高于动态添加的节点。

---

## 超时设置

- 流式请求（`stream: true`）：**600 秒**
- 非流式请求：**120 秒**

---

## 许可

本项目为闭源分发，不公开源代码。如需商业授权，请联系项目维护者。

---

*Mercury Hermes — 速若信使，路由如翼*
