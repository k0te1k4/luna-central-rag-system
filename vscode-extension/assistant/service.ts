import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { getAssistantConfig, withDerivedDefaults } from './config';
import { getApiKeyFromSecrets, setApiKeyInSecrets } from './yandexClient';
import { YandexAIStudioClient } from './aiStudioClient';
import { ensureVectorStoreWithFiles } from './vectorStoreManager';
import { LunaBackendClient } from './backendClient';
import { KnowledgeBaseService } from '../kb/service';

type ReindexMeta = {
  vectorStoreId: string;
  uploadedFileIds: string[];
  createdAtIso: string;
};

async function deleteFilesBestEffort(client: YandexAIStudioClient, fileIds: string[], signal?: AbortSignal): Promise<void> {
  // Delete with small concurrency to avoid bursts.
  const concurrency = 3;
  let idx = 0;
  const workers: Promise<void>[] = [];
  const runOne = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = idx++;
      if (i >= fileIds.length) return;
      const id = fileIds[i];
      try {
        await client.deleteFile(id);
      } catch {
        // ignore (already deleted / not found / etc.)
      }
    }
  };
  for (let i = 0; i < Math.min(concurrency, fileIds.length); i++) workers.push(runOne());
  await Promise.all(workers);
}

export class LunaAssistantService {
  private output?: vscode.OutputChannel;
  // Webviews can steal focus; VS Code may report activeTextEditor as undefined.
  // Keep the last active editor so we can still grab "current file" context.
  private lastActiveEditor?: vscode.TextEditor;

  constructor(private readonly context: vscode.ExtensionContext, private readonly kb: KnowledgeBaseService) {
    // Track last active editor. This fixes the UX where the user types in the assistant webview
    // but expects "current file" to refer to the code editor they were just working in.
    const sub = vscode.window.onDidChangeActiveTextEditor(ed => {
      if (ed) this.lastActiveEditor = ed;
    });
    this.context.subscriptions.push(sub);

    // Also initialize from the current active editor (if any) at activation time.
    if (vscode.window.activeTextEditor) this.lastActiveEditor = vscode.window.activeTextEditor;
  }

  async isEnabled(): Promise<boolean> {
    const cfg = getAssistantConfig();
    return cfg.backendEnabled || cfg.enabled;
  }

  async toggleEnabled(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('luna');
    const cur = cfg.get<boolean>('assistant.enabled', false);
    await cfg.update('assistant.enabled', !cur, vscode.ConfigurationTarget.Workspace);
  }

  async setApiKeyInteractively(): Promise<void> {
    const cfg = getAssistantConfig();
    if (cfg.backendEnabled) {
      vscode.window.showInformationMessage('При работе через backend ключи задаются в .env backend-сервиса, а не в VS Code Secret Storage.');
      return;
    }
    const key = await vscode.window.showInputBox({
      prompt: 'Введите Yandex Cloud AI Studio API key (будет сохранён в Secret Storage VS Code)',
      password: true,
      ignoreFocusOut: true
    });
    if (!key) return;
    await setApiKeyInSecrets(this.context, key.trim());
    vscode.window.showInformationMessage('API key сохранён.');
  }

  private getBackendClient(): LunaBackendClient {
    const cfg = getAssistantConfig();
    if (!cfg.backendEnabled) {
      throw new Error('Backend mode disabled.');
    }
    return new LunaBackendClient({
      enabled: cfg.backendEnabled,
      baseUrl: cfg.backendBaseUrl,
      projectSlug: cfg.backendProjectSlug
    });
  }

  private async resolveBackendProject(): Promise<{ id: string; slug: string; name: string }> {
    const client = this.getBackendClient();
    return await client.resolveProjectBySlug();
  }

  private makeBackendSessionId(folder: vscode.WorkspaceFolder | undefined): string {
    const key = folder?.uri.toString() || 'default';
    return `vscode-${Buffer.from(key).toString('base64').replace(/[^a-zA-Z0-9]/g, '')}`;
  }

  private async ensureVectorStoreForVersion(version: string, titleLabel?: string): Promise<string> {
    const baseCfg = withDerivedDefaults(getAssistantConfig());
    if (!baseCfg.enabled) throw new Error('Ассистент выключен. Включите настройку luna.assistant.enabled.');
    if (!baseCfg.yandexFolderId) {
      throw new Error('Не задан luna.assistant.yandexFolderId (это folderId каталога Yandex Cloud).');
    }

    const existing = this.context.globalState.get<string>(`luna.assistant.vectorStoreId.${version}`);
    if (existing) return existing;

    const apiKey = await getApiKeyFromSecrets(this.context);
    if (!apiKey) throw new Error('API key не задан. Запустите команду “LuNA: Set Yandex API Key”.');

    const roots = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: titleLabel || `LuNA Assistant: синхронизация базы знаний (${version})`,
        cancellable: true
      },
      async (progress: any, token: any) => {
        await this.kb.syncDocs(version, progress, token);
        await this.kb.syncUserFiles(version, progress, token);

        const docsRoot = this.kb.docsCacheRoot(version);
        const userRoot = this.kb.userFilesCacheRoot(version);
        const anyCount =
          (await countFilesByExt(docsRoot, new Set(['.md', '.markdown', '.txt', '.pdf']))) +
          (await countFilesByExt(userRoot, new Set(['.md', '.markdown', '.txt', '.pdf'])));

        if (anyCount === 0) {
          throw new Error(`В облачной базе знаний не найдено документов для версии “${version}”.`);
        }
        return { docsRoot, userRoot };
      }
    );

    const client = new YandexAIStudioClient({ apiKey, openaiProject: baseCfg.yandexFolderId });
    const cfgWithVectorStore = { ...baseCfg, vectorStoreId: '' };

    const res = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `LuNA Assistant: создание Vector Store + загрузка файлов (${version})`,
        cancellable: true
      },
      async (progress: any, token: any) => {
        return await ensureVectorStoreWithFiles({
          client,
          cfg: cfgWithVectorStore,
          kbVersion: version,
          roots: [
            { rootAbs: roots.docsRoot, prefix: 'docs' },
            { rootAbs: roots.userRoot, prefix: 'user-files' }
          ],
          progress,
          cancellationToken: token
        });
      }
    );

    await this.context.globalState.update(`luna.assistant.vectorStoreId.${version}`, res.vectorStoreId);
    await this.context.globalState.update(`luna.assistant.reindexMeta.${version}`, {
      vectorStoreId: res.vectorStoreId,
      uploadedFileIds: res.uploadedFileIds || [],
      createdAtIso: new Date().toISOString()
    } satisfies ReindexMeta);

    return res.vectorStoreId;
  }

  async reindexWiki(): Promise<void> {
    const folder = this.kb.getActiveFolder();
    if (!folder) throw new Error('Откройте папку (workspace) в VS Code.');

    const cfg = getAssistantConfig();
    if (cfg.backendEnabled) {
      const backend = this.getBackendClient();
      const project = await backend.resolveProjectBySlug();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `LuNA Backend: reindex (${project.slug})`, cancellable: false },
        async () => {
          await backend.reindexProject(project.id);
        }
      );
      vscode.window.showInformationMessage(`LuNA Backend: reindex completed for ${project.slug}.`);
      return;
    }

    const baseCfg = withDerivedDefaults(getAssistantConfig());
    if (!baseCfg.enabled) throw new Error('Ассистент выключен. Включите настройку luna.assistant.enabled.');

    const apiKey = await getApiKeyFromSecrets(this.context);
    if (!apiKey) throw new Error('API key не задан. Запустите команду “LuNA: Set Yandex API Key”.');

    const version = this.kb.getVersionForFolder(folder);

    // 1) Sync wiki docs + user files from cloud (Object Storage) into local cache.
    const roots = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `LuNA Assistant: синхронизация базы знаний (${version})`,
        cancellable: true
      },
      async (progress: any, token: any) => {
        // progress/token are VS Code types; keep as any to avoid strict typings issues in this repo snapshot.
        await this.kb.syncDocs(version, progress, token);
        await this.kb.syncUserFiles(version, progress, token);

        const docsRoot = this.kb.docsCacheRoot(version);
        const userRoot = this.kb.userFilesCacheRoot(version);
        const anyCount =
          (await countFilesByExt(docsRoot, new Set(['.md', '.markdown', '.txt', '.pdf']))) +
          (await countFilesByExt(userRoot, new Set(['.md', '.markdown', '.txt', '.pdf'])));

        if (anyCount === 0) {
          const kbCfg = vscode.workspace.getConfiguration('luna');
          const bucket = kbCfg.get<string>('kb.storage.bucket', '');
          const basePrefix = kbCfg.get<string>('kb.storage.basePrefix', 'luna-kb');
          throw new Error(
            `В облачной базе знаний не найдено документов для версии “${version}”.\n` +
              `Ожидаемый путь: s3://${bucket}/${basePrefix}/${version}/docs/ (wiki) или .../${version}/user-files/ (ваши файлы)\n` +
              `Загрузите .md/.txt/.pdf через “LuNA KB: Upload User Files (Assistant)” или проверьте, что docs/ существует.`
          );
        }
        return {
          docsRoot,
          userRoot
        };
      }
    );

    // 2) Create (or recreate) Vector Store + upload docs via Files API + attach them to Vector Store.
    if (!baseCfg.yandexFolderId) {
      throw new Error('Не задан luna.assistant.yandexFolderId (это folderId каталога Yandex Cloud).');
    }

    const client = new YandexAIStudioClient({ apiKey, openaiProject: baseCfg.yandexFolderId });

    // Best-effort cleanup of Files uploaded during the previous reindex for this KB version.
    // Without this, AI Studio "Files" may accumulate duplicates over time.
    const metaKey = `luna.assistant.reindexMeta.${version}`;
    const prevMeta = this.context.globalState.get<ReindexMeta>(metaKey);
    if (prevMeta?.uploadedFileIds?.length) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `LuNA Assistant: очистка старых файлов AI Studio (${version})`,
          cancellable: false
        },
        async () => {
          // 1) Delete previous vector store (best-effort). This helps ensure old content stops being retrieved.
          if (prevMeta.vectorStoreId) {
            try {
              await client.deleteVectorStore(prevMeta.vectorStoreId);
            } catch {
              // ignore
            }
          }
          // 2) Delete uploaded files (best-effort). Ignore errors (already deleted / in use / etc.).
          await deleteFilesBestEffort(client, prevMeta.uploadedFileIds);
        }
      );
    }

    const storedKey = `luna.assistant.vectorStoreId.${version}`;
    const cfgVectorStoreId = baseCfg.vectorStoreId || this.context.globalState.get<string>(storedKey) || '';
    const cfgWithVectorStore = { ...baseCfg, vectorStoreId: cfgVectorStoreId };

    const res = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `LuNA Assistant: создание Vector Store + загрузка файлов (${version})`,
        cancellable: true
      },
      async (progress: any, token: any) => {
        // progress/token are VS Code types; keep as any to avoid strict typings issues in this repo snapshot.
        return await ensureVectorStoreWithFiles({
          client,
          cfg: cfgWithVectorStore,
          kbVersion: version,
          roots: [
            { rootAbs: roots.docsRoot, prefix: 'docs' },
            { rootAbs: roots.userRoot, prefix: 'user-files' }
          ],
          progress,
          cancellationToken: token
        });
      }
    );

    await this.context.globalState.update(storedKey, res.vectorStoreId);
    await this.context.globalState.update(metaKey, {
      vectorStoreId: res.vectorStoreId,
      uploadedFileIds: res.uploadedFileIds || [],
      createdAtIso: new Date().toISOString()
    } satisfies ReindexMeta);

    vscode.window.showInformationMessage(`LuNA Assistant: Vector Store готов (${version}). vectorStoreId=${res.vectorStoreId}`);
  }

  async ask(question: string, onDelta?: (deltaText: string) => void): Promise<string> {
    question = await this.maybeAugmentQuestionWithEditorContext(question);
    const folder = this.kb.getActiveFolder();
    if (!folder) throw new Error('Откройте папку (workspace) в VS Code.');

    const cfg = getAssistantConfig();
    if (cfg.backendEnabled) {
      const backend = this.getBackendClient();
      const project = await backend.resolveProjectBySlug();
      const response = await backend.queryProject(project.id, {
        question,
        session_id: this.makeBackendSessionId(folder)
      });
      const final = formatAnswerWithSources(response.answer || response.raw_text || '', response.sources || []);
      if (onDelta) onDelta(final);
      return final;
    }

    const baseCfg = withDerivedDefaults(getAssistantConfig());
    if (!baseCfg.enabled) throw new Error('Ассистент выключен. Включите настройку luna.assistant.enabled.');

    const apiKey = await getApiKeyFromSecrets(this.context);
    if (!apiKey) throw new Error('API key не задан. Запустите команду “LuNA: Set Yandex API Key”.');

    if (!baseCfg.generationModelUri) {
      throw new Error('Не задан luna.assistant.generationModelUri (например gpt://<folderId>/yandexgpt-lite/latest).');
    }

    if (!baseCfg.yandexFolderId) {
      throw new Error('Не задан luna.assistant.yandexFolderId (это folderId каталога Yandex Cloud).');
    }

    const version = this.kb.getVersionForFolder(folder);
    const vectorStoreId = await this.ensureVectorStoreForVersion(version);

    if (!baseCfg.yandexFolderId) {
      throw new Error('Не задан luna.assistant.yandexFolderId (это folderId каталога Yandex Cloud).');
    }
    const client = new YandexAIStudioClient({ apiKey, openaiProject: baseCfg.yandexFolderId });

    const instruction =
      'Ты — технический ассистент по языку LuNA. ' +
      'Отвечай по-русски. ' +
      'Если используешь сведения из базы знаний, указывай источники (файлы/страницы) и не выдумывай. ' +
      'Если ответа в базе знаний нет — честно скажи об этом и предложи, какие документы стоит дополнить.';

    const tools: any[] = [
      {
        type: 'file_search',
        vector_store_ids: [vectorStoreId],
        max_num_results: baseCfg.searchMaxResults || 6
      }
    ];
    if (baseCfg.enableWebSearch) tools.push({ type: 'web_search' });

    // Persist conversation per workspace folder via previous_response_id.
    const convKey = `luna.assistant.previousResponseId.${folder.uri.toString()}`;
    const previous = this.context.globalState.get<string>(convKey) || undefined;

    let finalText = '';
    let finalResponse: any | undefined;

    await client.streamResponse(
      {
        model: baseCfg.generationModelUri,
        previous_response_id: previous,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: instruction }] },
          { role: 'user', content: [{ type: 'input_text', text: question }] }
        ],
        tool_choice: 'auto',
        tools
      },
      (evt: any) => {
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'error') {
          throw new Error(evt.message || 'Response stream error');
        }
        if (evt.type === 'response.output_text.delta') {
          const d = evt.delta ?? evt.delt ?? '';
          if (d) {
            finalText += d;
            onDelta?.(String(d));
          }
        }
        if (evt.type === 'response.completed') {
          finalResponse = evt.response;
        }
      }
    );

    if (!finalResponse) {
      // Fallback (should not normally happen): request without stream.
      finalResponse = await client.createResponse({
        model: baseCfg.generationModelUri,
        previous_response_id: previous,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: instruction }] },
          { role: 'user', content: [{ type: 'input_text', text: question }] }
        ],
        tools,
        tool_choice: 'auto'
      });
    }

    const { text, sources } = extractAnswerAndSources(finalResponse);
    finalText = text || finalText;

    if (finalResponse?.id) {
      void this.context.globalState.update(convKey, String(finalResponse.id));
    }

    return formatAnswerWithSources(finalText, sources);
  }


  /**
   * Если пользователь пишет в окне ассистента фразы вроде "в текущем файле" / "в открытой программе" /
   * "в редакторе" (или про выделение), то мы автоматически прикладываем текст из активного редактора.
   * Это убирает необходимость копировать код руками в чат.
   */
  private async maybeAugmentQuestionWithEditorContext(question: string): Promise<string> {
    const q = String(question ?? '').trim();
    if (!q) return q;

    // Triggers (RU + a bit of EN).
    // NOTE: Do NOT use \b word boundaries for Russian text.
    // JS regex word boundaries are ASCII-centric and won't reliably match Cyrillic words.
    // Use normalized substring triggers instead.
    const qNorm = q.toLowerCase();
    const wantSelection =
      [
        'в выделенном',
        'в выделении',
        'в выделенном фрагменте',
        'в выделенном коде',
        'selected code',
        'selection'
      ].some(p => qNorm.includes(p));
    const wantFile =
      [
        'в текущем файле',
        'в текущей программе',
        'в открытой программе',
        'в открытом файле',
        'в активном файле',
        'в активном редакторе',
        'в редакторе',
        'current file',
        'open file',
        'active editor'
      ].some(p => qNorm.includes(p));

    if (!wantSelection && !wantFile) return q;

    // In WebView-based UIs VS Code may report activeTextEditor as undefined.
    // Fallback to the last active editor, and then to any visible text editor.
    const editor =
      vscode.window.activeTextEditor ||
      this.lastActiveEditor ||
      vscode.window.visibleTextEditors.find(e => e?.document?.uri?.scheme === 'file');
    if (!editor) return q;

    const doc = editor.document;
    const baseCfg = withDerivedDefaults(getAssistantConfig());

    let code = '';
    let rangeStr = '';

    if (wantSelection && editor.selection && !editor.selection.isEmpty) {
      const sel = editor.selection;
      code = doc.getText(sel);
      rangeStr = `L${sel.start.line + 1}:${sel.start.character + 1}–L${sel.end.line + 1}:${sel.end.character + 1}`;
    } else if (wantFile) {
      code = doc.getText();
      rangeStr = `L1:1–L${doc.lineCount}:1`;
    } else {
      return q;
    }

    code = clampTextByChars(code, baseCfg.editorContextMaxChars || 20000);
    if (!code.trim()) return q;

    const filePath = vscode.workspace.asRelativePath(doc.uri, false);
    const language = doc.languageId;
    const fence = guessFence(language, filePath);

    const header =
      wantSelection && editor.selection && !editor.selection.isEmpty
        ? `

---
Контекст из активного редактора (выделенный фрагмент)
Файл: ${filePath}
Диапазон: ${rangeStr}
Язык/тип: ${language}

Код:

`
        : `

---
Контекст из активного редактора (текущий файл)
Файл: ${filePath}
Диапазон: ${rangeStr}
Язык/тип: ${language}

Код:

`;

    return q + header + '```' + fence + '\n' + code + '\n```';
  }



  async explainSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('Нет активного редактора.');

    const doc = editor.document;
    if (!isExplainSupported(doc)) {
      throw new Error('Explain поддерживается только для файлов .fa и .cpp/.h/.hpp.');
    }

    const sel = editor.selection;
    const selected = sel && !sel.isEmpty ? doc.getText(sel) : '';
    if (!selected.trim()) throw new Error('Нужно выделить фрагмент кода для объяснения.');

    const baseCfg = withDerivedDefaults(getAssistantConfig());
    if (!baseCfg.enabled) throw new Error('Ассистент выключен. Включите luna.assistant.enabled.');

    const apiKey = await getApiKeyFromSecrets(this.context);
    if (!apiKey) throw new Error('API key не задан. Запустите команду “LuNA: Set Yandex API Key”.');

    if (!baseCfg.generationModelUri) {
      throw new Error('Не задан luna.assistant.generationModelUri. Пример: gpt://<folderId>/yandexgpt-lite/latest');
    }

    if (!baseCfg.yandexFolderId) {
      throw new Error('Не задан luna.assistant.yandexFolderId (это folderId каталога Yandex Cloud).');
    }

    const code = clampTextByChars(selected, baseCfg.codeExplainMaxChars || 16000);

    const filePath = vscode.workspace.asRelativePath(doc.uri, false);
    const language = doc.languageId;
    const rangeStr = `L${sel.start.line + 1}:${sel.start.character + 1}–L${sel.end.line + 1}:${sel.end.character + 1}`;

    const system =
      'Ты — ассистент разработчика. Объясняй код понятно и по делу. ' +
      'Если видишь проблемы/ошибки — перечисли их отдельно. ' +
      'Если можно улучшить — предложи конкретные варианты. ' +
      'Если не хватает контекста — скажи, что именно нужно.';

    const user =
      `Задача: объясни выделенный фрагмент кода.\n` +
      `Файл: ${filePath}\n` +
      `Диапазон: ${rangeStr}\n` +
      `Язык/тип: ${language}\n\n` +
      `Код:\n` +
      '```' +
      guessFence(language, filePath) +
      '\n' +
      code +
      '\n```';

    if (!baseCfg.yandexFolderId) {
      throw new Error('Не задан luna.assistant.yandexFolderId (это folderId каталога Yandex Cloud).');
    }
    const client = new YandexAIStudioClient({ apiKey, openaiProject: baseCfg.yandexFolderId });
    const version = this.kb.getVersionForFolder(this.kb.getActiveFolder()!);
    const vectorStoreId = await this.ensureVectorStoreForVersion(version);

    const answer = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LuNA: Explain selection', cancellable: true },
      async (_progress: any, token: any) => {
        void _progress;
        const tools: any[] = [
          { type: 'file_search', vector_store_ids: [vectorStoreId], max_num_results: baseCfg.searchMaxResults || 6 }
        ];
        if (baseCfg.enableWebSearch) tools.push({ type: 'web_search' });

        const resp = await client.createResponse({
          model: baseCfg.generationModelUri,
          input: [{ role: 'user', content: [{ type: 'input_text', text: `${system}\n\n${user}` }] }],
          tools,
          tool_choice: 'auto'
        });
        const { text, sources } = extractAnswerAndSources(resp);
        return formatAnswerWithSources(text, sources);
      }
    );

    this.getOutput().appendLine(`--- Explain Selection: ${filePath} (${rangeStr}) ---`);
    this.getOutput().appendLine(answer.trim());
    this.getOutput().appendLine('');
    this.getOutput().show(true);
  }

  /**
   * Called when LuNA KB version for a workspace folder changes.
   * We drop all "tails" from the previous version: conversation state and vector store.
   */
  async handleVersionChange(folder: vscode.WorkspaceFolder, oldVersion: string, newVersion: string): Promise<void> {
    // 1) Reset conversation context for this workspace.
    const convKey = `luna.assistant.previousResponseId.${folder.uri.toString()}`;
    await this.context.globalState.update(convKey, undefined as any);

    // 2) Best-effort delete previous version vector store, so it can't be used by mistake.
    const oldVsKey = `luna.assistant.vectorStoreId.${oldVersion}`;
    const oldVsId = this.context.globalState.get<string>(oldVsKey) || '';
    if (oldVsId) {
      try {
        const baseCfg = withDerivedDefaults(getAssistantConfig());
        const apiKey = await getApiKeyFromSecrets(this.context);
        if (apiKey && baseCfg.yandexFolderId) {
          const client = new YandexAIStudioClient({ apiKey, openaiProject: baseCfg.yandexFolderId });
          await client.deleteVectorStore(oldVsId);
        }
      } catch {
        // ignore
      }
      await this.context.globalState.update(oldVsKey, undefined as any);
    }

    // 3) Remove local caches for the old version (wiki + user-files).
    try {
      await fs.rm(this.kb.docsCacheRoot(oldVersion), { recursive: true, force: true } as any);
      await fs.rm(this.kb.userFilesCacheRoot(oldVersion), { recursive: true, force: true } as any);
    } catch {
      // ignore
    }

    // 4) Force reindex for the new version (don’t accidentally use stale ID).
    const newVsKey = `luna.assistant.vectorStoreId.${newVersion}`;
    await this.context.globalState.update(newVsKey, undefined as any);

    vscode.window.showInformationMessage(
      `LuNA version changed: ${oldVersion} → ${newVersion}. Please run “LuNA: Reindex Knowledge Base for Assistant”.`
    );
  }

  async explainFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('Нет активного редактора.');

    const doc = editor.document;
    if (!isExplainSupported(doc)) {
      throw new Error('Explain поддерживается только для файлов .fa и .cpp/.h/.hpp.');
    }

    const baseCfg = withDerivedDefaults(getAssistantConfig());
    if (!baseCfg.enabled) throw new Error('Ассистент выключен. Включите luna.assistant.enabled.');

    const apiKey = await getApiKeyFromSecrets(this.context);
    if (!apiKey) throw new Error('API key не задан. Запустите команду “LuNA: Set Yandex API Key”.');

    if (!baseCfg.generationModelUri) {
      throw new Error('Не задан luna.assistant.generationModelUri. Пример: gpt://<folderId>/yandexgpt-lite/latest');
    }

    if (!baseCfg.yandexFolderId) {
      throw new Error('Не задан luna.assistant.yandexFolderId (это folderId каталога Yandex Cloud).');
    }

    const filePath = vscode.workspace.asRelativePath(doc.uri, false);
    const language = doc.languageId;

    const code = clampTextByChars(doc.getText(), baseCfg.codeExplainMaxChars || 16000);

    const system =
      'Ты — ассистент разработчика. Объясни файл: назначение, структура, важные функции/классы, ' +
      'как это работает, типичные ошибки и места для улучшений. ' +
      'Если файл слишком большой и обрезан — скажи, чего не хватает.';

    const user =
      `Задача: объясни файл целиком.\n` +
      `Файл: ${filePath}\n` +
      `Язык/тип: ${language}\n\n` +
      `Код:\n` +
      '```' +
      guessFence(language, filePath) +
      '\n' +
      code +
      '\n```';

    if (!baseCfg.yandexFolderId) {
      throw new Error('Не задан luna.assistant.yandexFolderId (это folderId каталога Yandex Cloud).');
    }
    const client = new YandexAIStudioClient({ apiKey, openaiProject: baseCfg.yandexFolderId });
    const version = this.kb.getVersionForFolder(this.kb.getActiveFolder()!);
    const vectorStoreId = await this.ensureVectorStoreForVersion(version);

    const answer = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LuNA: Explain file', cancellable: true },
      async (_progress: any, token: any) => {
        void _progress;
        const tools: any[] = [
          { type: 'file_search', vector_store_ids: [vectorStoreId], max_num_results: baseCfg.searchMaxResults || 6 }
        ];
        if (baseCfg.enableWebSearch) tools.push({ type: 'web_search' });

        const resp = await client.createResponse({
          model: baseCfg.generationModelUri,
          input: [{ role: 'user', content: [{ type: 'input_text', text: `${system}\n\n${user}` }] }],
          tools,
          tool_choice: 'auto'
        });
        const { text, sources } = extractAnswerAndSources(resp);
        return formatAnswerWithSources(text, sources);
      }
    );

    this.getOutput().appendLine(`--- Explain File: ${filePath} ---`);
    this.getOutput().appendLine(answer.trim());
    this.getOutput().appendLine('');
    this.getOutput().show(true);
  }

  async checkFileAgainstStandards(onDelta?: (deltaText: string) => void): Promise<string> {
    const editor = vscode.window.activeTextEditor || this.lastActiveEditor;
    if (!editor) throw new Error('Нет активного редактора.');

    const doc = editor.document;
    if (!doc.uri.fsPath.toLowerCase().endsWith('.fa')) {
      throw new Error('Проверка по стандартам доступна только для файлов .fa.');
    }

    const baseCfg = withDerivedDefaults(getAssistantConfig());
    if (!baseCfg.enabled) throw new Error('Ассистент выключен. Включите luna.assistant.enabled.');

    const apiKey = await getApiKeyFromSecrets(this.context);
    if (!apiKey) throw new Error('API key не задан. Запустите команду “LuNA: Set Yandex API Key”.');

    if (!baseCfg.generationModelUri) {
      throw new Error('Не задан luna.assistant.generationModelUri. Пример: gpt://<folderId>/yandexgpt-lite/latest');
    }

    if (!baseCfg.yandexFolderId) {
      throw new Error('Не задан luna.assistant.yandexFolderId (это folderId каталога Yandex Cloud).');
    }

    const standardsVersion = (baseCfg.codeStandardsVersion || '').trim();
    if (!standardsVersion) {
      throw new Error('Не задана версия стандартов luna.assistant.codeStandardsVersion.');
    }

    const filePath = vscode.workspace.asRelativePath(doc.uri, false);
    const code = clampTextByChars(doc.getText(), baseCfg.codeExplainMaxChars || 16000);

    const system =
      'Ты — строгий ревьюер кода LuNA (.fa). ' +
      'Проверяй файл только по документам из базы стандартов. ' +
      'Не используй общую документацию LuNA, если она не находится в этой базе стандартов. ' +
      'Отвечай по-русски. ' +
      'Сначала дай краткий вердикт, затем список нарушений, затем список рекомендаций. ' +
      'Для каждого нарушения указывай конкретный фрагмент стандарта и степень уверенности. ' +
      'В конце обязательно добавь раздел “Использованные источники” со списком реально использованных файлов стандартов. ' +
      'Если нарушение не подтверждается источником, не придумывай его.';

    const user = [
      'Проверь файл .fa на соответствие стандартам кода.',
      `Файл: ${filePath}`,
      '',
      'Код:',
      '```luna',
      code,
      '```'
    ].join('\n');

    const vectorStoreId = await this.ensureVectorStoreForVersion(
      standardsVersion,
      `LuNA Assistant: подготовка базы стандартов (${standardsVersion})`
    );
    const client = new YandexAIStudioClient({ apiKey, openaiProject: baseCfg.yandexFolderId });

    let finalText = '';
    let finalResponse: any | undefined;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LuNA: Check .fa against standards', cancellable: true },
      async (_progress: any, token: any) => {
        void _progress;
        const tools: any[] = [
          { type: 'file_search', vector_store_ids: [vectorStoreId], max_num_results: Math.max(baseCfg.searchMaxResults || 6, 8) }
        ];
        if (baseCfg.enableWebSearch) tools.push({ type: 'web_search' });

        await client.streamResponse(
          {
            model: baseCfg.generationModelUri,
            input: [
              { role: 'system', content: [{ type: 'input_text', text: system }] },
              { role: 'user', content: [{ type: 'input_text', text: user }] }
            ],
            tools,
            tool_choice: 'auto'
          },
          (evt: any) => {
            if (!evt || typeof evt !== 'object') return;
            if (evt.type === 'error') {
              throw new Error(evt.message || 'Response stream error');
            }
            if (evt.type === 'response.output_text.delta') {
              const d = evt.delta ?? evt.delt ?? '';
              if (d) {
                finalText += d;
                onDelta?.(String(d));
              }
            }
            if (evt.type === 'response.completed') {
              finalResponse = evt.response;
            }
          },
          { signal: abortSignalFromCancellationToken(token) }
        );
      }
    );

    if (!finalResponse) {
      finalResponse = await client.createResponse({
        model: baseCfg.generationModelUri,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: system }] },
          { role: 'user', content: [{ type: 'input_text', text: user }] }
        ],
        tools: [
          { type: 'file_search', vector_store_ids: [vectorStoreId], max_num_results: Math.max(baseCfg.searchMaxResults || 6, 8) },
          ...(baseCfg.enableWebSearch ? [{ type: 'web_search' as const }] : [])
        ],
        tool_choice: 'auto'
      });
    }

    const { text, sources } = extractAnswerAndSources(finalResponse);
    return formatAnswerWithSources(text || finalText, sources);
  }

  private getOutput(): vscode.OutputChannel {
    if (!this.output) {
      this.output = vscode.window.createOutputChannel('LuNA Assistant');
    }
    return this.output;
  }
}

type SourceRef = { file?: string; quote?: string; page?: number; line?: string };

function extractAnswerAndSources(resp: any): { text: string; sources: SourceRef[] } {
  const sources: SourceRef[] = [];
  const texts: string[] = [];

  const output = resp?.output || resp?.output_items || [];
  for (const item of output) {
    if (item?.type !== 'message') continue;
    const content = item?.content || [];
    for (const part of content) {
      if (part?.type === 'output_text') {
        const t = String(part?.text || '');
        if (t) texts.push(t);

        const anns = part?.annotations || [];
        for (const a of anns) {
          // File citations usually provide filename, plus optional page/line.
          const file = a?.filename || a?.file?.filename || a?.file_name || a?.file_id || undefined;
          const quote = a?.quote || a?.text || undefined;
          const page = typeof a?.page_number === 'number' ? a.page_number : typeof a?.page === 'number' ? a.page : undefined;
          const line = a?.line || a?.location || undefined;
          sources.push({ file, quote, page, line });
        }
      }
    }
  }

  return { text: texts.join('').trim(), sources: dedupeSources(sources) };
}

function dedupeSources(srcs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const s of srcs) {
    const key = JSON.stringify({ f: s.file || '', p: s.page || '', l: s.line || '', q: (s.quote || '').slice(0, 80) });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function formatAnswerWithSources(answer: string, sources: SourceRef[]): string {
  const a = (answer || '').trim();
  if (!sources?.length) return a;

  const lines: string[] = [];
  lines.push(a);
  lines.push('');
  lines.push('Источники:');
  for (const s of sources.slice(0, 12)) {
    const parts: string[] = [];
    if (s.file) parts.push(s.file);
    if (typeof s.page === 'number') parts.push(`стр. ${s.page}`);
    if (s.line) parts.push(String(s.line));
    const head = parts.length ? parts.join(', ') : 'файл';
    if (s.quote) {
      const q = String(s.quote).replace(/\s+/g, ' ').trim();
      lines.push(`- ${head}: “${q.slice(0, 220)}${q.length > 220 ? '…' : ''}”`);
    } else {
      lines.push(`- ${head}`);
    }
  }
  if (sources.length > 12) lines.push(`- …и ещё ${sources.length - 12} источник(ов)`);
  return lines.join('\n');
}

function isExplainSupported(doc: vscode.TextDocument): boolean {
  const fsPath = doc.uri.fsPath.toLowerCase();
  if (fsPath.endsWith('.fa')) return true;
  if (fsPath.endsWith('.cpp') || fsPath.endsWith('.cc') || fsPath.endsWith('.cxx')) return true;
  if (fsPath.endsWith('.h') || fsPath.endsWith('.hpp') || fsPath.endsWith('.hh')) return true;
  return false;
}

function clampTextByChars(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n\n/* …TRUNCATED: original length ${s.length} chars, limit ${maxChars}… */`;
}

async function countFilesByExt(rootAbs: string, exts: Set<string>): Promise<number> {
  try {
    const st = await fs.stat(rootAbs);
    if (!st.isDirectory()) return 0;
  } catch {
    return 0;
  }

  let count = 0;
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
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (exts.has(ext)) count++;
      }
    }
  }
  return count;
}

function guessFence(languageId: string, filePath: string): string {
  const fp = filePath.toLowerCase();
  if (fp.endsWith('.fa')) return 'luna';
  if (languageId.includes('cpp') || fp.endsWith('.cpp') || fp.endsWith('.hpp') || fp.endsWith('.h')) return 'cpp';
  return '';
}

/**
 * Convert VS Code CancellationToken -> AbortSignal (for fetch()).
 * Works on Node 18+ (VS Code extension host).
 */
function abortSignalFromCancellationToken(token: vscode.CancellationToken): AbortSignal | undefined {
  if (!token) return undefined;
  const ac = new AbortController();
  if (token.isCancellationRequested) {
    ac.abort();
    return ac.signal;
  }
  token.onCancellationRequested(() => ac.abort());
  return ac.signal;
}
