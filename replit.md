# Apis Caduceus

## Overview

A full-stack AI proxy gateway that routes requests to multiple AI providers (Anthropic, OpenAI, Gemini, OpenRouter) with an OpenAI-compatible API (`/v1/chat/completions`). Includes a control panel at `/panel/` for monitoring stats, models, and live logs.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Build**: esbuild (ESM bundle)
- **Frontend**: React + Vite (no heavy UI library — pure inline styles)

## Artifacts

- **API Server** (`artifacts/api-server`): Express server at `/api` and `/v1` paths
  - `/api/healthz` — health check
  - `/api/version` — version info
  - `/api/setup-status` — provider config status (public)
  - `/api/stats` — request stats (requires PROXY_API_KEY)
  - `/api/logs` — recent request logs (requires PROXY_API_KEY)
  - `/v1/models` — list available models (requires PROXY_API_KEY)
  - `/v1/chat/completions` — main dispatch endpoint (requires PROXY_API_KEY)
- **Caduceus Panel** (`artifacts/caduceus-panel`): React dashboard at `/panel/`
  - Login screen (requires PROXY_API_KEY)
  - Dashboard: API endpoint display, stats, provider status
  - Models: browse all models by provider with usage counts
  - Live Feed: real-time request log with auto-refresh

## AI Provider Routing

Model name → Provider:
- `claude-*` → Anthropic
- `gemini-*`, `models/gemini-*`, `google/*` → Gemini
- `gpt-*`, `o1*`, `o3*`, `o4*`, `text-*` → OpenAI
- everything else → OpenRouter

## Special Model Features

- `-thinking` suffix: enables extended thinking (budget: 10k tokens)
- `-thinking-visible` suffix: enables thinking + streams `<think>...</think>` blocks

## Configuration

- `PROXY_API_KEY`: Set to `xiongshen` — required for all protected endpoints
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY` + `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`: Provisioned via Replit AI Integrations
- `AI_INTEGRATIONS_OPENAI_API_KEY` + `AI_INTEGRATIONS_OPENAI_BASE_URL`: Provisioned via Replit AI Integrations
- `AI_INTEGRATIONS_GEMINI_API_KEY` + `AI_INTEGRATIONS_GEMINI_BASE_URL`: Provisioned via Replit AI Integrations
- `AI_INTEGRATIONS_OPENROUTER_API_KEY` + `AI_INTEGRATIONS_OPENROUTER_BASE_URL`: Provisioned via Replit AI Integrations

## Key Commands

- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/caduceus-panel run dev` — run panel frontend
