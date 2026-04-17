import * as path from 'path';
import * as fs from 'fs/promises';
import { YandexAIStudioClient } from './aiStudioClient';
import { AssistantConfig } from './config';

export type EnsureVectorStoreResult = {
  vectorStoreId: string;
  uploadedFileIds: string[];
};

function guessMimeTypeByExt(ext: string): string | undefined {
  const e = ext.toLowerCase();
  if (e === '.md' || e === '.markdown') return 'text/markdown';
  if (e === '.txt') return 'text/plain';
  if (e === '.pdf') return 'application/pdf';
  return undefined;
}

async function walkFiles(rootAbs: string, exts: Set<string>): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [rootAbs];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: any[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true } as any);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (exts.has(ext)) out.push(p);
      }
    }
  }
  out.sort();
  return out;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

async function waitVectorStoreReady(client: YandexAIStudioClient, vectorStoreId: string, opts?: { signal?: AbortSignal }): Promise<any> {
  const started = Date.now();
  const timeoutMs = 15 * 60 * 1000;
  for (;;) {
    if (opts?.signal?.aborted) throw new Error('Cancelled');
    const vs = await client.getVectorStore(vectorStoreId);
    const status = String(vs?.status || '');
    if (status === 'completed') return vs;
    if (status === 'expired') throw new Error('Vector store expired');
    if (Date.now() - started > timeoutMs) throw new Error(`Vector store processing timeout (id=${vectorStoreId})`);
    await sleep(1000);
  }
}

async function waitFileBatchReady(
  client: YandexAIStudioClient,
  vectorStoreId: string,
  batchId: string,
  opts?: {
    signal?: AbortSignal;
    progress?: { report: (p: { increment?: number; message?: string }) => void };
    /** Human label shown in progress messages, e.g. "Пакет 1/3" */
    label?: string;
    /** Fallback total files count if API doesn't return counts. */
    totalFilesHint?: number;
  }
): Promise<any> {
  const started = Date.now();
  const timeoutMs = 30 * 60 * 1000;
  let lastMsg = '';
  let lastDone = -1;
  for (;;) {
    if (opts?.signal?.aborted) throw new Error('Cancelled');
    const b = await client.getVectorStoreFileBatch(vectorStoreId, batchId);
    const st = String(b?.status || '');

    // Best-effort progress reporting.
    // OpenAI-compatible APIs typically return `file_counts` (completed/failed/in_progress/total).
    const fc: any = b?.file_counts || b?.fileCounts;
    const total =
      Number(fc?.total ?? fc?.all ?? fc?.count ?? opts?.totalFilesHint ?? 0) || opts?.totalFilesHint || 0;
    const completed = Number(fc?.completed ?? fc?.succeeded ?? fc?.done ?? 0) || 0;
    const failed = Number(fc?.failed ?? fc?.error ?? 0) || 0;
    const inProgress = Number(fc?.in_progress ?? fc?.inProgress ?? 0) || 0;

    const elapsedSec = Math.floor((Date.now() - started) / 1000);
    const label = opts?.label ? `${opts.label}: ` : '';
    const countsPart = total > 0 ? `${completed}/${total}` : `${completed}`;
    const extraPart = total > 0 ? `, in_progress=${inProgress}, failed=${failed}` : '';
    const msg = `${label}индексация: ${st} (${countsPart}${extraPart}), прошло ${elapsedSec}s`;
    // Avoid spamming the UI: report only when something changes.
    if (opts?.progress && (msg !== lastMsg || completed !== lastDone)) {
      opts.progress.report({ message: msg });
      lastMsg = msg;
      lastDone = completed;
    }

    if (st === 'completed') return b;
    if (st === 'failed') throw new Error(`Vector store file batch failed (id=${batchId})`);
    if (st === 'cancelled') throw new Error(`Vector store file batch cancelled (id=${batchId})`);
    if (Date.now() - started > timeoutMs) throw new Error(`Vector store file batch timeout (id=${batchId})`);
    await sleep(1000);
  }
}

function is429(e: any): boolean {
  const msg = String(e?.message || '');
  return msg.includes('API error 429') || msg.includes('429');
}

async function with429Backoff<T>(fn: () => Promise<T>, what: string, maxAttempts = 8): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e: any) {
      attempt++;
      if (!is429(e) || attempt >= maxAttempts) throw e;
      // Exponential backoff with cap.
      const delay = Math.min(60_000, 1_000 * Math.pow(2, attempt));
      await sleep(delay);
      void what;
    }
  }
}

export async function ensureVectorStoreWithFiles(args: {
  client: YandexAIStudioClient;
  cfg: AssistantConfig;
  kbVersion: string;
  roots: Array<{ rootAbs: string; prefix: string }>;
  progress?: { report: (p: { increment?: number; message?: string }) => void };
  cancellationToken?: { isCancellationRequested: boolean };
}): Promise<EnsureVectorStoreResult> {
  const { client, cfg, kbVersion, roots, progress, cancellationToken } = args;

  const desiredName = `${cfg.vectorStoreNamePrefix || 'luna-kb'}-${kbVersion}`;

  // Try to find existing vector store by explicit id, then by name.
  let current: any | undefined;
  if (cfg.vectorStoreId) {
    try {
      current = await client.getVectorStore(cfg.vectorStoreId);
    } catch {
      current = undefined;
    }
  }
  if (!current) {
    const listed = await client.listVectorStores();
    current = listed?.data?.find((x: any) => x?.name === desiredName);
  }

  if (current && cfg.recreateVectorStoreOnReindex) {
    progress?.report({ message: `Удаляю старый vector store: ${current.name}…` });
    try {
      await client.deleteVectorStore(current.id);
    } catch {
      // ignore
    }
    current = undefined;
  }

  if (!current) {
    progress?.report({ message: `Создаю vector store: ${desiredName}…` });
    const body: any = {
      name: desiredName,
      // Vector store expiration policy is required by API.
      expires_after: { anchor: 'last_active_at', days: cfg.vectorStoreTtlDays || 365 }
    };
    // Optional chunking strategy.
    if (cfg.searchChunkMaxTokens > 0) {
      body.chunking_strategy = {
        type: 'static',
        static: {
          max_chunk_size_tokens: Math.max(100, Math.min(4096, cfg.searchChunkMaxTokens)),
          chunk_overlap_tokens: Math.max(0, Math.min(2048, cfg.searchChunkOverlapTokens || 0))
        }
      };
    }
    current = await client.createVectorStore(body);
    if (!current?.id) throw new Error('Не удалось создать vector store: ответ без id');
  }

  // Upload files.
  const exts = new Set(['.md', '.markdown', '.txt', '.pdf']);
  const filesWithRel: Array<{ abs: string; rel: string }> = [];
  for (const r of roots) {
    const rootFiles = await walkFiles(r.rootAbs, exts);
    for (const abs of rootFiles) {
      const relInside = path.relative(r.rootAbs, abs).replace(/\\/g, '/');
      const rel = `${r.prefix.replace(/\/+$/,'')}/${relInside}`.replace(/\/+/g, '/');
      filesWithRel.push({ abs, rel });
    }
  }
  filesWithRel.sort((a,b)=>a.rel.localeCompare(b.rel));
  const files = filesWithRel;
  if (!files.length) throw new Error('В локальном кэше базы знаний не найдено файлов .md/.txt/.pdf для индексации.');

  const uploadedFileIds: string[] = [];

  // Upload files first (this does NOT start indexing operations).
  for (let i = 0; i < files.length; i++) {
    if (cancellationToken?.isCancellationRequested) throw new Error('Cancelled');

    const abs = files[i].abs;
    const rel = files[i].rel;
    progress?.report({ message: `Загружаю файл ${i + 1}/${files.length}: ${rel}` });

    const buf = await fs.readFile(abs);
    const mime = guessMimeTypeByExt(path.extname(abs));
    const fileObj = await client.uploadFile({ filename: rel, content: buf, mimeType: mime, purpose: 'assistants' });
    uploadedFileIds.push(fileObj.id);
  }

  // Attach files to vector store using File Batches to avoid hitting the limit
  // of concurrent indexing operations.
  // 1 batch == 1 indexing operation. Keep it <= 10 concurrent ops quota.
  // We process batches sequentially, so this mainly controls payload size.
  const batchSize = 50;
  for (let start = 0; start < uploadedFileIds.length; start += batchSize) {
    if (cancellationToken?.isCancellationRequested) throw new Error('Cancelled');
    const slice = uploadedFileIds.slice(start, start + batchSize);
    progress?.report({ message: `Индексирую пакет ${Math.floor(start / batchSize) + 1}/${Math.ceil(uploadedFileIds.length / batchSize)} (${slice.length} файлов)…` });

    const body: any = {
      file_ids: slice
    };
    if (cfg.searchChunkMaxTokens > 0) {
      body.chunking_strategy = {
        type: 'static',
        static: {
          max_chunk_size_tokens: Math.max(100, Math.min(4096, cfg.searchChunkMaxTokens)),
          chunk_overlap_tokens: Math.max(0, Math.min(2048, cfg.searchChunkOverlapTokens || 0))
        }
      };
    }

    const batch = await with429Backoff(
      () => client.createVectorStoreFileBatch(current.id, body),
      'createVectorStoreFileBatch'
    );
    if (!batch?.id) throw new Error('Не удалось создать file batch: ответ без id');

    await waitFileBatchReady(client, current.id, String(batch.id), {
      progress,
      label: `Пакет ${Math.floor(start / batchSize) + 1}/${Math.ceil(uploadedFileIds.length / batchSize)}`,
      totalFilesHint: slice.length
    });
  }

  progress?.report({ message: `Проверяю готовность vector store…` });
  await waitVectorStoreReady(client, current.id);

  return { vectorStoreId: current.id, uploadedFileIds };
}
