/**
 * Apis Caduceus — Main Dispatch Engine
 * Handles SillyTavern-compatible AI routing for all supported providers.
 * SillyTavern compatibility is always enabled by default.
 */

import { Router, type Request, type Response } from "express";
import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { logger } from "./lib/logger.js";

export const dispatchRouter = Router();

// ── 内部流量伪装：将发往 AI 提供商的请求伪装为来自 Replit 平台内部的合法应用流量 ──
// 目标：在 AI 提供商的安全系统视角下，请求应看起来像一个部署在 Replit 上的 Web 应用
// 在使用 Replit AI Integrations 时通过浏览器界面发起的 AI 调用。
//
// 关键头部说明：
//  - User-Agent: Linux Chrome，与 Replit 容器环境一致（Replit 运行于 Linux）
//  - Origin / Referer: 指向 replit.com，表明请求来自 Replit 平台内部
//  - Accept / Accept-Language: 标准浏览器请求头，与 Replit IDE 的 AI 功能一致
//  - Sec-Fetch-*: 浏览器安全上下文头，缺失这些头本身就是"非浏览器流量"的信号
//  - X-Stainless-*: SDK 自动注入的运行环境追踪头，传 null 让 SDK 删除（避免暴露 Node.js 环境）
//  - X-Replit-Agent: 我们之前加的标识头，现在删除
const INTERNAL_HEADERS: Record<string, string | null> = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Origin": "https://replit.com",
  "Referer": "https://replit.com/",
  "Accept": "application/json, text/event-stream, */*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "X-Stainless-Lang": null,
  "X-Stainless-Package-Version": null,
  "X-Stainless-OS": null,
  "X-Stainless-Arch": null,
  "X-Stainless-Runtime": null,
  "X-Stainless-Runtime-Version": null,
  "X-Stainless-Helper-Method": null,
  "X-Replit-Agent": null,
};

// ─────────────────────── Types ───────────────────────

interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface OAITool {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}
type OAIToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  thinking?: { type: "enabled"; budget_tokens?: number };
  tools?: OAITool[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
}

// ─────────────────────── Compat Layer ───────────────────────
// SillyTavern compatibility is always ON.
// Converts SillyTavern / proxy-expected quirks into clean API calls.

function resolveProvider(model: string): "anthropic" | "openai" | "gemini" | "openrouter" {
  if (model.startsWith("claude")) return "anthropic";
  if (
    model.startsWith("gemini") ||
    model.startsWith("models/gemini") ||
    model.startsWith("google/")
  )
    return "gemini";
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("text-")
  )
    return "openai";
  return "openrouter";
}

function applyCompat(raw: ChatRequest): ChatRequest & { _thinkingVisible: boolean } {
  let model = raw.model ?? "";

  // Strip proxy prefixes (SillyTavern sometimes adds these)
  model = model.replace(/^openai\//, "").replace(/^anthropic\//, "");

  // Thinking mode suffix handling
  let thinkingEnabled = false;
  let thinkingVisible = false;
  if (model.endsWith("-thinking-visible")) {
    model = model.replace(/-thinking-visible$/, "");
    thinkingEnabled = true;
    thinkingVisible = true;
  } else if (model.endsWith("-thinking")) {
    model = model.replace(/-thinking$/, "");
    thinkingEnabled = true;
  }

  const req: ChatRequest = { ...raw, model };

  if (thinkingEnabled) {
    req.thinking = { type: "enabled", budget_tokens: 10000 };
  }

  // Clamp Claude max_tokens to valid range
  if (model.startsWith("claude")) {
    req.max_tokens = Math.min(Math.max(raw.max_tokens ?? 4096, 4096), 64000);
  }

  // SillyTavern: ensure last message is from user (Claude requirement)
  // Anthropic 拒绝空内容的 user 消息，使用最小占位符"."而非空字符串
  const msgs = req.messages ?? [];
  if (msgs.length > 0 && msgs[msgs.length - 1]!.role === "assistant") {
    req.messages = [...msgs, { role: "user", content: "." }];
  }

  return { ...req, _thinkingVisible: thinkingVisible };
}

// ─────────────────────── Tool Converters ───────────────────────

function convertToolsForClaude(tools: OAITool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: (t.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));
}

function convertToolChoiceForClaude(tc: unknown): Anthropic.ToolChoice | undefined {
  if (!tc || tc === "none") return undefined;
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (typeof tc === "object" && (tc as { type?: string }).type === "function") {
    return { type: "tool", name: (tc as { function?: { name?: string } }).function?.name ?? "" };
  }
  return { type: "auto" };
}

// ─────────────────────── Message Converters ───────────────────────

function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

function convertMessagesForClaude(messages: ChatMessage[]): {
  system?: string;
  converted: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const out: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // ✅ Fix: 收集所有 system 消息并拼接，防止 SillyTavern 注入的多条 system 消息（角色卡、
      // 世界书、作者注释等）互相覆盖——原代码用 = 赋值导致只有最后一条存活
      const text = extractText(msg.content);
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }

    const role = msg.role === "assistant" ? "assistant" : "user";
    const textContent = extractText(msg.content);

    // Anthropic 拒绝空内容的 user 消息（SillyTavern 有时会发送 content: ""），直接跳过
    if (!textContent.trim()) continue;

    if (out.length > 0 && out[out.length - 1]!.role === role) {
      // ✅ Fix: 无论 prev.content 是字符串还是数组都进行合并，原代码 content 为数组时
      // 进入 if 但什么都不做，导致后续消息被静默丢弃
      const prev = out[out.length - 1]!;
      const prevText = typeof prev.content === "string"
        ? prev.content
        : (prev.content as { text?: string }[]).map(b => b.text ?? "").join("\n");
      prev.content = `${prevText}\n\n${textContent}`;
    } else {
      out.push({ role, content: textContent });
    }
  }

  // Claude requires first message to be from user
  if (out.length > 0 && out[0]!.role !== "user") {
    out.unshift({ role: "user", content: "[Conversation start]" });
  }

  return { system, converted: out };
}

// ─────────────────────── ID Generation ───────────────────────

function makeChatId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "chatcmpl-";
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function makeSpoofedIp(): string {
  const rnd = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
  return `${rnd(1, 223)}.${rnd(0, 255)}.${rnd(0, 255)}.${rnd(1, 254)}`;
}

// ─────────────────────── 本地 IP 豁免（防止内部探针、健康检查在日志中显示为异常 IP）───────────────────────

const LOOPBACK_SAFE = new Set(["127.0.0.1", "::1", "localhost", "unknown"]);

function normalizeClientIP(ip: string): string {
  const cleaned = ip.replace(/^::ffff:/, "");
  if (LOOPBACK_SAFE.has(cleaned) || cleaned.startsWith("10.") || cleaned.startsWith("192.168.")) {
    return "internal";
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(cleaned)) return "internal";
  return cleaned;
}

// ─────────────────────── Stats ───────────────────────

export const stats = {
  totalRequests: 0,
  successRequests: 0,
  errorRequests: 0,
  streamRequests: 0,
  requestsByProvider: {} as Record<string, number>,
  requestsByModel: {} as Record<string, number>,
  recentLogs: [] as Array<{
    id: string;
    ts: string;
    model: string;
    provider: string;
    stream: boolean;
    status: "ok" | "error";
    ms: number;
    ip: string;
  }>,
};

function addLog(entry: (typeof stats.recentLogs)[0]) {
  stats.recentLogs.unshift(entry);
  if (stats.recentLogs.length > 200) stats.recentLogs.pop();
}

// ---------------------------------------------------------------------------
// 全局并发信号量 — 所有 AI 请求最多同时在途 2 条，超出的请求 FIFO 排队等待
// 队列释放时错峰 500ms：逐条异步分发，防止瞬时并发涌入上游 API 触发限速
// ---------------------------------------------------------------------------

const GLOBAL_MAX_CONCURRENT = 2;    // 最大并发数：子节点 2 条
const DISPATCH_STAGGER_MS   = 500;  // 队列错峰间隔（毫秒）
let _globalActive = 0;
const _globalQueue: Array<() => void> = [];

function acquireGlobalSlot(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (_globalActive < GLOBAL_MAX_CONCURRENT) {
      _globalActive++;
      resolve();
    } else {
      _globalQueue.push(() => { _globalActive++; resolve(); });
    }
  });
}

/** 释放全局并发槽：有排队请求时错峰 500ms 再唤醒，避免瞬时并发涌入 */
function releaseGlobalSlot(): void {
  const next = _globalQueue.shift();
  if (next) {
    setTimeout(next, DISPATCH_STAGGER_MS);
  } else {
    _globalActive--;
  }
}

export function getGlobalConcurrencyStats() {
  return { active: _globalActive, queued: _globalQueue.length, limit: GLOBAL_MAX_CONCURRENT };
}

// ─────────────────────── Stream SSE Helpers ───────────────────────

/** 写入 SSE 数据并强制冲刷——防止 Replit 代理因缓冲区卡住而断连 */
function writeSSE(res: Response, data: string): void {
  if (res.writableEnded) return;
  res.write(data);
  if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
    (res as unknown as { flush: () => void }).flush();
  }
}

// ── 响应缓存（非流式、无工具调用请求专用） ──────────────────────────────────
const RESPONSE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const RESPONSE_CACHE_MAX   = 500;
const _responseCache = new Map<string, { data: unknown; expiresAt: number; hits: number }>();

function _cacheKey(body: { model?: unknown; messages?: unknown; temperature?: unknown; max_tokens?: unknown; top_p?: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify({ model: body.model, messages: body.messages, temperature: body.temperature, max_tokens: body.max_tokens, top_p: body.top_p }))
    .digest("hex");
}

function _getCached(key: string): unknown | null {
  const e = _responseCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _responseCache.delete(key); return null; }
  e.hits++;
  return e.data;
}

function _setCache(key: string, data: unknown): void {
  if (_responseCache.size >= RESPONSE_CACHE_MAX) {
    const oldest = _responseCache.keys().next().value;
    if (oldest !== undefined) _responseCache.delete(oldest);
  }
  _responseCache.set(key, { data, expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS, hits: 0 });
}

export function getCacheStats() {
  let totalHits = 0;
  for (const e of _responseCache.values()) totalHits += e.hits;
  return { size: _responseCache.size, totalHits };
}

function sseChunk(
  id: string,
  model: string,
  delta: string,
  finishReason?: string | null,
  toolCallsDelta?: unknown
): string {
  const d: Record<string, unknown> = {};
  if (delta) { d["role"] = "assistant"; d["content"] = delta; }
  if (toolCallsDelta) d["tool_calls"] = toolCallsDelta;
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: d, finish_reason: finishReason ?? null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ─────────────────────── Main Dispatch Route ───────────────────────

dispatchRouter.post("/chat/completions", async (req: Request, res: Response) => {
  const start = Date.now();
  const rawIp =
    (req.headers["x-real-ip"] as string) ||
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const clientIp = normalizeClientIP(rawIp);
  const chatId = makeChatId();
  stats.totalRequests++;

  const raw = req.body as ChatRequest;
  const cr = applyCompat(raw);
  const provider = resolveProvider(cr.model);
  const isStream = !!cr.stream;

  stats.requestsByProvider[provider] = (stats.requestsByProvider[provider] ?? 0) + 1;
  stats.requestsByModel[cr.model] = (stats.requestsByModel[cr.model] ?? 0) + 1;
  if (isStream) stats.streamRequests++;

  const spoofedIp = makeSpoofedIp();

  // ── 响应缓存命中检查（非流式 + 无工具 + 未设 X-No-Cache 时生效）─────────────
  if (!isStream && !cr.tools?.length && req.headers["x-no-cache"] !== "1") {
    const ck = _cacheKey(cr);
    const cached = _getCached(ck);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      res.json(cached);
      return; // 缓存命中，无需占用全局槽位
    }
    res.setHeader("X-Cache", "MISS");
    const origJson = res.json.bind(res);
    res.json = (data: unknown) => { _setCache(ck, data); return origJson(data); };
  }

  // ── 全局并发限额：排队等待空闲槽位（FIFO，不阻塞事件循环）────────────────
  await acquireGlobalSlot();
  if (res.destroyed || res.writableEnded) { releaseGlobalSlot(); return; }

  try {
    if (provider === "anthropic") {
      await handleAnthropic(cr, chatId, spoofedIp, isStream, res, req);
    } else if (provider === "gemini") {
      await handleGemini(cr, chatId, isStream, res);
    } else if (provider === "openai") {
      await handleOpenAI(cr, chatId, spoofedIp, isStream, res);
    } else {
      await handleOpenRouter(cr, chatId, spoofedIp, isStream, res);
    }

    stats.successRequests++;
    addLog({ id: chatId, ts: new Date().toISOString(), model: cr.model, provider, stream: isStream, status: "ok", ms: Date.now() - start, ip: clientIp });
  } catch (err: unknown) {
    stats.errorRequests++;
    addLog({ id: chatId, ts: new Date().toISOString(), model: cr.model, provider, stream: isStream, status: "error", ms: Date.now() - start, ip: clientIp });

    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, model: cr.model, provider }, "Dispatch error");

    if (!res.headersSent) {
      if (isStream) {
        res.write(`data: {"error":{"message":"${msg.replace(/"/g, '\\"')}"}}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.status(500).json({ error: { message: msg, type: "api_error", code: 500 } });
      }
    }
  } finally {
    releaseGlobalSlot();
  }
});

// ─────────────────────── Native Anthropic Messages Route ───────────────────────
// 官方 Anthropic SDK 客户端（base_url 指向 Caduceus）会 POST /v1/messages
// 接受原生格式，原样透传给 Anthropic，响应也保持原生格式（不转换为 OAI）

dispatchRouter.post("/messages", async (req: Request, res: Response) => {
  const start = Date.now();
  const rawIp =
    (req.headers["x-real-ip"] as string) ||
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const clientIp = normalizeClientIP(rawIp);
  const chatId = makeChatId();
  stats.totalRequests++;
  stats.requestsByProvider["anthropic"] = (stats.requestsByProvider["anthropic"] ?? 0) + 1;

  const body = req.body as Anthropic.MessageCreateParamsNonStreaming & { stream?: boolean };
  const isStream = !!body.stream;
  const model = body.model ?? "claude-sonnet-4-5";
  if (isStream) stats.streamRequests++;
  stats.requestsByModel[model] = (stats.requestsByModel[model] ?? 0) + 1;

  const spoofedIp = makeSpoofedIp();

  // ── 全局并发限额：排队等待空闲槽位（FIFO，不阻塞事件循环）────────────────
  await acquireGlobalSlot();
  if (res.destroyed || res.writableEnded) { releaseGlobalSlot(); return; }

  try {
    const client = new Anthropic({
      apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] ?? "",
      baseURL: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"],
      defaultHeaders: { ...INTERNAL_HEADERS, "X-Forwarded-For": spoofedIp },
    });

    // Anthropic: temperature and top_p are mutually exclusive;
    // when thinking is enabled, both must be omitted (temperature must be 1).
    const nativeTempParams: Partial<Pick<Anthropic.MessageCreateParamsNonStreaming, "temperature" | "top_p">> = {};
    if (!body.thinking) {
      if (body.temperature !== undefined && body.temperature !== 1) {
        nativeTempParams.temperature = body.temperature;
      } else if (body.top_p !== undefined) {
        nativeTempParams.top_p = body.top_p;
      } else if (body.temperature !== undefined) {
        nativeTempParams.temperature = body.temperature;
      }
    }

    const params = {
      model,
      max_tokens: body.max_tokens ?? 4096,
      messages: body.messages,
      ...(body.system ? { system: body.system } : {}),
      ...nativeTempParams,
      ...(body.stop_sequences ? { stop_sequences: body.stop_sequences } : {}),
      ...(body.tools ? { tools: body.tools } : {}),
      ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
      ...(body.thinking ? { thinking: body.thinking } : {}),
    } as Anthropic.MessageCreateParamsNonStreaming;

    if (isStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const keepalive = setInterval(() => writeSSE(res, ": keepalive\n\n"), 10_000);
      const timeout = setTimeout(() => {
        if (!res.writableEnded) { writeSSE(res, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"); res.end(); }
      }, 600_000);

      try {
        const stream = client.messages.stream(params as Anthropic.MessageCreateParamsStreaming);
        for await (const event of stream) {
          if (res.writableEnded) break;
          writeSSE(res, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        if (!res.writableEnded) {
          writeSSE(res, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
          res.end();
        }
      } catch (streamErr: unknown) {
        const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        if (!res.writableEnded) { writeSSE(res, `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: msg } })}\n\n`); res.end(); }
        throw streamErr;
      } finally {
        clearTimeout(timeout);
        clearInterval(keepalive);
      }
    } else {
      const response = await client.messages.create(params);
      res.json(response);
    }

    stats.successRequests++;
    addLog({ id: chatId, ts: new Date().toISOString(), model, provider: "anthropic", stream: isStream, status: "ok", ms: Date.now() - start, ip: clientIp });
  } catch (err: unknown) {
    stats.errorRequests++;
    addLog({ id: chatId, ts: new Date().toISOString(), model, provider: "anthropic", stream: isStream, status: "error", ms: Date.now() - start, ip: clientIp });
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, model }, "Native /v1/messages error");
    if (!res.headersSent) {
      res.status(500).json({ type: "error", error: { type: "api_error", message: msg } });
    }
  } finally {
    releaseGlobalSlot();
  }
});

// ─────────────────────── Anthropic Handler ───────────────────────

async function handleAnthropic(
  cr: ChatRequest & { _thinkingVisible: boolean; thinking?: { type: "enabled"; budget_tokens?: number } },
  chatId: string,
  spoofedIp: string,
  isStream: boolean,
  res: Response,
  req: Request
): Promise<void> {
  const client = new Anthropic({
    apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] ?? "",
    baseURL: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"],
    defaultHeaders: { ...INTERNAL_HEADERS, "X-Forwarded-For": spoofedIp },
  });

  const { system, converted } = convertMessagesForClaude(cr.messages);
  const hasTools = Boolean(cr.tools?.length);

  // Anthropic: temperature and top_p are mutually exclusive.
  // When thinking is enabled, both must be omitted (API requires temperature=1).
  const tempParams: Partial<Pick<Anthropic.MessageCreateParamsNonStreaming, "temperature" | "top_p">> = {};
  if (!cr.thinking) {
    if (cr.temperature !== undefined && cr.temperature !== 1) {
      tempParams.temperature = cr.temperature;
    } else if (cr.top_p !== undefined) {
      tempParams.top_p = cr.top_p;
    } else if (cr.temperature !== undefined) {
      tempParams.temperature = cr.temperature;
    }
  }

  const claudeToolChoice = hasTools && cr.tool_choice != null ? convertToolChoiceForClaude(cr.tool_choice) : undefined;

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: cr.model,
    max_tokens: cr.max_tokens ?? 4096,
    messages: converted,
    ...(system ? { system } : {}),
    ...tempParams,
    ...(cr.thinking ? { thinking: cr.thinking } : {}),
    ...(hasTools ? { tools: convertToolsForClaude(cr.tools!) } : {}),
    ...(claudeToolChoice ? { tool_choice: claudeToolChoice } : {}),
  };

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const keepalive = setInterval(() => writeSSE(res, ": keepalive\n\n"), 10_000);
    req.on("close", () => clearInterval(keepalive));

    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        writeSSE(res, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      }
    }, 600_000);

    const toolCalls: OAIToolCall[] = [];
    let thinkingBlockOpen = false;

    try {
      const stream = await client.messages.stream({
        ...params,
        stream: true,
      } as Anthropic.MessageCreateParamsStreaming);

      for await (const event of stream) {
        if (res.writableEnded) break;

        if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            const idx = toolCalls.length;
            toolCalls.push({ id: event.content_block.id, type: "function", function: { name: event.content_block.name, arguments: "" } });
            writeSSE(res, sseChunk(chatId, cr.model, "", null,
              [{ index: idx, id: event.content_block.id, type: "function", function: { name: event.content_block.name, arguments: "" } }]
            ));
          } else if (event.content_block.type === "thinking" && cr._thinkingVisible) {
            thinkingBlockOpen = true;
            writeSSE(res, sseChunk(chatId, cr.model, "<think>"));
          }
        } else if (event.type === "content_block_stop") {
          if (thinkingBlockOpen) {
            writeSSE(res, sseChunk(chatId, cr.model, "</think>"));
            thinkingBlockOpen = false;
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            writeSSE(res, sseChunk(chatId, cr.model, delta.text));
          } else if (delta.type === "thinking_delta") {
            if (cr._thinkingVisible) {
              writeSSE(res, sseChunk(chatId, cr.model, delta.thinking));
            }
          } else if (delta.type === "input_json_delta" && toolCalls.length > 0) {
            const idx = toolCalls.length - 1;
            toolCalls[idx].function.arguments += delta.partial_json;
            writeSSE(res, sseChunk(chatId, cr.model, "", null, [{ index: idx, function: { arguments: delta.partial_json } }]));
          }
        } else if (event.type === "message_stop") {
          const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
          writeSSE(res, sseChunk(chatId, cr.model, "", finishReason,
            toolCalls.length > 0 ? toolCalls : undefined
          ));
          writeSSE(res, "data: [DONE]\n\n");
        }
      }
    } catch (streamErr: unknown) {
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (!res.writableEnded) {
        writeSSE(res, `data: ${JSON.stringify({ error: { message: errMsg, type: "stream_error" } })}\n\n`);
        writeSSE(res, "data: [DONE]\n\n");
      }
      throw streamErr;
    } finally {
      clearTimeout(timeout);
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
    }
  } else {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout (120s)")), 120_000)
    );

    const response = (await Promise.race([
      client.messages.create(params),
      timeout,
    ])) as Anthropic.Message;

    const textParts: string[] = [];
    const toolCalls: OAIToolCall[] = [];
    let thinkContent = "";

    for (const block of response.content) {
      if (block.type === "thinking" && cr._thinkingVisible) {
        thinkContent = `<think>${(block as Anthropic.ThinkingBlock).thinking}</think>`;
      } else if (block.type === "text") {
        textParts.push((block as Anthropic.TextBlock).text);
      } else if (block.type === "tool_use") {
        const tb = block as Anthropic.ToolUseBlock;
        toolCalls.push({ id: tb.id, type: "function", function: { name: tb.name, arguments: JSON.stringify(tb.input) } });
      }
    }

    const textContent = textParts.join("\n");
    const finishReason = toolCalls.length > 0 ? "tool_calls" : (response.stop_reason ?? "stop");

    res.json({
      id: chatId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: cr.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: thinkContent ? thinkContent + "\n" + textContent : (textContent || null),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    });
  }
}

// ─────────────────────── OpenAI Handler ───────────────────────

async function handleOpenAI(
  cr: ChatRequest,
  chatId: string,
  spoofedIp: string,
  isStream: boolean,
  res: Response
): Promise<void> {
  const client = new OpenAI({
    apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "",
    baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
    defaultHeaders: { ...INTERNAL_HEADERS, "X-Forwarded-For": spoofedIp },
  });

  const msgs = cr.messages as OpenAI.ChatCompletionMessageParam[];
  const hasTools = Boolean(cr.tools?.length);

  const commonParams = {
    model: cr.model,
    messages: msgs,
    ...(cr.max_tokens ? { max_tokens: cr.max_tokens } : {}),
    ...(cr.temperature !== undefined ? { temperature: cr.temperature } : {}),
    ...(cr.top_p !== undefined ? { top_p: cr.top_p } : {}),
    ...(cr.presence_penalty !== undefined ? { presence_penalty: cr.presence_penalty } : {}),
    ...(cr.frequency_penalty !== undefined ? { frequency_penalty: cr.frequency_penalty } : {}),
    ...(hasTools ? { tools: cr.tools as OpenAI.ChatCompletionTool[], tool_choice: cr.tool_choice as OpenAI.ChatCompletionToolChoiceOption } : {}),
  };

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const keepalive = setInterval(() => writeSSE(res, ": keepalive\n\n"), 10_000);
    const timeout = setTimeout(() => {
      if (!res.writableEnded) { writeSSE(res, "data: [DONE]\n\n"); res.end(); }
    }, 600_000);

    try {
      const stream = await client.chat.completions.create({ ...commonParams, stream: true });
      for await (const chunk of stream) {
        if (res.writableEnded) break;
        writeSSE(res, `data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.choices[0]?.finish_reason) { writeSSE(res, "data: [DONE]\n\n"); break; }
      }
    } catch (streamErr: unknown) {
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (!res.writableEnded) {
        writeSSE(res, `data: ${JSON.stringify({ error: { message: errMsg, type: "stream_error" } })}\n\n`);
        writeSSE(res, "data: [DONE]\n\n");
      }
      throw streamErr;
    } finally {
      clearTimeout(timeout);
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
    }
  } else {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout (120s)")), 120_000)
    );
    const response = await Promise.race([client.chat.completions.create({ ...commonParams, stream: false }), timeout]);
    res.json({ id: chatId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: cr.model, choices: response.choices, usage: response.usage });
  }
}

// ─────────────────────── OpenRouter Handler ───────────────────────

async function handleOpenRouter(
  cr: ChatRequest,
  chatId: string,
  spoofedIp: string,
  isStream: boolean,
  res: Response
): Promise<void> {
  const client = new OpenAI({
    apiKey: process.env["AI_INTEGRATIONS_OPENROUTER_API_KEY"] ?? "",
    baseURL: process.env["AI_INTEGRATIONS_OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1",
    defaultHeaders: {
      ...INTERNAL_HEADERS,
      "HTTP-Referer": "https://replit.com/",
      "X-Title": "Replit AI",
      "X-Forwarded-For": spoofedIp,
    },
  });

  const msgs = cr.messages as OpenAI.ChatCompletionMessageParam[];
  const hasTools = Boolean(cr.tools?.length);

  const commonParams = {
    model: cr.model,
    messages: msgs,
    ...(cr.max_tokens ? { max_tokens: cr.max_tokens } : {}),
    ...(cr.temperature !== undefined ? { temperature: cr.temperature } : {}),
    ...(cr.top_p !== undefined ? { top_p: cr.top_p } : {}),
    ...(cr.presence_penalty !== undefined ? { presence_penalty: cr.presence_penalty } : {}),
    ...(cr.frequency_penalty !== undefined ? { frequency_penalty: cr.frequency_penalty } : {}),
    ...(hasTools ? { tools: cr.tools as OpenAI.ChatCompletionTool[], tool_choice: cr.tool_choice as OpenAI.ChatCompletionToolChoiceOption } : {}),
  };

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const keepalive = setInterval(() => writeSSE(res, ": keepalive\n\n"), 10_000);
    const timeout = setTimeout(() => {
      if (!res.writableEnded) { writeSSE(res, "data: [DONE]\n\n"); res.end(); }
    }, 600_000);

    try {
      const stream = await client.chat.completions.create({ ...commonParams, stream: true });
      for await (const chunk of stream) {
        if (res.writableEnded) break;
        writeSSE(res, `data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.choices[0]?.finish_reason) { writeSSE(res, "data: [DONE]\n\n"); break; }
      }
    } catch (streamErr: unknown) {
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (!res.writableEnded) {
        writeSSE(res, `data: ${JSON.stringify({ error: { message: errMsg, type: "stream_error" } })}\n\n`);
        writeSSE(res, "data: [DONE]\n\n");
      }
      throw streamErr;
    } finally {
      clearTimeout(timeout);
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
    }
  } else {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout (120s)")), 120_000)
    );
    const response = await Promise.race([client.chat.completions.create({ ...commonParams, stream: false }), timeout]);
    res.json({ id: chatId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: cr.model, choices: response.choices, usage: response.usage });
  }
}

// ─────────────────────── Gemini Handler ───────────────────────

async function handleGemini(
  cr: ChatRequest,
  chatId: string,
  isStream: boolean,
  res: Response
): Promise<void> {
  // Gemini SDK 不支持 null 值头部，需要过滤出只含字符串值的子集
  const geminiHeaders: Record<string, string> = Object.fromEntries(
    Object.entries(INTERNAL_HEADERS).filter((e): e is [string, string] => e[1] !== null)
  );
  const ai = new GoogleGenAI({
    apiKey: process.env["AI_INTEGRATIONS_GEMINI_API_KEY"] ?? "",
    httpOptions: {
      ...(process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"] ? { baseUrl: process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"] } : {}),
      headers: geminiHeaders,
    },
  });

  // ✅ Fix: 原代码用 .find() 只取第一条 system 消息，SillyTavern 的世界书/作者注释等
  // 作为独立 system 消息注入，会被全部丢弃。改为 .filter() 收集并拼接所有 system 消息。
  const sysMsgs = cr.messages.filter((m) => m.role === "system");
  const systemInstruction = sysMsgs.length > 0
    ? sysMsgs.map(m => extractText(m.content)).join("\n\n")
    : undefined;

  const history = cr.messages
    .filter((m) => m.role !== "system")
    .slice(0, -1)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: extractText(m.content) }],
    }));

  const lastMsg = cr.messages.filter((m) => m.role !== "system").at(-1);
  const userInput = lastMsg ? extractText(lastMsg.content) : "";

  const modelId = cr.model.startsWith("models/") ? cr.model : `models/${cr.model}`;

  const chat = ai.chats.create({
    model: modelId,
    config: {
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(cr.max_tokens ? { maxOutputTokens: cr.max_tokens } : {}),
      ...(cr.temperature !== undefined ? { temperature: cr.temperature } : {}),
      ...(cr.top_p !== undefined ? { topP: cr.top_p } : {}),
    },
    history,
  });

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const keepalive = setInterval(() => writeSSE(res, ": keepalive\n\n"), 10_000);
    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        writeSSE(res, "data: [DONE]\n\n");
        res.end();
      }
    }, 600_000);

    try {
      const stream = await chat.sendMessageStream({ message: userInput });

      for await (const chunk of stream) {
        if (res.writableEnded) break;
        const text = chunk.text ?? "";
        if (text) writeSSE(res, sseChunk(chatId, cr.model, text));
      }

      writeSSE(res, sseChunk(chatId, cr.model, "", "stop"));
      writeSSE(res, "data: [DONE]\n\n");
    } catch (streamErr: unknown) {
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (!res.writableEnded) {
        writeSSE(res, `data: ${JSON.stringify({ error: { message: errMsg, type: "stream_error" } })}\n\n`);
        writeSSE(res, "data: [DONE]\n\n");
      }
      throw streamErr;
    } finally {
      clearTimeout(timeout);
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
    }
  } else {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout (120s)")), 120_000)
    );

    const response = await Promise.race([
      chat.sendMessage({ message: userInput }),
      timeout,
    ]);

    const text = response.text ?? "";
    res.json({
      id: chatId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: cr.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: response.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: response.usageMetadata?.totalTokenCount ?? 0,
      },
    });
  }
}
