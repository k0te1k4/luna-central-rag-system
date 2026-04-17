import * as vscode from 'vscode';
import { KnowledgeBaseService } from './service';
import { KnowledgeBaseStorage, KbCategory } from './storage';
import { KnowledgeBaseTreeProvider, KbTreeNode } from './tree';
import { LunaProjectsTreeProvider } from './projectsView';

export function registerKbCommands(params: {
  context: vscode.ExtensionContext;
  kb: KnowledgeBaseService;
  storage: KnowledgeBaseStorage;
  tree: KnowledgeBaseTreeProvider;
  projects: LunaProjectsTreeProvider;
  statusBar: vscode.StatusBarItem;
}): void {
  const { context, kb, storage, tree, projects, statusBar } = params;

  /**
   * Commands can be invoked from TreeView context menus.
   * In that case VS Code passes the clicked tree node object as the first argument.
   */
  function resolveVersionArg(arg: unknown): string | undefined {
    if (!arg) return undefined;
    if (typeof arg === 'string') return arg;
    // Tree nodes
    const anyArg = arg as any;
    if (typeof anyArg.version === 'string') return anyArg.version;
    if (typeof anyArg.name === 'string') return anyArg.name;
    return undefined;
  }

  async function updateStatus() {
    const folder = kb.getActiveFolder();
    const v = kb.getVersionForFolder(folder);
    statusBar.text = `LuNA KB: ${v}`;
    statusBar.tooltip = 'LuNA Knowledge Base version (click to change)';
  }

  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand('luna.kb.refresh', async () => {
      tree.refresh();
      projects.refresh();
      await updateStatus();
    }),

    vscode.commands.registerCommand('luna.kb.setStorageCredentials', async () => {
      await kb.promptSetStorageCredentials();
      tree.refresh();
    }),

    vscode.commands.registerCommand('luna.kb.clearStorageCredentials', async () => {
      await kb.clearStorageCredentials();
      tree.refresh();
    }),

    vscode.commands.registerCommand('luna.kb.createVersion', async () => {
      await kb.createVersion();
      tree.refresh();
    }),

    vscode.commands.registerCommand('luna.kb.selectVersion', async (version?: string) => {
      await kb.selectVersion(version);
      projects.refresh();
      await updateStatus();
    }),

    vscode.commands.registerCommand('luna.kb.selectVersionForFolder', async (folderUri: vscode.Uri) => {
      await kb.selectVersion(undefined, folderUri);
      projects.refresh();
      await updateStatus();
    }),

    vscode.commands.registerCommand('luna.kb.syncDocs', async () => {
      const folder = kb.getActiveFolder();
      const version = kb.getVersionForFolder(folder);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `LuNA KB: syncing ${version}`, cancellable: true },
        async (progress, token) => {
          await kb.syncDocs(version, progress, token);
        }
      );
      tree.refresh();
    }),

    vscode.commands.registerCommand('luna.kb.uploadDocs', async (version?: string) => {
      const folder = kb.getActiveFolder();
      const v = version || kb.getVersionForFolder(folder);

      // Wiki is treated as immutable for regular users.
      const cfg = vscode.workspace.getConfiguration('luna');
      const wikiReadOnly = cfg.get<boolean>('kb.wikiReadOnly', true);
      if (wikiReadOnly) {
        vscode.window.showWarningMessage(
          'LuNA wiki docs are read-only in this extension build. Use “LuNA: Add User Files to Assistant” to add your own documents.'
        );
        return;
      }

      const uris = await vscode.window.showOpenDialog({ title: 'Upload docs files', canSelectMany: true, canSelectFiles: true });
      if (!uris?.length) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `LuNA KB: uploading to ${v}/docs`, cancellable: true },
        async (progress) => {
          progress.report({ message: `Uploading ${uris.length} file(s)...` });
          await kb.uploadFiles(v, 'docs', uris);
        }
      );
      tree.refresh();
    }),

    vscode.commands.registerCommand('luna.kb.uploadRaw', async (version?: string) => {
      const folder = kb.getActiveFolder();
      const v = version || kb.getVersionForFolder(folder);
      const uris = await vscode.window.showOpenDialog({ title: 'Upload raw files (PDF/audio/etc)', canSelectMany: true, canSelectFiles: true });
      if (!uris?.length) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `LuNA KB: uploading to ${v}/raw`, cancellable: true },
        async (progress) => {
          progress.report({ message: `Uploading ${uris.length} file(s)...` });
          await kb.uploadFiles(v, 'raw', uris);
        }
      );
      tree.refresh();
    }),

    vscode.commands.registerCommand('luna.kb.uploadFolder', async (version?: string) => {
      const folder = kb.getActiveFolder();
      const v = version || kb.getVersionForFolder(folder);

      const cfg = vscode.workspace.getConfiguration('luna');
      const wikiReadOnly = cfg.get<boolean>('kb.wikiReadOnly', true);
      if (wikiReadOnly) {
        vscode.window.showWarningMessage(
          'LuNA wiki docs are read-only in this extension build. Use “LuNA: Add User Files to Assistant” to add your own documents.'
        );
        return;
      }

      const picked = await vscode.window.showOpenDialog({
        title: 'Select folder to upload (docs)',
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false
      });
      if (!picked?.length) return;
      const base = picked[0];
      const files = await collectFilesRecursive(base);
      if (!files.length) {
        vscode.window.showWarningMessage('Folder is empty.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `LuNA KB: uploading folder to ${v}/docs`, cancellable: true },
        async (progress) => {
          progress.report({ message: `Uploading ${files.length} file(s)...` });
          await kb.uploadFiles(v, 'docs', files, base);
        }
      );
      tree.refresh();
    }),

    // User-managed files for assistant RAG (stored in cloud under .../<version>/user-files/)
    vscode.commands.registerCommand('luna.kb.uploadUserFiles', async (versionArg?: unknown) => {
      const folder = kb.getActiveFolder();
      const v = resolveVersionArg(versionArg) || kb.getVersionForFolder(folder);
      const uris = await vscode.window.showOpenDialog({
        title: 'Add user files for assistant (indexed)',
        canSelectMany: true,
        canSelectFiles: true,
        filters: { Documents: ['md', 'markdown', 'txt', 'pdf'], All: ['*'] }
      });
      if (!uris?.length) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `LuNA KB: uploading to ${v}/user-files`, cancellable: true },
        async (progress) => {
          progress.report({ message: `Uploading ${uris.length} file(s)...` });
          await kb.uploadFiles(v, 'user-files', uris);
        }
      );
      tree.refresh();

      // Full reindex for reliability.
      void vscode.commands.executeCommand('luna.assistant.reindexWiki');
    }),

    vscode.commands.registerCommand('luna.kb.listUserFiles', async (versionArg?: unknown) => {
      const folder = kb.getActiveFolder();
      const v = resolveVersionArg(versionArg) || kb.getVersionForFolder(folder);
      const objects = await storage.listObjects(v, 'user-files');
      if (!objects.length) {
        vscode.window.showInformationMessage(`No user files for version ${v}.`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        objects.map(o => ({
          label: storage.relativeName(v, 'user-files', o.key),
          description: `${Math.round((o.size || 0) / 1024)} KB`,
          detail: o.key,
          obj: o
        })),
        { title: `User files (${v})`, canPickMany: true }
      );
      if (!picked || (Array.isArray(picked) && picked.length === 0)) return;
      const arr = Array.isArray(picked) ? (picked as any[]) : [picked as any];

      const action = await vscode.window.showQuickPick(['Open', 'Delete'], { title: `Action for ${arr.length} file(s)` });
      if (!action) return;
      if (action === 'Open') {
        await kb.openObject({ version: v, category: 'user-files', key: arr[0].obj.key });
        return;
      }
      const ok = await vscode.window.showWarningMessage(`Delete ${arr.length} user file(s) from cloud?`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;
      for (const it of arr) {
        await kb.deleteObject(it.obj.key);
      }
      tree.refresh();
      void vscode.commands.executeCommand('luna.assistant.reindexWiki');
    }),

    vscode.commands.registerCommand('luna.kb.importThesisPdf', async (version?: string) => {
      const folder = kb.getActiveFolder();
      const v = version || kb.getVersionForFolder(folder);
      const picked = await vscode.window.showOpenDialog({
        title: 'Select thesis PDF to import',
        canSelectMany: false,
        canSelectFiles: true,
        filters: { PDF: ['pdf'] }
      });
      if (!picked?.length) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `LuNA KB: importing thesis into ${v}`, cancellable: true },
        async (progress) => {
          progress.report({ message: 'Uploading PDF + extracting text...' });
          await kb.importThesisPdf(v, picked[0]);
        }
      );
      tree.refresh();
    }),

    vscode.commands.registerCommand('luna.kb.deleteObject', async (node: KbTreeNode) => {
      if (!node || node.kind !== 'object') return;

      if (node.category === 'docs') {
        vscode.window.showWarningMessage('LuNA wiki docs are read-only and cannot be deleted from this extension.');
        return;
      }

      const ok = await vscode.window.showWarningMessage(`Delete from cloud?\n${node.object.key}`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;
      await kb.deleteObject(node.object.key);
      tree.refresh();

      if (node.category === 'user-files') {
        // Full reindex so removed content is not used.
        void vscode.commands.executeCommand('luna.assistant.reindexWiki');
      }
    }),

    vscode.commands.registerCommand('luna.kb.openObject', async (node: KbTreeNode) => {
      if (!node || node.kind !== 'object') return;
      await kb.openObject({ version: node.version, category: node.category, key: node.object.key });
    }),

    vscode.commands.registerCommand('luna.kb.statusBar.selectVersion', async () => {
      await kb.selectVersion();
      projects.refresh();
      await updateStatus();
    })
  );

  context.subscriptions.push(...disposables);

  // update status on events
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatus()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('luna.kb')) {
        tree.refresh();
        projects.refresh();
        updateStatus();
      }
    })
  );

  // initial
  updateStatus();
}

async function collectFilesRecursive(root: vscode.Uri): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  async function walk(dir: vscode.Uri) {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      const uri = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) {
        if (name === '.git' || name === 'node_modules') continue;
        await walk(uri);
      } else if (type === vscode.FileType.File) {
        out.push(uri);
      }
    }
  }
  await walk(root);
  out.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  return out;
}
