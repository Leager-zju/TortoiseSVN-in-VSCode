import * as path from 'node:path';
import * as vscode from 'vscode';
import { isConflicted } from './scm';
import { SvnStatusEntry } from './svn';

const CONFLICT_VIEW_ID = 'svn.conflictView';

export class SvnConflictView implements vscode.Disposable, vscode.TreeDataProvider<ConflictTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ConflictTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<ConflictTreeItem> | undefined;
  private items: ConflictTreeItem[] = [];

  constructor() {
    this.view = this.createView();
  }

  private createView(): vscode.TreeView<ConflictTreeItem> | undefined {
    try {
      return vscode.window.createTreeView(CONFLICT_VIEW_ID, {
        treeDataProvider: this,
        showCollapseAll: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SVN Compass] 无法创建“冲突文件列表”视图：${message}`);
      void vscode.window.showWarningMessage(
        `“冲突文件列表”视图注册失败（${message}）。请卸载扩展后重新安装，并执行“开发人员: 重新加载窗口”。`);
      return undefined;
    }
  }

  getTreeItem(element: ConflictTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ConflictTreeItem[] {
    return this.items;
  }

  setEntries(entries: readonly SvnStatusEntry[]): void {
    this.items = entries
      .filter(entry => isConflicted(entry))
      .map(entry => new ConflictTreeItem(vscode.Uri.file(entry.path), entry))
      .sort((left, right) => left.resourceUri.fsPath.localeCompare(right.resourceUri.fsPath));
    if (this.view) {
      this.view.badge = this.items.length > 0
        ? { value: this.items.length, tooltip: `${this.items.length} 个冲突文件` }
        : undefined;
    }
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.view?.dispose();
    this.emitter.dispose();
  }
}

class ConflictTreeItem extends vscode.TreeItem {
  readonly contextValue = 'svn.conflict';
  readonly iconPath =
      new vscode.ThemeIcon('warning', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'));
  readonly command: vscode.Command;

  constructor(
    readonly resourceUri: vscode.Uri,
    entry: SvnStatusEntry
  ) {
    super(path.basename(resourceUri.fsPath), vscode.TreeItemCollapsibleState.None);
    const relative = vscode.workspace.asRelativePath(resourceUri.fsPath, false);
    const slash = relative.lastIndexOf('/');
    this.description = slash > 0 ? relative.slice(0, slash) : undefined;
    this.tooltip = entry.props === 'conflicted'
      ? `${resourceUri.fsPath}\n属性冲突`
      : `${resourceUri.fsPath}\n内容冲突`;
    this.command = {
      command: 'svn.openConflict',
      title: '处理冲突',
      arguments: [this]
    };
  }
}
