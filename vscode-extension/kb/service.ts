import * as vscode from 'vscode';
import * as path from 'path';
import { KnowledgeBaseStorage, KbCategory, categoryPrefix } from './storage';
import { getKbConfig } from './config';
import { getS3Credentials, setS3Credentials, clearS3Credentials } from './secrets';
import { syncDocsFromCloud } from './sync';
import { getProjectVersion, setProjectVersion } from './projectsView';
import { extractPdfText } from './pdf';

export type OpenTarget = { version: string; category: KbCategory; key: string };

export class KnowledgeBaseService {
  private readonly cfg = getKbConfig();

  constructor(private readonly context: vscode.ExtensionContext, private readonly storage: KnowledgeBaseStorage) {}

  getActiveFolder(): vscode.WorkspaceFolder | undefined {
    const docUri = vscode.window.activeTextEditor?.document.uri;
    if (docUri) {
      const folder = vscode.workspace.getWorkspaceFolder(docUri);
      if (folder) return folder;
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  getVersionForFolder(folder?: vscode.WorkspaceFolder): string {
    const f = folder || this.getActiveFolder();
    if (f) {
      return getProjectVersion(f) || this.cfg.defaultVersion;
    }
    return this.cfg.defaultVersion;
  }

  async listVersions(): Promise<string[]> {
    const vers = await this.storage.listVersions();
    return vers.map(v => v.name);
  }

  async selectVersion(version?: string, folderUri?: vscode.Uri): Promise<string> {
    const folder = folderUri ? vscode.workspace.getWorkspaceFolder(folderUri) : this.getActiveFolder();
    if (!folder) throw new Error('No workspace folder');
    const versions = await this.listVersions();
    const picked = version
      ? version
      : await vscode.window.showQuickPick(versions.length ? versions : [this.cfg.defaultVersion], {
          title: 'Select LuNA documentation version',
          canPickMany: false
        });
    if (!picked) return this.getVersionForFolder(folder);
    await setProjectVersion(folder.uri, picked);
    return picked;
  }

  /** Ensure docs for version are cached locally under globalStorage. */
  async syncDocs(version: string, progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken) {
    const objects = await this.storage.listObjects(version, 'docs');
    return await syncDocsFromCloud({
      context: this.context,
      storage: this.storage,
      version,
      objects,
      progress,
      cancellationToken: token
    });
  }

  /** Ensure user-managed files for version are cached locally under globalStorage. */
  async syncUserFiles(
    version: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken
  ) {
    const objects = await this.storage.listObjects(version, 'user-files');
    return await syncDocsFromCloud({
      context: this.context,
      storage: this.storage,
      version,
      objects,
      progress,
      cancellationToken: token,
      category: 'user-files'
    });
  }

  docsCacheRoot(version: string): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'kb', version, 'docs').fsPath;
  }

  userFilesCacheRoot(version: string): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'kb', version, 'user-files').fsPath;
  }

  /** Download an object to a temp location and open in editor. */
  async openObject(target: OpenTarget): Promise<void> {
    const tmpDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'tmp');
    await vscode.workspace.fs.createDirectory(tmpDir);
    const filename = path.posix.basename(target.key);
    const tmp = vscode.Uri.joinPath(tmpDir, `${Date.now()}_${filename}`);
    await this.storage.downloadToFile(target.key, tmp);
    // Let VS Code choose appropriate opener (PDF viewer, text, etc.)
    await vscode.commands.executeCommand('vscode.open', tmp, { preview: true });
  }

  async promptSetStorageCredentials(): Promise<void> {
    const accessKeyId = await vscode.window.showInputBox({
      title: 'Yandex Object Storage Access Key ID',
      prompt: 'Enter Access Key ID',
      ignoreFocusOut: true
    });
    if (!accessKeyId) return;
    const secretAccessKey = await vscode.window.showInputBox({
      title: 'Yandex Object Storage Secret Access Key',
      prompt: 'Enter Secret Access Key',
      password: true,
      ignoreFocusOut: true
    });
    if (!secretAccessKey) return;
    await setS3Credentials(this.context, { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() });
    vscode.window.showInformationMessage('LuNA KB: storage credentials saved.');
  }

  async clearStorageCredentials(): Promise<void> {
    await clearS3Credentials(this.context);
    vscode.window.showInformationMessage('LuNA KB: storage credentials cleared.');
  }

  async uploadFiles(version: string, category: KbCategory, files: vscode.Uri[], baseFolder?: vscode.Uri): Promise<void> {
    for (const file of files) {
      const rel = baseFolder ? path.posix.relative(baseFolder.fsPath.replace(/\\/g, '/'), file.fsPath.replace(/\\/g, '/')) : path.posix.basename(file.fsPath);
      const safeRel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
      const key = `${categoryPrefix(version, category)}/${safeRel}`.replace(/\\/g, '/').replace(/\/+/g, '/');
      const contentType = guessContentType(file);
      await this.storage.uploadFromFile(file, key, contentType);
    }
  }

  async createVersion(versionName?: string): Promise<string | undefined> {
    const name = versionName
      ? versionName
      : await vscode.window.showInputBox({ title: 'Create KB version', prompt: 'Version name (e.g. luna6, luna7)', ignoreFocusOut: true });
    if (!name) return undefined;
    await this.storage.ensureVersionExists(name.trim());
    return name.trim();
  }

  /**
   * Upload thesis PDF into raw/ and an extracted markdown into docs/ (best-effort).
   */
  async importThesisPdf(version: string, pdfUri: vscode.Uri): Promise<void> {
    const basename = path.posix.basename(pdfUri.fsPath).replace(/\s+/g, '_');
    const rawKey = `${categoryPrefix(version, 'raw')}/thesis/${basename}`.replace(/\\/g, '/').replace(/\/+/g, '/');
    await this.storage.uploadFromFile(pdfUri, rawKey, 'application/pdf');

    try {
      const text = await extractPdfText(pdfUri);
      const md = `# Thesis: ${basename}\n\n` + text + `\n`;
      const mdKey = `${categoryPrefix(version, 'docs')}/thesis/${basename}.md`.replace(/\\/g, '/').replace(/\/+/g, '/');
      await this.storage.uploadBytes(Buffer.from(md, 'utf8'), mdKey, 'text/markdown; charset=utf-8');
    } catch (e: any) {
      // Keep raw PDF anyway.
      vscode.window.showWarningMessage(`PDF uploaded, but text extraction failed: ${e?.message ?? String(e)}`);
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.storage.deleteObject(key);
  }
}

function guessContentType(uri: vscode.Uri): string | undefined {
  const p = uri.fsPath.toLowerCase();
  if (p.endsWith('.md') || p.endsWith('.markdown')) return 'text/markdown; charset=utf-8';
  if (p.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (p.endsWith('.pdf')) return 'application/pdf';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.yaml') || p.endsWith('.yml')) return 'text/yaml; charset=utf-8';
  return undefined;
}
