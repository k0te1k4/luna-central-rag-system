import * as vscode from 'vscode';

export type KnowledgeBaseConfig = {
  /** Enable cloud knowledge base (Yandex Object Storage). */
  enabled: boolean;
  /** Bucket name in Object Storage. */
  bucket: string;
  /** Endpoint for S3 API. */
  endpoint: string;
  /** S3 region. For Yandex Cloud typical value is 'ru-central1'. */
  region: string;
  /**
   * Base prefix inside bucket. All KB objects live under this prefix.
   * Example: 'luna-kb'
   */
  basePrefix: string;
  /** Default version name (used if project version is not set). */
  defaultVersion: string;
  /**
   * If non-empty, limits the list of selectable versions.
   * Otherwise versions are discovered from bucket.
   */
  knownVersions: string[];
};

export function getKbConfig(): KnowledgeBaseConfig {
  const cfg = vscode.workspace.getConfiguration('luna');
  return {
    enabled: cfg.get<boolean>('kb.enabled', true),
    bucket: cfg.get<string>('kb.storage.bucket', ''),
    endpoint: cfg.get<string>('kb.storage.endpoint', 'https://storage.yandexcloud.net'),
    region: cfg.get<string>('kb.storage.region', 'ru-central1'),
    basePrefix: normalizePrefix(cfg.get<string>('kb.storage.basePrefix', 'luna-kb')),
    defaultVersion: cfg.get<string>('kb.defaultVersion', 'luna7'),
    knownVersions: (cfg.get<string[]>('kb.knownVersions', []) || []).filter(Boolean)
  };
}

export function normalizePrefix(p: string): string {
  const s = String(p || '').trim();
  if (!s) return '';
  return s.replace(/^\/+/, '').replace(/\/+$/, '');
}
