import * as vscode from 'vscode';
import { getKbConfig } from './config';

export type ProjectNode = { kind: 'folder'; folder: vscode.WorkspaceFolder } | { kind: 'status'; text: string };

export class LunaProjectsTreeProvider implements vscode.TreeDataProvider<ProjectNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ProjectNode | void>();
  readonly onDidChangeTreeData: vscode.Event<ProjectNode | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ProjectNode): vscode.TreeItem {
    if (element.kind === 'status') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'lunaProjectStatus';
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    const folder = element.folder;
    const version = getProjectVersion(folder) || getKbConfig().defaultVersion;
    const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'lunaProjectFolder';
    item.description = `LuNA docs: ${version}`;
    item.iconPath = new vscode.ThemeIcon('folder');
    item.command = {
      command: 'luna.kb.selectVersionForFolder',
      title: 'Select LuNA version',
      arguments: [folder.uri]
    };
    return item;
  }

  getChildren(): ProjectNode[] {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) return [{ kind: 'status', text: 'Open a folder/workspace' }];
    return folders.map(f => ({ kind: 'folder', folder: f }));
  }
}

export function getProjectVersion(folder: vscode.WorkspaceFolder): string | undefined {
  const cfg = vscode.workspace.getConfiguration('luna', folder.uri);
  const v = cfg.get<string>('kb.projectVersion', '');
  const s = (v || '').trim();
  return s || undefined;
}

export async function setProjectVersion(folderUri: vscode.Uri, version: string): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(folderUri);
  if (!folder) throw new Error('Workspace folder not found');
  const cfg = vscode.workspace.getConfiguration('luna', folder.uri);
  await cfg.update('kb.projectVersion', version, vscode.ConfigurationTarget.WorkspaceFolder);
}
