export type BackendConfig = {
  enabled: boolean;
  baseUrl: string;
  projectSlug: string;
};

export type BackendProject = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  provider_config_id: string;
  storage_prefix: string;
  active_vector_store_id?: string;
  last_indexed_at?: string;
  created_at: string;
  updated_at: string;
};

export type BackendQueryResponse = {
  answer: string;
  sources: Array<{ file?: string; quote?: string; page?: number; line?: string }>;
  raw_text?: string;
  response_id?: string;
};

export class LunaBackendClient {
  constructor(private readonly cfg: BackendConfig) {}

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private async req<T>(method: string, path: string, body?: any): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : undefined; } catch {}
    if (!res.ok) {
      const msg = parsed?.detail || parsed?.message || text || `HTTP ${res.status}`;
      throw new Error(`LuNA backend error ${res.status}: ${msg}`);
    }
    return parsed as T;
  }

  async listProjects(): Promise<BackendProject[]> {
    return await this.req<BackendProject[]>('GET', '/api/projects');
  }

  async resolveProjectBySlug(): Promise<BackendProject> {
    if (!this.cfg.projectSlug) {
      throw new Error('Не задана настройка luna.backend.projectSlug.');
    }
    const projects = await this.listProjects();
    const project = projects.find(p => p.slug === this.cfg.projectSlug);
    if (!project) throw new Error(`Проект со slug "${this.cfg.projectSlug}" не найден в backend.`);
    return project;
  }

  async reindexProject(projectId: string): Promise<any> {
    return await this.req<any>('POST', `/api/projects/${encodeURIComponent(projectId)}/reindex`);
  }

  async queryProject(projectId: string, payload: { question: string; session_id?: string; editor_context?: string }): Promise<BackendQueryResponse> {
    return await this.req<BackendQueryResponse>('POST', `/api/projects/${encodeURIComponent(projectId)}/query`, payload);
  }
}
