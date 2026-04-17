import * as vscode from 'vscode';

export type AssistantConfig = {
  enabled: boolean;
  backendEnabled: boolean;
  backendBaseUrl: string;
  backendProjectSlug: string;
  /** Folder ID in Yandex Cloud AI Studio */
  yandexFolderId: string;

  /** Optional: existing Vector Store ID. If empty, plugin will auto-create per KB version and persist it. */
  vectorStoreId: string;

  /** Prefix for auto-created vector store names. Actual name will be `${prefix}-${kbVersion}` */
  vectorStoreNamePrefix: string;

  /** Recreate (delete + create) vector store on each reindex to avoid duplicates. */
  recreateVectorStoreOnReindex: boolean;

  /** Vector store expiration policy (required by API): days since last_active_at. */
  vectorStoreTtlDays: number;

  /** Allow the model to use web_search tool in addition to file_search. */
  enableWebSearch: boolean;

  /** Max results for SearchIndexTool (RAG). */
  searchMaxResults: number;

  /** Chunking settings (tokens). 0 means "use server defaults". */
  searchChunkMaxTokens: number;
  searchChunkOverlapTokens: number;

  docEmbeddingModelUri: string;
  queryEmbeddingModelUri: string;
  generationModelUri: string;
  codeExplainMaxChars: number;
  editorContextMaxChars: number;

  /** KB version that stores LuNA coding standards for .fa checks. */
  codeStandardsVersion: string;
};

export function getAssistantConfig(): AssistantConfig {
  const cfg = vscode.workspace.getConfiguration('luna');
  return {
    enabled: cfg.get<boolean>('assistant.enabled', false),
    backendEnabled: cfg.get<boolean>('backend.enabled', true),
    backendBaseUrl: cfg.get<string>('backend.baseUrl', 'http://localhost:8000'),
    backendProjectSlug: cfg.get<string>('backend.projectSlug', ''),
    yandexFolderId: cfg.get<string>('assistant.yandexFolderId', ''),
    vectorStoreId: cfg.get<string>('assistant.vectorStoreId', ''),
    vectorStoreNamePrefix: cfg.get<string>('assistant.vectorStoreNamePrefix', 'luna-kb'),
    recreateVectorStoreOnReindex: cfg.get<boolean>('assistant.recreateVectorStoreOnReindex', true),
    vectorStoreTtlDays: clamp(cfg.get<number>('assistant.vectorStore.ttlDays', 365), 1, 3650),
    enableWebSearch: cfg.get<boolean>('assistant.enableWebSearch', false),
    searchMaxResults: clamp(cfg.get<number>('assistant.search.maxResults', 6), 1, 20),
    searchChunkMaxTokens: clamp(cfg.get<number>('assistant.search.chunk.maxTokens', 0), 0, 2048),
    searchChunkOverlapTokens: clamp(cfg.get<number>('assistant.search.chunk.overlapTokens', 0), 0, 1024),
    docEmbeddingModelUri: cfg.get<string>('assistant.docEmbeddingModelUri', ''),
    queryEmbeddingModelUri: cfg.get<string>('assistant.queryEmbeddingModelUri', ''),
    generationModelUri: cfg.get<string>('assistant.generationModelUri', ''),
    codeExplainMaxChars: clamp(cfg.get<number>('assistant.codeExplain.maxChars', 16000), 2000, 200000),
    editorContextMaxChars: clamp(cfg.get<number>('assistant.editorContext.maxChars', 20000), 2000, 400000),
    codeStandardsVersion: cfg.get<string>('assistant.codeStandardsVersion', 'luna-standards')
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * If user didn't fill explicit model URIs but did fill folderId, we can derive defaults.
 *
 * Per Yandex AI Studio docs:
 *  - emb://<folder_ID>/text-search-doc/latest
 *  - emb://<folder_ID>/text-search-query/latest
 */
export function withDerivedDefaults(cfg: AssistantConfig): AssistantConfig {
  if (!cfg.yandexFolderId) return cfg;
  return {
    ...cfg,
    docEmbeddingModelUri: cfg.docEmbeddingModelUri || `emb://${cfg.yandexFolderId}/text-search-doc/latest`,
    queryEmbeddingModelUri: cfg.queryEmbeddingModelUri || `emb://${cfg.yandexFolderId}/text-search-query/latest`
  };
}
