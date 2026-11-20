import {
  Activity,
  ArrowLeft,
  ChevronRight,
  Clock3,
  Database,
  History,
  LayoutDashboard,
  RefreshCw,
  Search,
  Server,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  AgentId,
  HealthData,
  OverviewData,
  SeriesPoint,
  SessionDetail,
  SessionRow,
  SourceStatus,
  TokenUsage,
} from "./types";

const AGENTS: Record<AgentId, { name: string; short: string }> = {
  codex: { name: "Codex", short: "CX" },
  podex: { name: "PodeX", short: "PX" },
  claude: { name: "Claude Code", short: "CC" },
  workbuddy: { name: "WorkBuddy", short: "WB" },
  deepseek: { name: "DeepSeek Harness", short: "DS" },
};

const EMPTY_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
};

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash || "#/overview");
  useEffect(() => {
    const onHash = () => setHash(window.location.hash || "#/overview");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash.replace(/^#\/?/, "");
}

function useLiveRefresh(refresh: () => void) {
  const refreshRef = useRef(refresh);
  const timer = useRef<number | undefined>(undefined);
  refreshRef.current = refresh;
  useEffect(() => {
    const events = new EventSource("/api/events");
    const scheduleRefresh = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => refreshRef.current(), 250);
    };
    events.addEventListener("ready", scheduleRefresh);
    events.addEventListener("update", scheduleRefresh);
    return () => {
      window.clearTimeout(timer.current);
      events.removeEventListener("ready", scheduleRefresh);
      events.removeEventListener("update", scheduleRefresh);
      events.close();
    };
  }, []);
}

function formatTokens(value: number) {
  if (!Number.isFinite(value)) return "0";
  if (value < 1_000) return Math.round(value).toLocaleString("zh-CN");
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(value);
}

function formatDate(value?: string, includeTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date);
}

function since(value?: string) {
  if (!value) return "尚未发现记录";
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function AgentMark({ agent }: { agent: AgentId }) {
  return <span className={`agent-mark agent-${agent}`}>{AGENTS[agent]?.short ?? "?"}</span>;
}

function StatusDot({ status }: { status: SourceStatus["status"] | HealthData["status"] }) {
  const live = status === "live" || status === "ok";
  return <span className={`status-dot ${live ? "is-live" : status === "error" ? "is-error" : ""}`} />;
}

export function App() {
  const route = useHashRoute();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [shellError, setShellError] = useState("");

  const loadShell = useCallback(async () => {
    try {
      const [nextHealth, nextSources] = await Promise.all([api.health(), api.sources()]);
      setHealth(nextHealth);
      setSources(nextSources);
      setShellError("");
    } catch (error) {
      setShellError(error instanceof Error ? error.message : "无法连接本地采集服务");
    }
  }, []);

  useEffect(() => void loadShell(), [loadShell]);
  useLiveRefresh(loadShell);

  const detailMatch = route.match(/^sessions\/(.+)$/);
  const active = detailMatch || route === "sessions" ? "sessions" : "overview";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById("main-content")?.focus();
      }}>跳到主内容</a>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-glyph"><Activity size={18} strokeWidth={2.2} /></div>
          <div>
            <strong>Agent Monitor</strong>
            <span>local telemetry</span>
          </div>
        </div>

        <nav className="primary-nav" aria-label="主导航">
          <a className={active === "overview" ? "active" : ""} href="#/overview">
            <LayoutDashboard size={17} />总览
          </a>
          <a className={active === "sessions" ? "active" : ""} href="#/sessions">
            <History size={17} />会话
          </a>
        </nav>

        <div className="sidebar-spacer" />
        <div className="source-mini-list" aria-label="采集源状态">
          <div className="sidebar-label">采集源</div>
          {(sources.length ? sources : (Object.keys(AGENTS) as AgentId[]).map((agent) => ({ agent }))).map((source) => {
            const status = "status" in source ? source.status as SourceStatus["status"] : "idle";
            return (
              <div className="source-mini" key={source.agent}>
                <AgentMark agent={source.agent} />
                <span>{AGENTS[source.agent].name}</span>
                <StatusDot status={status} />
              </div>
            );
          })}
        </div>
        <div className="local-note">
          <Server size={15} />
          <div><span>仅本机</span><small>127.0.0.1 · 数据不出设备</small></div>
        </div>
      </aside>

      <main className="workspace" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <div className="crumbs">
            <span>Agent Monitor</span><ChevronRight size={14} />
            <strong>{detailMatch ? "会话详情" : active === "sessions" ? "会话" : "总览"}</strong>
          </div>
          <div className="topbar-status" title={health?.lastScanAt ? `上次扫描：${formatDate(health.lastScanAt)}` : "等待首次扫描"}>
            <StatusDot status={shellError ? "error" : health?.status ?? "scanning"} />
            <span>{shellError ? "服务未连接" : health?.status === "scanning" ? "正在扫描" : "实时同步"}</span>
          </div>
        </header>

        <div className="page-frame wrap">
          {shellError && <div className="connection-banner"><Database size={16} />{shellError}。后端启动后本页会自动重连。</div>}
          {detailMatch ? (
            <SessionPage id={decodeURIComponent(detailMatch[1])} />
          ) : active === "sessions" ? (
            <SessionsPage />
          ) : (
            <OverviewPage sources={sources} onRescan={loadShell} />
          )}
        </div>
      </main>
    </div>
  );
}

function OverviewPage({ sources, onRescan }: { sources: SourceStatus[]; onRescan: () => void }) {
  const [range, setRange] = useState("7d");
  const [agent, setAgent] = useState("all");
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState("");
  const [rescanning, setRescanning] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.overview(range, agent));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "统计加载失败");
    }
  }, [range, agent]);

  useEffect(() => void load(), [load]);
  useLiveRefresh(load);

  const rescan = async () => {
    setRescanning(true);
    try {
      await api.rescan();
      window.setTimeout(() => {
        void load();
        void onRescan();
      }, 350);
    } finally {
      window.setTimeout(() => setRescanning(false), 600);
    }
  };

  const usage = data?.usage ?? EMPTY_USAGE;
  const cacheRate = data?.cacheRate ?? 0;

  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">LOCAL AGENT TELEMETRY</div>
          <h1>本地 Agent 用量总览</h1>
          <p>汇总本机桌面端、CLI 与 exec 会话中的真实 token 记录。</p>
        </div>
        <div className="heading-actions">
          <label className="select-wrap">
            <span className="sr-only">Agent 筛选</span>
            <select value={agent} onChange={(event) => setAgent(event.target.value)}>
              <option value="all">全部 Agent</option>
              {(Object.keys(AGENTS) as AgentId[]).map((id) => <option key={id} value={id}>{AGENTS[id].name}</option>)}
            </select>
          </label>
          <button className="button secondary" onClick={() => void rescan()} disabled={rescanning}>
            <RefreshCw size={15} className={rescanning ? "spin" : ""} />重新扫描
          </button>
        </div>
      </section>

      <div className="range-bar" role="group" aria-label="时间范围">
        {[{ id: "24h", label: "24 小时" }, { id: "7d", label: "7 天" }, { id: "30d", label: "30 天" }, { id: "all", label: "全部" }].map((item) => (
          <button key={item.id} className={range === item.id ? "active" : ""} onClick={() => setRange(item.id)}>{item.label}</button>
        ))}
        <span className="range-stamp">{data ? `更新于 ${formatDate(data.updatedAt)}` : "正在读取本地索引…"}</span>
      </div>

      {error && <div className="inline-error">{error}</div>}

      <section className="metric-strip" aria-label="核心指标">
        <Metric label="总 token" value={formatTokens(usage.total)} detail={`${formatTokens(usage.input)} 输入 · ${formatTokens(usage.output)} 输出`} primary />
        <Metric label="会话" value={(data?.sessions ?? 0).toLocaleString("zh-CN")} detail={`${(data?.activeToday ?? 0).toLocaleString("zh-CN")} 个今日活跃`} />
        <Metric label="消息" value={(data?.messages ?? 0).toLocaleString("zh-CN")} detail="可检索历史记录" />
        <Metric label="缓存命中" value={`${cacheRate.toFixed(1)}%`} detail={`${formatTokens(usage.cacheRead)} cached tokens`} />
      </section>

      <section className="dashboard-grid">
        <div className="panel usage-panel">
          <div className="panel-heading">
            <div><span className="panel-kicker">趋势</span><h2>Token 用量</h2></div>
            <div className="chart-legend"><span className="legend-input">输入</span><span className="legend-output">输出</span></div>
          </div>
          <UsageChart points={data?.series ?? []} />
        </div>

        <div className="panel source-panel">
          <div className="panel-heading"><div><span className="panel-kicker">连接</span><h2>采集源</h2></div><span className="count-label">{sources.filter((item) => item.status === "live").length}/{sources.length || 5} 在线</span></div>
          <div className="source-list">
            {(sources.length ? sources : (Object.keys(AGENTS) as AgentId[]).map((id) => ({ id, agent: id, label: AGENTS[id].name, root: "", status: "scanning", sessions: 0, tokens: 0 } as SourceStatus))).map((source) => (
              <div className="source-row" key={source.id} title={source.error || source.root}>
                <AgentMark agent={source.agent} />
                <div className="source-name"><strong>{source.label || AGENTS[source.agent].name}</strong><span>{source.status === "unavailable" ? "未发现本地目录" : source.status === "error" ? "读取异常" : since(source.lastSeenAt)}</span></div>
                <div className="source-numbers"><strong>{formatTokens(source.tokens)}</strong><span>{source.sessions} sessions</span></div>
                <StatusDot status={source.status} />
              </div>
            ))}
          </div>
        </div>

        <div className="panel distribution-panel">
          <div className="panel-heading"><div><span className="panel-kicker">构成</span><h2>按 Agent 分布</h2></div></div>
          <AgentDistribution agents={data?.agents ?? []} total={usage.total} />
        </div>

        <div className="panel recent-panel">
          <div className="panel-heading">
            <div><span className="panel-kicker">最近活动</span><h2>会话</h2></div>
            <a className="text-link" href="#/sessions">查看全部<ChevronRight size={14} /></a>
          </div>
          <SessionTable sessions={data?.recentSessions ?? []} compact />
        </div>
      </section>
    </>
  );
}

function Metric({ label, value, detail, primary = false }: { label: string; value: string; detail: string; primary?: boolean }) {
  return (
    <div className={`metric ${primary ? "primary" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function UsageChart({ points }: { points: SeriesPoint[] }) {
  const width = 880;
  const height = 248;
  const pad = { top: 18, right: 14, bottom: 36, left: 58 };
  const max = Math.max(1, ...points.map((point) => point.total));
  const x = (index: number) => pad.left + (index / Math.max(points.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (1 - value / max) * (height - pad.top - pad.bottom);
  const line = (key: "input" | "output") => points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point[key])}`).join(" ");
  const totalPath = points.length ? `${points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.total)}`).join(" ")} L${x(points.length - 1)},${height - pad.bottom} L${x(0)},${height - pad.bottom} Z` : "";
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const labelStep = Math.max(1, Math.ceil(points.length / 6));

  if (!points.length) {
    return <div className="empty-chart"><Activity size={22} /><span>扫描完成后，这里会显示真实 token 趋势</span></div>;
  }

  return (
    <div className="chart-wrap">
      <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Token 用量趋势图">
        <defs>
          <linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1f2de6" stopOpacity="0.17" /><stop offset="1" stopColor="#1f2de6" stopOpacity="0" /></linearGradient>
        </defs>
        {ticks.map((tick) => {
          const tickY = y(max * tick);
          return <g key={tick}><line x1={pad.left} x2={width - pad.right} y1={tickY} y2={tickY} className="grid-line" /><text x={pad.left - 10} y={tickY + 4} textAnchor="end">{formatTokens(max * tick)}</text></g>;
        })}
        <path d={totalPath} fill="url(#usage-fill)" />
        <path d={line("input")} className="chart-line input-line" />
        <path d={line("output")} className="chart-line output-line" />
        {points.map((point, index) => (
          <g key={`${point.bucket}-${index}`}>
            <circle cx={x(index)} cy={y(point.input)} r="3" className="chart-point"><title>{`${point.bucket} · 输入 ${point.input.toLocaleString()} · 输出 ${point.output.toLocaleString()}`}</title></circle>
            {(index % labelStep === 0 || index === points.length - 1) && <text x={x(index)} y={height - 10} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{formatDate(point.bucket, false)}</text>}
          </g>
        ))}
      </svg>
    </div>
  );
}

function AgentDistribution({ agents, total }: { agents: OverviewData["agents"]; total: number }) {
  const rows = [...agents].sort((a, b) => b.usage.total - a.usage.total);
  if (!rows.length) return <div className="empty-small">暂无可汇总的 token 事件</div>;
  return (
    <div className="distribution-list">
      {rows.map((row) => {
        const percentage = total ? (row.usage.total / total) * 100 : 0;
        return (
          <div className="distribution-row" key={row.agent}>
            <div className="distribution-label"><AgentMark agent={row.agent} /><strong>{AGENTS[row.agent].name}</strong><span>{row.sessions} 会话</span></div>
            <div className="distribution-value"><strong>{formatTokens(row.usage.total)}</strong><span>{percentage.toFixed(1)}%</span></div>
            <div className="distribution-track"><span style={{ width: `${Math.max(percentage, percentage ? 1.5 : 0)}%` }} /></div>
          </div>
        );
      })}
    </div>
  );
}

function SessionsPage() {
  const [items, setItems] = useState<SessionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [agent, setAgent] = useState("all");
  const [channel, setChannel] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "100", agent, channel });
    if (query.trim()) params.set("q", query.trim());
    try {
      const result = await api.sessions(params);
      setItems(result.items);
      setTotal(result.total);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "会话加载失败");
    }
  }, [agent, channel, query]);

  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 160);
    return () => window.clearTimeout(handle);
  }, [load]);
  useLiveRefresh(load);

  return (
    <>
      <section className="page-heading compact-heading">
        <div><div className="eyebrow">SESSION ARCHIVE</div><h1>会话历史</h1><p>跨 Agent 检索本地会话；token 只取各客户端实际落盘值。</p></div>
        <span className="record-count">{total.toLocaleString("zh-CN")} 条会话</span>
      </section>
      <div className="filter-bar">
        <label className="search-box"><Search size={16} /><span className="sr-only">搜索会话</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、目录或模型" /></label>
        <label className="select-wrap"><span className="sr-only">Agent</span><select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="all">全部 Agent</option>{(Object.keys(AGENTS) as AgentId[]).map((id) => <option key={id} value={id}>{AGENTS[id].name}</option>)}</select></label>
        <label className="select-wrap"><span className="sr-only">通道</span><select value={channel} onChange={(event) => setChannel(event.target.value)}><option value="all">全部通道</option><option value="desktop">Desktop</option><option value="cli">CLI</option><option value="exec">Exec</option><option value="subagent">Subagent</option><option value="sdk">SDK</option><option value="interactive">Interactive</option><option value="unknown">Other</option></select></label>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <div className="panel sessions-panel"><SessionTable sessions={items} /></div>
    </>
  );
}

function SessionTable({ sessions, compact = false }: { sessions: SessionRow[]; compact?: boolean }) {
  if (!sessions.length) {
    return <div className="empty-table"><TerminalSquare size={24} /><strong>还没有可显示的会话</strong><span>采集器会从五类 Agent 的本地历史中自动回填。</span></div>;
  }
  return (
    <div className="table-scroll">
      <table className="session-table">
        <thead><tr><th>会话</th><th>来源</th>{!compact && <th className="model-cell">模型</th>}<th className="date-cell">更新时间</th><th className="numeric token-cell">Token</th><th aria-label="打开" /></tr></thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id} onClick={() => { window.location.hash = `/sessions/${encodeURIComponent(session.id)}`; }}>
              <td><div className="session-title"><strong>{session.title || "未命名会话"}</strong><span>{session.cwd || session.externalId}</span></div></td>
              <td><div className="source-cell"><AgentMark agent={session.agent} /><span>{AGENTS[session.agent].name}<small>{session.channel}</small></span></div></td>
              {!compact && <td className="model-cell">{session.model || "—"}</td>}
              <td className="date-cell">{formatDate(session.updatedAt)}</td>
              <td className="numeric token-cell">{formatTokens(session.usage.total)}</td>
              <td><a className="row-link" href={`#/sessions/${encodeURIComponent(session.id)}`} aria-label={`打开 ${session.title}`}><ChevronRight size={16} /></a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionPage({ id }: { id: string }) {
  const [data, setData] = useState<SessionDetail | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await api.session(id));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "会话加载失败");
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  useLiveRefresh(load);

  if (error) return <div className="detail-error"><a href="#/sessions"><ArrowLeft size={15} />返回会话</a><div className="inline-error">{error}</div></div>;
  if (!data) return <div className="detail-loading">正在读取会话索引…</div>;

  return (
    <>
      <a className="back-link" href="#/sessions"><ArrowLeft size={15} />返回全部会话</a>
      <section className="session-hero">
        <div className="session-identity"><AgentMark agent={data.agent} /><div><span>{AGENTS[data.agent].name} · {data.channel}</span><h1>{data.title || "未命名会话"}</h1><p>{data.cwd || data.externalId}</p></div></div>
        <div className="session-time"><Clock3 size={15} /><span>最近更新<br /><strong>{formatDate(data.updatedAt)}</strong></span></div>
      </section>
      <section className="session-metrics">
        <Metric label="总 token" value={formatTokens(data.usage.total)} detail={`${data.usageEvents.length} 个计量事件`} primary />
        <Metric label="输入" value={formatTokens(data.usage.input)} detail={`缓存读取 ${formatTokens(data.usage.cacheRead)}`} />
        <Metric label="输出" value={formatTokens(data.usage.output)} detail={`推理 ${formatTokens(data.usage.reasoning)}`} />
        <Metric label="消息" value={data.messageCount.toLocaleString("zh-CN")} detail={data.model || "模型未记录"} />
      </section>
      <div className="detail-grid">
        <section className="panel transcript-panel">
          <div className="panel-heading"><div><span className="panel-kicker">TRANSCRIPT</span><h2>消息记录</h2></div><span className="count-label">{data.messages.length} 条</span></div>
          <div className="transcript">
            {data.messages.length ? data.messages.map((message) => (
              <article className={`message message-${message.role}`} key={message.id}>
                <header><span>{message.role === "user" ? "你" : message.role === "assistant" ? AGENTS[data.agent].name : message.role}</span><small>{message.kind} · {formatDate(message.timestamp)}</small></header>
                <pre>{message.content || "（无文本内容）"}</pre>
              </article>
            )) : <div className="empty-small">此会话没有可显示的文本消息。</div>}
          </div>
        </section>
        <aside className="panel usage-events-panel">
          <div className="panel-heading"><div><span className="panel-kicker">METER</span><h2>计量事件</h2></div></div>
          <div className="usage-event-list">
            {data.usageEvents.slice().reverse().map((event) => (
              <div className="usage-event" key={event.id}>
                <div><strong>{formatTokens(event.total)}</strong><span>{event.model || data.model || "unknown model"}</span></div>
                <small>{formatDate(event.timestamp)}<br />{formatTokens(event.input)} in / {formatTokens(event.output)} out</small>
              </div>
            ))}
            {!data.usageEvents.length && <div className="empty-small">未发现实际 token 字段。</div>}
          </div>
        </aside>
      </div>
    </>
  );
}
