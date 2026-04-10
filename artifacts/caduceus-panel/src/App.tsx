import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";

type Screen = "dashboard" | "models" | "livefeed";

interface Stats {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  streamRequests: number;
  requestsByProvider: Record<string, number>;
  requestsByModel: Record<string, number>;
  uptime: number;
  version: string;
}

interface LogEntry {
  id: string;
  ts: string;
  model: string;
  provider: string;
  stream: boolean;
  status: "ok" | "error";
  ms: number;
  ip: string;
}

interface SetupStatus {
  configured: boolean;
  keys: {
    anthropic: boolean;
    openai: boolean;
    gemini: boolean;
    openrouter: boolean;
    proxy: boolean;
  };
}

interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  available?: boolean;
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function timeAgo(ts: string): string {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  return `${Math.floor(diff / 3600)} 小时前`;
}

function useMobile(): boolean {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("resize", cb); return () => window.removeEventListener("resize", cb); },
    () => window.innerWidth < 640,
  );
}

function resolveProvider(modelId: string): string {
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gemini") || modelId.startsWith("models/gemini")) return "gemini";
  if (modelId.startsWith("gpt-") || modelId.startsWith("o3") || modelId.startsWith("o4") || modelId.startsWith("o1")) return "openai";
  return "openrouter";
}

const S = {
  app: {
    display: "flex",
    height: "100vh",
    background: "#0a0e1a",
    color: "#e2e8f0",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    fontSize: 14,
  } as React.CSSProperties,

  sidebar: {
    width: 220,
    minWidth: 220,
    background: "#0d1225",
    borderRight: "1px solid #1e2942",
    display: "flex",
    flexDirection: "column" as const,
    padding: "24px 0",
  } as React.CSSProperties,

  logo: {
    padding: "0 20px 24px",
    borderBottom: "1px solid #1e2942",
    marginBottom: 16,
  } as React.CSSProperties,

  logoTitle: {
    fontSize: 18,
    fontWeight: 700,
    background: "linear-gradient(135deg, #a78bfa, #60a5fa)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    letterSpacing: "-0.3px",
  } as React.CSSProperties,

  logoSub: {
    fontSize: 11,
    color: "#4a6380",
    marginTop: 2,
  } as React.CSSProperties,

  nav: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
    padding: "0 12px",
  } as React.CSSProperties,

  navItem: (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 8,
    cursor: "pointer",
    background: active ? "rgba(167,139,250,0.12)" : "transparent",
    color: active ? "#a78bfa" : "#64748b",
    fontWeight: active ? 600 : 400,
    transition: "all 0.15s",
    border: "none",
    width: "100%",
    textAlign: "left" as const,
    fontSize: 14,
  }),

  main: {
    flex: 1,
    overflow: "auto",
    padding: 28,
    display: "flex",
    flexDirection: "column" as const,
    gap: 20,
  } as React.CSSProperties,

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  } as React.CSSProperties,

  headerTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: "#f1f5f9",
  } as React.CSSProperties,

  card: {
    background: "#0d1225",
    border: "1px solid #1e2942",
    borderRadius: 12,
    padding: "20px 24px",
  } as React.CSSProperties,

  cardTitle: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    color: "#4a6380",
    marginBottom: 16,
  } as React.CSSProperties,

  statCard: (color: string): React.CSSProperties => ({
    background: "#0d1225",
    border: `1px solid ${color}33`,
    borderRadius: 12,
    padding: "18px 20px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  }),

  statValue: {
    fontSize: 28,
    fontWeight: 700,
    color: "#f1f5f9",
    lineHeight: 1,
  } as React.CSSProperties,

  statLabel: {
    fontSize: 12,
    color: "#4a6380",
    fontWeight: 500,
  } as React.CSSProperties,

  badge: (color: string): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 8px",
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    background: `${color}22`,
    color: color,
    border: `1px solid ${color}44`,
  }),

  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
  } as React.CSSProperties,

  th: {
    textAlign: "left" as const,
    padding: "8px 12px",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    color: "#4a6380",
    borderBottom: "1px solid #1e2942",
  } as React.CSSProperties,

  td: {
    padding: "10px 12px",
    borderBottom: "1px solid #111827",
    fontSize: 13,
    color: "#94a3b8",
    verticalAlign: "middle" as const,
  } as React.CSSProperties,

  input: {
    background: "#0a0e1a",
    border: "1px solid #1e2942",
    borderRadius: 8,
    color: "#e2e8f0",
    padding: "8px 12px",
    fontSize: 13,
    outline: "none",
    width: "100%",
  } as React.CSSProperties,

  btn: (variant: "primary" | "ghost"): React.CSSProperties => ({
    padding: "8px 16px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    background:
      variant === "primary"
        ? "linear-gradient(135deg, #7c3aed, #4f46e5)"
        : "rgba(255,255,255,0.05)",
    color: variant === "primary" ? "#fff" : "#94a3b8",
    transition: "opacity 0.15s",
  }),

  empty: {
    textAlign: "center" as const,
    padding: "40px 0",
    color: "#374151",
    fontSize: 13,
  } as React.CSSProperties,

  dot: (color: string): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: color,
    flexShrink: 0,
  }),
};

const PROVIDER_COLOR: Record<string, string> = {
  anthropic: "#fb923c",
  openai: "#60a5fa",
  gemini: "#34d399",
  openrouter: "#c084fc",
};

const STATUS_COLOR: Record<string, string> = {
  ok: "#34d399",
  error: "#ef4444",
};

function SetupOverlay({ onDone }: { onDone: (key: string) => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!key.trim()) { setError("请输入 Proxy API Key"); return; }
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/stats", {
        headers: { Authorization: `Bearer ${key.trim()}` },
      });
      if (r.ok) {
        sessionStorage.setItem("caduceus_key", key.trim());
        onDone(key.trim());
      } else {
        setError("无效的 API key，请检查 PROXY_API_KEY");
      }
    } catch {
      setError("无法连接到 API 服务器");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0a0e1a" }}>
      <div style={{ background: "#0d1225", border: "1px solid #1e2942", borderRadius: 16, padding: 40, maxWidth: 440, width: "100%", margin: "0 24px" }}>
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 28, fontWeight: 700, background: "linear-gradient(135deg, #a78bfa, #60a5fa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", marginBottom: 6 }}>
            Apis Caduceus
          </div>
          <div style={{ color: "#4a6380", fontSize: 13 }}>输入 PROXY_API_KEY 以访问控制台</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            style={{ ...S.input, padding: "12px 14px" }}
            type="password"
            placeholder="PROXY_API_KEY"
            value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === "Enter" && void handleSubmit()}
          />
          {error && <div style={{ color: "#ef4444", fontSize: 12 }}>{error}</div>}
          <button style={{ ...S.btn("primary"), padding: "12px", width: "100%" }} onClick={() => void handleSubmit()} disabled={loading}>
            {loading ? "连接中..." : "连接"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DashboardScreen({ apiKey }: { apiKey: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [s, st] = await Promise.all([
      fetch("/api/stats", { headers: { Authorization: `Bearer ${apiKey}` } }).then(r => r.ok ? r.json() : null).catch(() => null) as Promise<Stats | null>,
      fetch("/api/setup-status").then(r => r.json()).catch(() => null) as Promise<SetupStatus | null>,
    ]);
    setStats(s);
    setSetup(st);
    setEndpoint(window.location.origin + "/v1");
  }, [apiKey]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  function copyEndpoint() {
    navigator.clipboard.writeText(endpoint).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={S.header}>
        <div style={S.headerTitle}>控制台</div>
        <div style={{ color: "#4a6380", fontSize: 12 }}>
          {stats ? `运行时长：${fmtUptime(stats.uptime)} · v${stats.version}` : "连接中..."}
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>API 接入地址（SillyTavern 兼容）</div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" as const }}>
          <div style={{ flex: 1, minWidth: 0, background: "#0a0e1a", border: "1px solid #1e2942", borderRadius: 8, padding: "10px 14px", fontFamily: "monospace", fontSize: 13, color: "#a78bfa", overflowX: "auto" as const, wordBreak: "break-all" as const }}>
            {endpoint}
          </div>
          <button style={S.btn("ghost")} onClick={copyEndpoint}>{copied ? "✓ 已复制" : "复制"}</button>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: "#4a6380", lineHeight: 1.6 }}>
          SillyTavern → API Connections → Chat Completion → OpenAI → Custom Endpoint → 粘贴上方地址 → API Key 填写你的 PROXY_API_KEY
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {[
          { label: "总请求", value: stats?.totalRequests ?? 0, color: "#60a5fa" },
          { label: "成功", value: stats?.successRequests ?? 0, color: "#34d399" },
          { label: "错误", value: stats?.errorRequests ?? 0, color: "#ef4444" },
        ].map(s => (
          <div key={s.label} style={S.statCard(s.color)}>
            <div style={{ ...S.statValue, color: s.color }}>{s.value.toLocaleString()}</div>
            <div style={S.statLabel}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        <div style={S.card}>
          <div style={S.cardTitle}>服务商状态</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(["anthropic", "openai", "gemini", "openrouter"] as const).map(p => {
              const ok = setup?.keys?.[p] ?? false;
              return (
                <div key={p} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={S.dot(ok ? PROVIDER_COLOR[p]! : "#374151")} />
                    <span style={{ textTransform: "capitalize", color: ok ? "#e2e8f0" : "#4a6380" }}>{p}</span>
                  </div>
                  <span style={{ fontSize: 11, color: ok ? "#34d399" : "#4a6380" }}>{ok ? "已配置" : "未设置"}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div style={S.card}>
          <div style={S.cardTitle}>各服务商请求量</div>
          {stats && Object.keys(stats.requestsByProvider).length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Object.entries(stats.requestsByProvider)
                .sort(([, a], [, b]) => b - a)
                .map(([p, count]) => {
                  const total = stats.totalRequests || 1;
                  const pct = Math.round((count / total) * 100);
                  return (
                    <div key={p}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ textTransform: "capitalize", fontSize: 13, color: PROVIDER_COLOR[p] ?? "#94a3b8" }}>{p}</span>
                        <span style={{ fontSize: 12, color: "#4a6380" }}>{count} ({pct}%)</span>
                      </div>
                      <div style={{ height: 4, background: "#1e2942", borderRadius: 2 }}>
                        <div style={{ height: 4, width: `${pct}%`, background: PROVIDER_COLOR[p] ?? "#60a5fa", borderRadius: 2, transition: "width 0.4s" }} />
                      </div>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div style={{ color: "#4a6380", fontSize: 13, textAlign: "center", padding: "20px 0" }}>暂无请求记录</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ModelsScreen({ apiKey }: { apiKey: string }) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [usageByModel, setUsageByModel] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    anthropic: true, openai: true, gemini: true, openrouter: true,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mr, sr] = await Promise.all([
        fetch("/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } }),
        fetch("/api/stats",  { headers: { Authorization: `Bearer ${apiKey}` } }),
      ]);
      if (mr.ok) {
        const data = await mr.json() as { data: ModelEntry[] };
        setModels(data.data ?? []);
      }
      if (sr.ok) {
        const s = await sr.json() as Stats;
        setUsageByModel(s.requestsByModel ?? {});
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [apiKey]);

  useEffect(() => { void load(); }, [load]);

  const filtered = models.filter(m => m.id.toLowerCase().includes(search.toLowerCase()));
  const byProvider: Record<string, ModelEntry[]> = {};
  for (const m of filtered) {
    const p = resolveProvider(m.id);
    if (!byProvider[p]) byProvider[p] = [];
    byProvider[p]!.push(m);
  }

  const totalUsed = Object.keys(usageByModel).length;

  const toggleCollapse = (p: string) =>
    setCollapsed(c => ({ ...c, [p]: !c[p] }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 8 }}>
        <div style={S.headerTitle}>
          模型列表
          {totalUsed > 0 && (
            <span style={{ marginLeft: 10, fontSize: 11, color: "#4a9eff", background: "rgba(74,158,255,0.1)", border: "1px solid rgba(74,158,255,0.2)", borderRadius: 4, padding: "2px 7px", fontWeight: 400 }}>
              已使用 {totalUsed} 个
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            style={{ ...S.input, width: 180 }}
            placeholder="搜索模型..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button style={S.btn("ghost")} onClick={() => void load()}>{loading ? "加载中..." : "刷新"}</button>
        </div>
      </div>

      {models.length === 0 && !loading && (
        <div style={S.card}><div style={S.empty}>暂无模型数据</div></div>
      )}

      {(["anthropic", "openai", "gemini", "openrouter"] as const).map(provider => {
        const list = byProvider[provider];
        if (!list || list.length === 0) return null;
        const providerCalls = list.reduce((s, m) => s + (usageByModel[m.id] ?? 0), 0);
        const anyAvailable = list.some(m => m.available !== false);
        const isCollapsed = !!collapsed[provider];
        const dotColor = anyAvailable ? (PROVIDER_COLOR[provider] ?? "#94a3b8") : "#374151";
        return (
          <div key={provider} style={S.card}>
            <div
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" as const }}
              onClick={() => toggleCollapse(provider)}
            >
              <div style={S.dot(dotColor)} />
              <div style={{ ...S.cardTitle, marginBottom: 0, textTransform: "capitalize", flex: 1 }}>{provider}</div>
              {!anyAvailable && (
                <span style={{ fontSize: 10, color: "#4a6380" }}>密钥未配置</span>
              )}
              {providerCalls > 0 && (
                <span style={{ fontSize: 11, color: "#4a9eff" }}>{providerCalls} 次</span>
              )}
              <span style={{ fontSize: 11, color: "#4a6380", marginLeft: 4 }}>{list.length} 个</span>
              <span style={{ fontSize: 12, color: "#4a6380", marginLeft: 6 }}>{isCollapsed ? "▸" : "▾"}</span>
            </div>
            {!isCollapsed && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 12 }}>
                {list.map(m => {
                  const isThinking = m.id.includes("-thinking");
                  const isVisible = m.id.includes("-thinking-visible");
                  const calls = usageByModel[m.id] ?? 0;
                  const unavailable = m.available === false;
                  return (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid #111827" }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: unavailable ? "#374151" : (PROVIDER_COLOR[provider] ?? "#94a3b8"), flexShrink: 0 }} />
                      <span style={{ fontFamily: "Menlo, monospace", fontSize: 12, color: unavailable ? "#4a6380" : "#e2e8f0", flex: 1, wordBreak: "break-all" as const }}>{m.id}</span>
                      {calls > 0 && (
                        <span style={{ fontSize: 11, color: "#4a9eff", flexShrink: 0 }}>{calls}×</span>
                      )}
                      {isVisible && <span style={{ fontSize: 10, background: "rgba(167,139,250,0.12)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.25)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>thinking-visible</span>}
                      {isThinking && !isVisible && <span style={{ fontSize: 10, background: "rgba(167,139,250,0.07)", color: "#7c5cbf", border: "1px solid rgba(167,139,250,0.15)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>thinking</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LiveFeedScreen({ apiKey }: { apiKey: string }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [auto, setAuto] = useState(true);
  const timerRef = useRef<number | null>(null);
  const isMobile = useMobile();

  const load = useCallback(async () => {
    const r = await fetch("/api/logs?limit=100", {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).catch(() => null);
    if (r?.ok) {
      const data = await r.json() as { logs: LogEntry[] };
      setLogs(data.logs ?? []);
    }
  }, [apiKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (auto) {
      timerRef.current = setInterval(() => void load(), 3000) as unknown as number;
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [load, auto]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={S.headerTitle}>实时日志</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "#64748b", fontSize: 13 }}>
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
            自动刷新
          </label>
          <button style={S.btn("ghost")} onClick={() => void load()}>刷新</button>
        </div>
      </div>

      <div style={S.card}>
        {logs.length === 0 ? (
          <div style={S.empty}>暂无请求记录</div>
        ) : isMobile ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {logs.map(log => (
              <div key={log.id} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid #1e2942", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ ...S.badge(STATUS_COLOR[log.status] ?? "#94a3b8") }}>{log.status === "ok" ? "成功" : "错误"}</span>
                  <span style={{ ...S.badge(PROVIDER_COLOR[log.provider] ?? "#94a3b8") }}>{log.provider}</span>
                  <span style={{ color: "#4a6380", fontSize: 11, marginLeft: "auto" }}>{timeAgo(log.ts)}</span>
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 11, color: "#a78bfa", wordBreak: "break-all" as const }}>{log.model}</div>
                <div style={{ display: "flex", gap: 8, fontSize: 11, color: "#4a6380" }}>
                  <span>{log.stream ? "流式" : "同步"}</span>
                  <span>·</span>
                  <span>{fmtMs(log.ms)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                {["时间", "模型", "服务商", "类型", "状态", "延迟"].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id}>
                  <td style={S.td}>{timeAgo(log.ts)}</td>
                  <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {log.model}
                  </td>
                  <td style={S.td}>
                    <span style={{ ...S.badge(PROVIDER_COLOR[log.provider] ?? "#94a3b8") }}>{log.provider}</span>
                  </td>
                  <td style={S.td}>
                    <span style={{ color: log.stream ? "#a78bfa" : "#94a3b8", fontSize: 11 }}>{log.stream ? "流式" : "同步"}</span>
                  </td>
                  <td style={S.td}>
                    <span style={{ ...S.badge(STATUS_COLOR[log.status] ?? "#94a3b8") }}>{log.status === "ok" ? "成功" : "错误"}</span>
                  </td>
                  <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{fmtMs(log.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const NAV_ITEMS: { id: Screen; label: string; icon: string }[] = [
  { id: "dashboard", label: "控制台", icon: "◈" },
  { id: "models", label: "模型", icon: "◇" },
  { id: "livefeed", label: "日志", icon: "◉" },
];

export default function App() {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("caduceus_key") ?? "");
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [version, setVersion] = useState("");
  const isMobile = useMobile();

  useEffect(() => {
    fetch("/api/version").then(r => r.json()).then((d: { version: string; codename: string }) => {
      setVersion(`v${d.version}`);
    }).catch(() => {});
  }, []);

  if (!apiKey) {
    return <SetupOverlay onDone={(k) => setApiKey(k)} />;
  }

  if (isMobile) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0a0e1a", color: "#e2e8f0", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
        <div style={{ padding: "12px 16px 8px", borderBottom: "1px solid #1e2942", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <div style={{ ...S.logoTitle, fontSize: 15 }}>Apis Caduceus</div>
            <div style={{ ...S.logoSub, fontSize: 10 }}>子节点 {version}</div>
          </div>
          <button style={{ ...S.btn("ghost"), fontSize: 11, padding: "5px 10px" }}
            onClick={() => { sessionStorage.removeItem("caduceus_key"); setApiKey(""); }}>
            断开
          </button>
        </div>
        <main style={{ flex: 1, overflow: "auto", padding: "16px 14px 70px" }}>
          {screen === "dashboard" && <DashboardScreen apiKey={apiKey} />}
          {screen === "models" && <ModelsScreen apiKey={apiKey} />}
          {screen === "livefeed" && <LiveFeedScreen apiKey={apiKey} />}
        </main>
        <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: 56, background: "#0d1225", borderTop: "1px solid #1e2942", display: "flex" }}>
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              onClick={() => setScreen(item.id)}
              style={{ flex: 1, border: "none", background: "transparent", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, cursor: "pointer", color: screen === item.id ? "#a78bfa" : "#4a6380", fontSize: 10, fontWeight: screen === item.id ? 600 : 400, transition: "color 0.15s" }}
            >
              <span style={{ fontSize: 18 }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div style={S.app}>
      <aside style={S.sidebar}>
        <div style={S.logo}>
          <div style={S.logoTitle}>Apis Caduceus</div>
          <div style={S.logoSub}>子节点控制台 {version}</div>
        </div>
        <nav style={S.nav}>
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              style={S.navItem(screen === item.id)}
              onClick={() => setScreen(item.id)}
            >
              <span style={{ fontSize: 16 }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div style={{ padding: "16px 20px 0", borderTop: "1px solid #1e2942", marginTop: "auto" }}>
          <button
            style={{ ...S.btn("ghost"), width: "100%", fontSize: 12, padding: "7px 12px" }}
            onClick={() => { sessionStorage.removeItem("caduceus_key"); setApiKey(""); }}
          >
            断开连接
          </button>
        </div>
      </aside>

      <main style={S.main}>
        {screen === "dashboard" && <DashboardScreen apiKey={apiKey} />}
        {screen === "models" && <ModelsScreen apiKey={apiKey} />}
        {screen === "livefeed" && <LiveFeedScreen apiKey={apiKey} />}
      </main>
    </div>
  );
}
