# Apis Caduceus

**Apis Caduceus** 是 [Mercury Hermes](https://github.com/AliceSao/Mercury-Hermes) 的轻量化子节点版本。
提供统一 AI 代理网关功能，完全兼容 SillyTavern，可作为独立部署的个人/团队 AI 代理节点。

---

## 特性

- **多提供商路由**：Anthropic / OpenAI / Gemini / OpenRouter 自动路由
- **SillyTavern 完全兼容**：OpenAI API 格式，即插即用
- **扩展思考支持**：Claude / Gemini 思考模式，支持隐藏/可见两种形态
- **IP 自动封禁**：检测恶意模式，自动屏蔽，支持手动解封
- **智能超时**：流式 600s / 非流式 120s
- **IP 伪装**：对外请求随机化源 IP，保护节点隐私
- **实时控制台**：含控制台、模型列表、实时日志，支持手机端

## 不包含的功能（对比主项目 Mercury Hermes）

- 子节点网络（NetworkHub / 友节点管理）
- API 子 Key 生成（子节点本身就是子 Key 分发对象）
- 模型分组管理
- 更新检查器

---

## 快速开始（Replit 部署）

### 1. Fork 到 Replit

Fork 本仓库，在 Replit 项目中打开。

### 2. 配置 AI Integrations

在 Replit 项目设置 → **AI Integrations** 中开启需要的服务商：

| 服务商 | Integration 名称 |
|--------|-----------------|
| Anthropic Claude | Anthropic |
| OpenAI GPT | OpenAI |
| Google Gemini | Gemini |
| OpenRouter | OpenRouter |

开启后 Replit 自动注入以下环境变量（无需手动填写）：
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY` / `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`
- `AI_INTEGRATIONS_OPENAI_API_KEY` / `AI_INTEGRATIONS_OPENAI_BASE_URL`
- `AI_INTEGRATIONS_GEMINI_API_KEY` / `AI_INTEGRATIONS_GEMINI_BASE_URL`
- `AI_INTEGRATIONS_OPENROUTER_API_KEY` / `AI_INTEGRATIONS_OPENROUTER_BASE_URL`

### 3. 配置 Secrets

在 Replit **Secrets** 面板中添加：

```
PROXY_API_KEY = <自定义鉴权密钥>
```

> 不要使用简单密码，这是所有 API 接口的唯一鉴权凭据。

### 4. 启动

点击 **Run**，两个服务自动启动：
- API Server：端口 8082
- 控制台 Panel：端口 3001

### 5. SillyTavern 配置

| 字段 | 值 |
|------|----|
| API 类型 | Chat Completion → OpenAI |
| 端点 | `https://your-node.replit.app/v1` |
| API Key | 你设置的 `PROXY_API_KEY` |

---

## 本地部署

```bash
git clone https://github.com/AliceSao/Apis-Caduceus.git
cd Apis-Caduceus
pnpm install

# 构建 API Server
pnpm --filter @workspace/apis-caduceus-api run build

# 启动（需要手动设置环境变量）
PROXY_API_KEY=your_key \
AI_INTEGRATIONS_ANTHROPIC_API_KEY=sk-ant-... \
AI_INTEGRATIONS_ANTHROPIC_BASE_URL=https://api.anthropic.com \
AI_INTEGRATIONS_OPENAI_API_KEY=sk-... \
AI_INTEGRATIONS_OPENAI_BASE_URL=https://api.openai.com/v1 \
PORT=8082 node apis-caduceus-api/dist/index.mjs

# 控制台（另一个终端）
PORT=3001 pnpm --filter @workspace/apis-caduceus-panel run dev
```

---

## 接口说明

| 接口 | 描述 |
|------|------|
| `GET /api/healthz` | 健康检查（无需鉴权） |
| `GET /api/version` | 版本信息（无需鉴权） |
| `GET /v1/models` | 模型列表（需鉴权） |
| `POST /v1/chat/completions` | 代理转发，流式/非流式（需鉴权） |
| `GET /api/stats` | 统计数据（需鉴权） |
| `GET /api/logs` | 请求日志（需鉴权） |

**鉴权方式（三选一）：**
```
Authorization: Bearer <PROXY_API_KEY>
x-goog-api-key: <PROXY_API_KEY>
?key=<PROXY_API_KEY>
```

---

## 目录结构

```
├── apis-caduceus-api/       # API Server (Node.js + Express + esbuild)
│   ├── src/
│   │   ├── index.ts         # 入口
│   │   ├── app.ts           # Express 应用 + 路由注册
│   │   ├── dispatch.ts      # 路由调度 + 四家提供商处理
│   │   └── lib/
│   │       ├── ip-ban.ts    # IP 封禁
│   │       ├── store.ts     # 数据持久化
│   │       └── logger.ts    # 日志
│   └── build.mjs            # 构建脚本
└── apis-caduceus-panel/     # 控制台 (React + Vite)
    └── src/
        └── App.tsx          # 控制台 UI（控制台/模型/实时日志）
```

---

## 许可证

本项目为私有闭源项目。未经授权不得分发、修改或商业使用。

---

*子节点 · 轻量 · 即插即用*
