import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { dispatchRouter, stats } from "./dispatch.js";
import { logger } from "./lib/logger.js";

const VERSION = "1.0.1";
const CODENAME = "Caduceus";

const app: Express = express();

app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) { return { method: req.method, url: req.url?.split("?")[0] }; },
      res(res) { return { statusCode: res.statusCode }; },
    },
  })
);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

function extractKey(req: Request): string {
  const auth = req.headers["authorization"] ?? "";
  if (auth) return auth.replace(/^Bearer\s+/i, "").trim();
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey) return xApiKey.trim();
  const xGoogApiKey = req.headers["x-goog-api-key"];
  if (typeof xGoogApiKey === "string" && xGoogApiKey) return xGoogApiKey.trim();
  const queryKey = req.query["key"];
  if (typeof queryKey === "string" && queryKey) return queryKey.trim();
  return "";
}

function authGuard(req: Request, res: Response, next: NextFunction): void {
  const proxyKey = process.env["PROXY_API_KEY"] ?? "";
  if (!proxyKey) {
    res.status(503).json({ error: "PROXY_API_KEY not configured" });
    return;
  }
  if (extractKey(req) !== proxyKey) {
    res.status(401).json({ error: { message: "Invalid or missing API key", type: "invalid_request_error", code: "invalid_api_key" } });
    return;
  }
  next();
}

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

app.get("/api/version", (_req, res) => {
  res.json({ version: VERSION, codename: CODENAME });
});

app.get("/api/setup-status", (_req, res) => {
  const keys = {
    anthropic: !!process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"],
    openai: !!process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
    gemini: !!process.env["AI_INTEGRATIONS_GEMINI_API_KEY"],
    openrouter: !!process.env["AI_INTEGRATIONS_OPENROUTER_API_KEY"],
    proxy: !!process.env["PROXY_API_KEY"],
  };
  const anyProvider = keys.anthropic || keys.openai || keys.gemini || keys.openrouter;
  res.json({ configured: anyProvider && keys.proxy, keys });
});

app.get("/api/stats", authGuard, (_req, res) => {
  res.json({
    totalRequests: stats.totalRequests,
    successRequests: stats.successRequests,
    errorRequests: stats.errorRequests,
    streamRequests: stats.streamRequests,
    requestsByProvider: stats.requestsByProvider,
    requestsByModel: stats.requestsByModel,
    uptime: process.uptime(),
    version: VERSION,
  });
});

app.get("/api/logs", authGuard, (req, res) => {
  const limit = Math.min(Number(req.query["limit"] ?? 100), 200);
  res.json({ logs: stats.recentLogs.slice(0, limit) });
});

const ANTHROPIC_MODELS = [
  "claude-opus-4-6", "claude-opus-4-6-thinking", "claude-opus-4-6-thinking-visible",
  "claude-opus-4-5", "claude-opus-4-5-thinking", "claude-opus-4-5-thinking-visible",
  "claude-opus-4-1", "claude-opus-4-1-thinking", "claude-opus-4-1-thinking-visible",
  "claude-sonnet-4-6", "claude-sonnet-4-6-thinking", "claude-sonnet-4-6-thinking-visible",
  "claude-sonnet-4-5", "claude-sonnet-4-5-thinking", "claude-sonnet-4-5-thinking-visible",
  "claude-haiku-4-5", "claude-haiku-4-5-thinking", "claude-haiku-4-5-thinking-visible",
  "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229",
];

const OPENAI_MODELS = [
  "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
  "gpt-4o", "gpt-4o-mini",
  "o3", "o3-mini", "o4-mini",
  "gpt-4", "gpt-3.5-turbo",
];

const GEMINI_MODELS = [
  "gemini-2.5-pro", "gemini-2.5-pro-thinking", "gemini-2.5-pro-thinking-visible",
  "gemini-2.5-flash", "gemini-2.5-flash-thinking", "gemini-2.5-flash-thinking-visible",
  "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash",
];

const OPENROUTER_MODELS = [
  "x-ai/grok-4-fast", "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout",
  "deepseek/deepseek-v3", "deepseek/deepseek-r1", "mistralai/mistral-small-2603",
  "google/gemini-2.5-pro", "anthropic/claude-opus-4.5",
];

app.get("/v1/models", authGuard, (_req, res) => {
  const anthropicOk = !!process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
  const openaiOk = !!process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  const geminiOk = !!process.env["AI_INTEGRATIONS_GEMINI_API_KEY"];
  const openrouterOk = !!process.env["AI_INTEGRATIONS_OPENROUTER_API_KEY"];

  const allModels = [
    ...ANTHROPIC_MODELS.map(id => ({ id, available: anthropicOk })),
    ...OPENAI_MODELS.map(id => ({ id, available: openaiOk })),
    ...GEMINI_MODELS.map(id => ({ id, available: geminiOk })),
    ...OPENROUTER_MODELS.map(id => ({ id, available: openrouterOk })),
  ];

  res.json({
    object: "list",
    data: allModels.map(({ id, available }) => ({
      id,
      object: "model",
      created: 1700000000,
      owned_by: "openai",
      available,
    })),
  });
});

app.use(authGuard, dispatchRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default app;
