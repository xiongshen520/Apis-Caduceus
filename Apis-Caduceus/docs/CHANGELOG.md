# Apis Caduceus — 更新日志

---

## v1.0.7 · 2026-04-10

### 修复

- **思考模式流式顺序 Bug（`-thinking-visible`）**：原实现在 `message_stop` 事件时才整体追加 `<think>...</think>` 块，导致客户端先收到完整响应文本，最后才看到思考内容——顺序颠倒。改为通过 `content_block_start/stop` 事件实时开合 `<think>` 标签，思考内容与文本内容均按 Anthropic 原生流事件顺序逐 token 输出，`-thinking-visible` 模型现在先流式展示思考过程，再展示最终回复。

### 优化

- **控制面板缓存头同步**：`index.html` 补全 `Cache-Control: no-store` / `Pragma: no-cache` meta 标签；`vite.config.ts` 开发服务器添加 `no-store` 响应头，与 Mercury Hermes 面板行为保持一致。

### 文档

- **版本号修复**：`app.ts` `VERSION` 常量从 `"1.0.6"` 更新至 `"1.0.7"`（历史补丁应用后版本号曾未随代码一同递增）。
- **CHANGELOG 补全**：本文件补录 v1.0.7 所有变更。

---

## v1.0.6 · 2026-04-10

### 优化

- **控制面板移动端适配**：Dashboard 统计卡片在移动端（`isMobile` 模式）使用更紧凑的内边距和字号，避免三列布局在小屏幕上过于拥挤。

### 文档

- 全面重写 `README.md`：补充与 Mercury Hermes 的关系说明、完整 API 端点列表、`PROXY_API_KEY` 共用要求、目录结构。

---

## v1.0.5 · 2026-04-10

### 文档

- 全面重写 `docs/API.md`：
  - 新增「认证说明」章节，明确 Hermes ↔ Caduceus 共用 `PROXY_API_KEY` 的要求
  - 补充消息格式处理说明：Hermes 转发时不预处理消息，由 Caduceus 自行处理格式兼容
  - 完善工具调用、思考模式模型别名说明
  - 错误码表补充 403 的 Hermes 互信失败场景说明
- 全面重写 `docs/CHANGELOG.md`（本文件）

---

## v1.0.4 · 2026-04-10

### 修复

- **认证统一**：
  - 移除 `CADUCEUS_INBOUND_KEY` 独立入站密钥机制
  - `authGuard` 恢复简单的 `PROXY_API_KEY` 比对
  - 加 `.trim()`，防止环境变量尾部空格导致认证失败
  - Caduceus 与 Hermes 主节点共用同一 `PROXY_API_KEY` 进行互信，无需任何额外配置

---

## v1.0.3 · 2026-04-10

### 新功能

- **完整工具调用支持（Tool Calling）**：
  - 支持 OpenAI 格式的 `tools` / `tool_choice` 参数
  - 自动转换为 Anthropic 原生工具格式
  - `convertToolChoiceForClaude()` 处理 `tool_choice` 枚举差异（`auto` / `any` / `none`）
  - 代码执行类工具名称（`python`、`execute_code` 等）自动检测、剥离，来源 IP 封禁

- **流式响应改进**：
  - `flushHeaders()` 在第一帧发送前调用，减少客户端 TTFB
  - SSE Keepalive 心跳行，防止反向代理在长时间无输出时超时断开

- **Anthropic 参数兼容**：
  - `temperature` 与 `top_p` 互斥传递（Anthropic API 限制，同时传入会报错）
  - `max_tokens` 默认值修复

---

## v1.0.2 · 2026-04-10

### 新功能

- **原生 Anthropic 消息格式**：新增 `POST /v1/messages`，直接接受 Anthropic 原生请求格式，适合 SillyTavern Anthropic 模式直连
- **思考模式支持**：`-thinking` / `-thinking-visible` 模型别名，启用 Claude 扩展思考（Extended Thinking）

### 修复

- 修复 `/v1` 路径路由，避免 SillyTavern 收到 `<!DOCTYPE` HTML 响应

---

## v1.0.1 · 2026-04-09

- SillyTavern 兼容模式改进：自动提取 assistant prefill，补充 `继续` 消息
- 本地 IP 永久豁免封禁（RFC 1918 私有地址段）

---

## v1.0.0 · 2026-04-07

- Apis Caduceus 叶节点首次发布
- 作为 Mercury Hermes 分布式网关的叶节点
- Anthropic Claude 多模型代理（Opus / Sonnet / Haiku）
- OpenAI 兼容接口（`/v1/chat/completions`）
- 子 Key 管理系统（独立于 Mercury Hermes）
- IP 封禁防滥用
- 实时日志 SSE
- 调用统计持久化
- 独立管理面板（端口 3001）
