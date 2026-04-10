/**
 * Apis Caduceus — Main Dispatch Engine
 * Handles SillyTavern-compatible AI routing for all supported providers.
 */

import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { logger } from "./lib/logger.js";

export const dispatchRouter = Router();

interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

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
}

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

  model = model.replace(/^openai\//, "").replace(/^anthropic\//, "");

  if (model.startsWith("claude")) {
    model = model.replace(/(\d)\.(\d)/g, "$1-$2");
  }

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

  if (model.startsWith("claude")) {
    req.max_tokens = Math.min(Math.max(raw.max_tokens ?? 4096, 4096), 64000);
  }

  req.messages = (req.messages ?? []).map((m) => {
    if (m.role !== "system" && m.role !== "assistant") {
      const text = typeof m.content === "string" ? m.content : extractText(m.content as ContentPart[]);
      if (!text.trim()) return { ...m, content: "\u200b" };
    }
    return m;
  });

  return { ...req, _thinkingVisible: thinkingVisible };
}

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
      system = extractText(msg.content);
      continue;
    }

    const role = msg.role === "assistant" ? "assistant" : "user";
    const textContent = extractText(msg.content);

    if (out.length > 0 && out[out.length - 1]!.role === role) {
      const prev = out[out.length - 1]!;
      if (typeof prev.content === "string") {
        prev.content += "\n" + textContent;
      }
    } else {
      out.push({ role, content: textContent });
    }
  }

  if (out.length > 0 && out[0]!.role !== "user") {
    out.unshift({ role: "user", content: "[Conversation start]" });
  }

  return { system, converted: out };
}

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

const LOOPBACK_SAFE = new Set(["127.0.0.1", "::1", "localhost", "unknown"]);

function normalizeClientIP(ip: string): string {
  const cleaned = ip.replace(/^::ffff:/, "");
  if (LOOPBACK_SAFE.has(cleaned) || cleaned.startsWith("10.") || cleaned.startsWith("192.168.")) {
    return "internal";
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(cleaned)) return "internal";
  return cleaned;
}

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

function sseChunk(
  id: string,
  model: string,
  delta: string,
  finishReason?: string | null
): string {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: delta ? { role: "assistant", content: delta } : {},
        finish_reason: finishReason ?? null,
      },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

dispatchRouter.post("/v1/chat/completions", async (req: Request, res: Response) => {
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

  try {
    if (provider === "anthropic") {
      await handleAnthropic(cr, chatId, spoofedIp, isStream, res);
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
        res.write(`data: {"error":{"message":"${msg.replace(/"/g, '\\"')}"}}\n\ndata: [DONE]\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: { message: msg, type: "api_error", code: 500 } });
      }
    }
  }
});

async function handleAnthropic(
  cr: ChatRequest & { _thinkingVisible: boolean; thinking?: { type: "enabled"; budget_tokens?: number } },
  chatId: string,
  spoofedIp: string,
  isStream: boolean,
  res: Response
): Promise<void> {
  const client = new Anthropic({
    apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] ?? "",
    baseURL: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"],
    defaultHeaders: { "X-Forwarded-For": spoofedIp },
  });

  const { system, converted } = convertMessagesForClaude(cr.messages);

  const hasTemp = cr.temperature !== undefined;
  const hasTopP = cr.top_p !== undefined;

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: cr.model,
    max_tokens: cr.max_tokens ?? 4096,
    messages: converted,
    ...(system ? { system } : {}),
    ...(hasTemp ? { temperature: cr.temperature } : {}),
    ...(!hasTemp && hasTopP ? { top_p: cr.top_p } : {}),
    ...(cr.thinking ? { thinking: cr.thinking } : {}),
  };

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("x-owned-by", "openai");

    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      }
    }, 600_000);

    try {
      const stream = await client.messages.stream({
        ...params,
        stream: true,
      } as Anthropic.MessageCreateParamsStreaming);

      for await (const event of stream) {
        if (res.writableEnded) break;

        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            res.write(sseChunk(chatId, cr.model, delta.text));
          } else if (delta.type === "thinking_delta" && cr._thinkingVisible) {
            res.write(sseChunk(chatId, cr.model, `<think>${delta.thinking}</think>`));
          }
        } else if (event.type === "message_stop") {
          res.write(sseChunk(chatId, cr.model, "", "stop"));
          res.write("data: [DONE]\n\n");
        }
      }
    } catch (streamErr: unknown) {
      const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      logger.error({ err: msg, model: cr.model, provider: "anthropic" }, "Anthropic stream error");
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: msg, type: "api_error" }, choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
    } finally {
      clearTimeout(timeout);
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

    const textContent = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const thinkContent = cr._thinkingVisible
      ? response.content
          .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
          .map((b) => `<think>${b.thinking}</think>`)
          .join("\n")
      : "";

    res.setHeader("x-owned-by", "openai");
    res.json({
      id: chatId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: cr.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: thinkContent ? thinkContent + "\n" + textContent : textContent,
          },
          finish_reason: response.stop_reason ?? "stop",
        },
      ],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    });
  }
}

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
    defaultHeaders: { "X-Forwarded-For": spoofedIp },
  });

  const msgs = cr.messages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: extractText(m.content),
  }));

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("x-owned-by", "openai");

    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }, 600_000);

    try {
      const stream = await client.chat.completions.create({
        model: cr.model,
        messages: msgs,
        stream: true,
        ...(cr.max_tokens ? { max_tokens: cr.max_tokens } : {}),
        ...(cr.temperature !== undefined ? { temperature: cr.temperature } : {}),
        ...(cr.top_p !== undefined ? { top_p: cr.top_p } : {}),
      });

      for await (const chunk of stream) {
        if (res.writableEnded) break;
        const delta = chunk.choices[0]?.delta?.content ?? "";
        const finish = chunk.choices[0]?.finish_reason ?? null;
        res.write(sseChunk(chatId, cr.model, delta, finish));
        if (finish) {
          res.write("data: [DONE]\n\n");
          break;
        }
      }
    } catch (streamErr: unknown) {
      const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      logger.error({ err: msg, model: cr.model, provider: "openai" }, "OpenAI stream error");
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: msg, type: "api_error" }, choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
    } finally {
      clearTimeout(timeout);
      if (!res.writableEnded) res.end();
    }
  } else {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout (120s)")), 120_000)
    );

    const response = await Promise.race([
      client.chat.completions.create({
        model: cr.model,
        messages: msgs,
        ...(cr.max_tokens ? { max_tokens: cr.max_tokens } : {}),
        ...(cr.temperature !== undefined ? { temperature: cr.temperature } : {}),
        ...(cr.top_p !== undefined ? { top_p: cr.top_p } : {}),
      }),
      timeout,
    ]);

    res.setHeader("x-owned-by", "openai");
    res.json({
      id: chatId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: cr.model,
      choices: response.choices,
      usage: response.usage,
    });
  }
}

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
      "HTTP-Referer": "https://caduceus.local",
      "X-Title": "Apis Caduceus",
      "X-Forwarded-For": spoofedIp,
    },
  });

  const msgs = cr.messages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: extractText(m.content),
  }));

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("x-owned-by", "openai");

    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }, 600_000);

    try {
      const stream = await client.chat.completions.create({
        model: cr.model,
        messages: msgs,
        stream: true,
        ...(cr.max_tokens ? { max_tokens: cr.max_tokens } : {}),
        ...(cr.temperature !== undefined ? { temperature: cr.temperature } : {}),
        ...(cr.top_p !== undefined ? { top_p: cr.top_p } : {}),
      });

      for await (const chunk of stream) {
        if (res.writableEnded) break;
        const delta = chunk.choices[0]?.delta?.content ?? "";
        const finish = chunk.choices[0]?.finish_reason ?? null;
        res.write(sseChunk(chatId, cr.model, delta, finish));
        if (finish) {
          res.write("data: [DONE]\n\n");
          break;
        }
      }
    } catch (streamErr: unknown) {
      const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      logger.error({ err: msg, model: cr.model, provider: "openrouter" }, "OpenRouter stream error");
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: msg, type: "api_error" }, choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
    } finally {
      clearTimeout(timeout);
      if (!res.writableEnded) res.end();
    }
  } else {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout (120s)")), 120_000)
    );

    const response = await Promise.race([
      client.chat.completions.create({
        model: cr.model,
        messages: msgs,
        ...(cr.max_tokens ? { max_tokens: cr.max_tokens } : {}),
        ...(cr.temperature !== undefined ? { temperature: cr.temperature } : {}),
        ...(cr.top_p !== undefined ? { top_p: cr.top_p } : {}),
      }),
      timeout,
    ]);

    res.setHeader("x-owned-by", "openai");
    res.json({
      id: chatId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: cr.model,
      choices: response.choices,
      usage: response.usage,
    });
  }
}

async function handleGemini(
  cr: ChatRequest,
  chatId: string,
  isStream: boolean,
  res: Response
): Promise<void> {
  const ai = new GoogleGenAI({
    apiKey: process.env["AI_INTEGRATIONS_GEMINI_API_KEY"] ?? "",
    httpOptions: process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"]
      ? { baseUrl: process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"] }
      : undefined,
  });

  const sysMsg = cr.messages.find((m) => m.role === "system");
  const systemInstruction = sysMsg ? extractText(sysMsg.content) : undefined;

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
    res.setHeader("x-owned-by", "openai");

    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }, 600_000);

    try {
      const stream = await chat.sendMessageStream({ message: userInput });

      for await (const chunk of stream) {
        if (res.writableEnded) break;
        const text = chunk.text ?? "";
        if (text) res.write(sseChunk(chatId, cr.model, text));
      }

      res.write(sseChunk(chatId, cr.model, "", "stop"));
      res.write("data: [DONE]\n\n");
    } catch (streamErr: unknown) {
      const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      logger.error({ err: msg, model: cr.model, provider: "gemini" }, "Gemini stream error");
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: msg, type: "api_error" }, choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
    } finally {
      clearTimeout(timeout);
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
    res.setHeader("x-owned-by", "openai");
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
