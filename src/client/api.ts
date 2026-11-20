import type { HealthData, OverviewData, SessionDetail, SessionRow, SourceStatus } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<HealthData>("/api/health"),
  sources: () => request<SourceStatus[]>("/api/sources"),
  overview: (range: string, agent: string) =>
    request<OverviewData>(`/api/overview?range=${encodeURIComponent(range)}&agent=${encodeURIComponent(agent)}`),
  sessions: (params: URLSearchParams) => request<{ items: SessionRow[]; total: number }>(`/api/sessions?${params}`),
  session: (id: string) => request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  rescan: () => request<{ accepted: boolean }>("/api/rescan", { method: "POST" }),
};
