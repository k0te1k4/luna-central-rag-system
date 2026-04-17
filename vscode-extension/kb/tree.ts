import * as vscode from 'vscode';
import { KnowledgeBaseStorage, KbCategory, KbObject } from './storage';
import { getKbConfig } from './config';

export type KbTreeNodeKind = 'root' | 'version' | 'category' | 'object' | 'status';

export type KbTreeNode =
  | { kind: 'root' }
  | { kind: 'status'; text: string }
  | { kind: 'version'; version: string }
  | { kind: 'category'; version: string; category: KbCategory }
  | { kind: 'object'; version: string; category: KbCategory; object: KbObject };

export class KnowledgeBaseTreeProvider implements vscode.TreeDataProvider<KbTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<KbTreeNode | void>();
  readonly onDidChangeTreeData: vscode.Event<KbTreeNode | void> = this._onDidChangeTreeData.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly storage: KnowledgeBaseStorage) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: KbTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'root': {
        const item = new vscode.TreeItem('LuNA Knowledge Base', vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'lunaKbRoot';
        return item;
      }
      case 'status': {
        const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'lunaKbStatus';
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
      case 'version': {
        const item = new vscode.TreeItem(element.version, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'lunaKbVersion';
        item.iconPath = new vscode.ThemeIcon('library');
        item.command = {
          command: 'luna.kb.selectVersion',
          title: 'Select version',
          arguments: [element.version]
        };
        return item;
      }
      case 'category': {
        const label =
          element.category === 'docs'
            ? 'Docs (wiki, indexed)'
            : element.category === 'user-files'
              ? 'User files (indexed)'
              : 'Raw';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'lunaKbCategory';
        item.iconPath = new vscode.ThemeIcon(
          element.category === 'docs' ? 'book' : element.category === 'user-files' ? 'files' : 'file-binary'
        );
        return item;
      }
      case 'object': {
        const rel = this.storage.relativeName(element.version, element.category, element.object.key);
        const item = new vscode.TreeItem(rel, vscode.TreeItemCollapsibleState.None);
        item.contextValue =
          element.category === 'docs'
            ? 'lunaKbObjectDocs'
            : element.category === 'user-files'
              ? 'lunaKbObjectUser'
              : 'lunaKbObject';
        item.iconPath = new vscode.ThemeIcon('file');
        item.description = `${Math.round((element.object.size || 0) / 1024)} KB`;
        item.tooltip = `${element.object.key}\n${element.object.lastModified?.toISOString() || ''}`;
        item.command = {
          command: 'luna.kb.openObject',
          title: 'Open',
          arguments: [element]
        };
        return item;
      }
    }
  }

  async getChildren(element?: KbTreeNode): Promise<KbTreeNode[]> {
    if (!element) {
      return [{ kind: 'root' }];
    }
    if (element.kind === 'root') {
      const cfg = getKbConfig();
      if (!cfg.enabled) return [{ kind: 'status', text: 'KB is disabled (luna.kb.enabled=false)' }];
      if (!cfg.bucket) return [{ kind: 'status', text: 'Set luna.kb.storage.bucket' }];
      if (!(await this.storage.isReady())) return [{ kind: 'status', text: 'Run: LuNA KB: Set Storage Credentials' }];
      const versions = await this.storage.listVersions();
      if (!versions.length) return [{ kind: 'status', text: 'No versions found (create one)' }];
      return versions.map(v => ({ kind: 'version', version: v.name }));
    }
    if (element.kind === 'version') {
      return [
        { kind: 'category', version: element.version, category: 'docs' },
        { kind: 'category', version: element.version, category: 'user-files' },
        { kind: 'category', version: element.version, category: 'raw' }
      ];
    }
    if (element.kind === 'category') {
      const objects = await this.storage.listObjects(element.version, element.category);
      if (!objects.length) return [{ kind: 'status', text: 'Empty' }];
      return objects.map(o => ({ kind: 'object', version: element.version, category: element.category, object: o }));
    }
    return [];
  }
}
