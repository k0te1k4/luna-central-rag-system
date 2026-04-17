import * as vscode from 'vscode';
import * as path from 'path';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

import { LunaAssistantService } from './assistant/service';
import { AssistantPanel } from './assistant/panel';
import { KnowledgeBaseStorage } from './kb/storage';
import { KnowledgeBaseService } from './kb/service';
import { KnowledgeBaseTreeProvider } from './kb/tree';
import { LunaProjectsTreeProvider } from './kb/projectsView';
import { registerKbCommands } from './kb/commands';

let client: LanguageClient | undefined;

const LUNA_KEYWORDS = [
  'sub', 'df', 'cf', 'stealable', 'import',
  'request', 'req_count', 'delete',
  'nfparam', 'locator_cyclic', 'locator_replicating',
  'after', 'let', 'for', 'while', 'if',
  'int', 'real', 'string', 'name', 'value'
];

const LUNA_SNIPPETS: { label: string; insertText: vscode.SnippetString; documentation: string }[] = [
  {
    label: 'cf fragment',
    insertText: new vscode.SnippetString('cf ${1:name}: ${2:func}(${3:args});'),
    documentation: 'Фрагмент вычислений LuNA (code fragment)'
  },
  {
    label: 'sub block',
    insertText: new vscode.SnippetString('sub ${1:name}(${2:params}) {\n\t$0\n}'),
    documentation: 'Субпрограмма LuNA'
  },
  {
    label: 'recommendation block',
    insertText: new vscode.SnippetString('@ {\n\t${1:request x;}\n}'),
    documentation: 'Блок рекомендаций LuNA'
  }
];

export function activate(context: vscode.ExtensionContext) {
  // --- Knowledge Base (Yandex Object Storage) ---
  const kbStorage = new KnowledgeBaseStorage(context);
  const kbService = new KnowledgeBaseService(context, kbStorage);

  const kbTreeProvider = new KnowledgeBaseTreeProvider(context, kbStorage);
  const projectsTreeProvider = new LunaProjectsTreeProvider();

  // Register Tree Views
  vscode.window.createTreeView('lunaKnowledgeBaseView', { treeDataProvider: kbTreeProvider });
  vscode.window.createTreeView('lunaProjectsView', { treeDataProvider: projectsTreeProvider });

  // Status bar: KB version
  const kbStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  kbStatus.command = 'luna.kb.statusBar.selectVersion';
  kbStatus.show();
  context.subscriptions.push(kbStatus);

  registerKbCommands({ context, kb: kbService, storage: kbStorage, tree: kbTreeProvider, projects: projectsTreeProvider, statusBar: kbStatus });

  // --- AI Assistant ---
  const assistant = new LunaAssistantService(context, kbService);

  const panel = new AssistantPanel(context, {
    onAsk: async (q, onDelta) => assistant.ask(q, onDelta),
    onReindex: async () => assistant.reindexWiki()
  });

  // --- Commands (MUST match package.json exactly) ---
  context.subscriptions.push(
    vscode.commands.registerCommand('luna.assistant.open', async () => {
      try {
        panel.show();
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      }
    }),

    vscode.commands.registerCommand('luna.assistant.reindexWiki', async () => {
      try {
        await assistant.reindexWiki();
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      }
    }),

    vscode.commands.registerCommand('luna.assistant.toggle', async () => {
      try {
        await assistant.toggleEnabled();
        const enabled = await assistant.isEnabled();
        vscode.window.showInformationMessage(`LuNA AI Assistant: ${enabled ? 'enabled' : 'disabled'}.`);
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      }
    }),

    vscode.commands.registerCommand('luna.assistant.setApiKey', async () => {
      try {
        await assistant.setApiKeyInteractively();
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      }
    }),

    // NEW: explain selection
    vscode.commands.registerCommand('luna.assistant.explainSelection', async () => {
      try {
        panel.show();
        // Use the same chat UI, but inject editor selection as context.
        await panel.runAsk('Объясни, что делает код в выделенном фрагменте.');
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      }
    }),

    // NEW: explain whole file
    vscode.commands.registerCommand('luna.assistant.explainFile', async () => {
      try {
        panel.show();
        // Use the chat UI, and let the service automatically attach the current file.
        await panel.runAsk('Объясни, что делает код в текущем файле.');
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      }
    }),

    vscode.commands.registerCommand('luna.assistant.checkStandards', async () => {
      try {
        panel.show();
        await panel.runCustom('Проверь текущий .fa файл на соответствие стандартам LuNA.', onDelta =>
          assistant.checkFileAgainstStandards(onDelta)
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      }
    })
  );

  // --- Status bar ---
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'luna.assistant.open';
  status.tooltip = 'LuNA AI Assistant (Knowledge Base RAG)';
  status.text = 'LuNA AI: off';
  status.show();
  context.subscriptions.push(status);

  const updateStatus = async () => {
    try {
      const enabled = await assistant.isEnabled();
      status.text = enabled ? 'LuNA AI: on' : 'LuNA AI: off';
    } catch {
      status.text = 'LuNA AI: ?';
    }
  };

  updateStatus();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('luna.assistant.enabled')) {
        updateStatus();
      }

      // Drop tails when LuNA KB version changes for any workspace folder.
      if (e.affectsConfiguration('luna.kb.projectVersion') || e.affectsConfiguration('luna.kb.defaultVersion')) {
        for (const f of vscode.workspace.workspaceFolders || []) {
          const cur = kbService.getVersionForFolder(f);
          const key = `luna.kb._lastSeenVersion.${f.uri.toString()}`;
          const prev = context.globalState.get<string>(key) || cur;
          if (prev !== cur) {
            void assistant.handleVersionChange(f, prev, cur);
            void context.globalState.update(key, cur);
          }
        }
      }
    })
  );

  // Initialize last-seen versions for open folders.
  for (const f of vscode.workspace.workspaceFolders || []) {
    const key = `luna.kb._lastSeenVersion.${f.uri.toString()}`;
    void context.globalState.update(key, kbService.getVersionForFolder(f));
  }

  // --- Completion provider for .fa and ucodes.cpp ---
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'luna' },
    { scheme: 'file', language: 'cpp', pattern: '**/ucodes.cpp' }
  ];

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    selector,
    {
      provideCompletionItems() {
        const keywordItems = LUNA_KEYWORDS.map(kw => {
          const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
          item.insertText = kw;
          return item;
        });

        const snippetItems = LUNA_SNIPPETS.map(sn => {
          const item = new vscode.CompletionItem(sn.label, vscode.CompletionItemKind.Snippet);
          item.insertText = sn.insertText;
          item.documentation = new vscode.MarkdownString(sn.documentation);
          return item;
        });

        return [...keywordItems, ...snippetItems];
      }
    }
  );

  context.subscriptions.push(completionProvider);

  // --- LSP client for LuNA (.fa) ---
  const serverModule = context.asAbsolutePath(path.join('server', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] }
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'luna' },
      { scheme: 'file', language: 'cpp' } // если у тебя LSP реально понимает cpp — ок; иначе можно убрать
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{fa,cpp}')
    }
  };

  client = new LanguageClient('lunaLanguageServer', 'LuNA Language Server', serverOptions, clientOptions);
  client.start();

  // --- Suggest ucodes.cpp near .fa ---
  const faWatcher = vscode.workspace.createFileSystemWatcher('**/*.fa');
  faWatcher.onDidCreate(uri => checkOrSuggestUcodes(uri));
  faWatcher.onDidChange(uri => checkOrSuggestUcodes(uri));
  context.subscriptions.push(faWatcher);
}

async function checkOrSuggestUcodes(faUri: vscode.Uri) {
  const dir = path.dirname(faUri.fsPath);
  const ucodesPath = path.join(dir, 'ucodes.cpp');
  const ucodesUri = vscode.Uri.file(ucodesPath);

  try {
    await vscode.workspace.fs.stat(ucodesUri);
  } catch {
    const answer = await vscode.window.showInformationMessage(
      'Для LuNA-проекта рядом с .fa обычно есть ucodes.cpp. Создать шаблон ucodes.cpp?',
      'Да',
      'Нет'
    );
    if (answer === 'Да') {
      const template = [
        '#include <cstdio>',
        '',
        'extern "C" void my_kernel() {',
        '    std::printf("Hello from ucodes.cpp\\n");',
        '}',
        ''
      ].join('\n');
      await vscode.workspace.fs.writeFile(ucodesUri, Buffer.from(template, 'utf8'));
      const doc = await vscode.workspace.openTextDocument(ucodesUri);
      await vscode.window.showTextDocument(doc);
    }
  }
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) return undefined;
  return client.stop();
}
