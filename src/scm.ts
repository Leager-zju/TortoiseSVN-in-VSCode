import * as path from 'node:path';
import * as vscode from 'vscode';
import { getSvnStatus, SvnStatusEntry } from './svn';

export function createVirtualDocumentUri(scheme: string, file: vscode.Uri): vscode.Uri {
  const query = `path=${encodeURIComponent(file.fsPath)}&version=${Date.now()}`;
  return file.with({ scheme, query });
}

export class SvnRepository implements vscode.Disposable, vscode.FileDecorationProvider {
  readonly sourceControl: vscode.SourceControl;
  readonly changes: vscode.SourceControlResourceGroup;
  private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationEmitter.event;
  private readonly decorationRegistration: vscode.Disposable;
  private statuses = new Map<string, SvnStatusEntry>();
  private refreshing = false;

  constructor(
    readonly rootUri: vscode.Uri,
    readonly targets: string[]
  ) {
    this.sourceControl = vscode.scm.createSourceControl('svn', `SVN: ${path.basename(rootUri.fsPath)}`, rootUri);
    this.changes = this.sourceControl.createResourceGroup('changes', '更改');
    this.sourceControl.inputBox.placeholder = '提交消息（可选，将预填到 TortoiseSVN）';
    this.sourceControl.acceptInputCommand = {
      command: 'svn.commitScm',
      title: 'SVN 提交',
      arguments: [rootUri]
    };
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: uri => createVirtualDocumentUri('svn-base', uri)
    };
    this.decorationRegistration = vscode.window.registerFileDecorationProvider(this);
  }

  get statusEntries(): readonly SvnStatusEntry[] {
    return [...this.statuses.values()];
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const entries = await getSvnStatus(this.rootUri.fsPath, this.targets);
      const nextStatuses = new Map<string, SvnStatusEntry>();
      for (const entry of entries) {
        nextStatuses.set(pathKey(entry.path), entry);
      }
      const states = [...nextStatuses.values()]
        .filter(isVersionedChange)
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(entry => this.toResourceState(entry));
      const changedDecorations = changedStatusUris(this.statuses, nextStatuses);

      this.statuses = nextStatuses;
      this.changes.resourceStates = states;
      this.sourceControl.count = states.length;
      if (changedDecorations.length > 0) {
        this.decorationEmitter.fire(changedDecorations);
      }
    } finally {
      this.refreshing = false;
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const entry = this.statuses.get(pathKey(uri.fsPath));
    if (!entry) {
      return undefined;
    }
    const presentation = statusPresentation(entry.item, entry.props);
    return {
      badge: presentation.badge,
      tooltip: `SVN：${presentation.tooltip}`,
      color: new vscode.ThemeColor(presentation.color),
      propagate: false
    };
  }

  dispose(): void {
    this.decorationRegistration.dispose();
    this.decorationEmitter.dispose();
    this.sourceControl.dispose();
  }

  private toResourceState(entry: SvnStatusEntry): vscode.SourceControlResourceState {
    const uri = vscode.Uri.file(entry.path);
    const presentation = statusPresentation(entry.item, entry.props);
    return {
      resourceUri: uri,
      command: {
        command: 'svn.diff',
        title: '打开 SVN Diff',
        arguments: [uri]
      },
      contextValue: 'svn.changed',
      decorations: {
        iconPath: new vscode.ThemeIcon(presentation.icon, new vscode.ThemeColor(presentation.color)),
        tooltip: presentation.tooltip,
        strikeThrough: entry.item === 'deleted' || entry.item === 'missing'
      }
    };
  }
}

export function isVersionedChange(entry: SvnStatusEntry): boolean {
  if (entry.item === 'unversioned' || entry.item === 'ignored' || entry.item === 'external') {
    return false;
  }
  return !['none', 'normal'].includes(entry.item) || !['none', 'normal'].includes(entry.props);
}

function changedStatusUris(
  previous: Map<string, SvnStatusEntry>,
  current: Map<string, SvnStatusEntry>
): vscode.Uri[] {
  const changed: vscode.Uri[] = [];
  const keys = new Set([...previous.keys(), ...current.keys()]);
  for (const key of keys) {
    const before = previous.get(key);
    const after = current.get(key);
    if (before?.item !== after?.item || before?.props !== after?.props) {
      changed.push(vscode.Uri.file((after ?? before)!.path));
    }
  }
  return changed;
}

function pathKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

type StatusPresentation = {
  badge: string;
  icon: string;
  tooltip: string;
  color: string;
};

function statusPresentation(item: string, props: string): StatusPresentation {
  if (props === 'conflicted') {
    return {
      badge: 'C',
      icon: 'warning',
      tooltip: '属性存在冲突',
      color: 'gitDecoration.conflictingResourceForeground'
    };
  }

  const propertySuffix = props === 'modified' ? '（属性已更改）' : '';
  switch (item) {
    case 'unversioned':
      return { badge: '?', icon: 'question', tooltip: '未加入版本管理', color: 'gitDecoration.untrackedResourceForeground' };
    case 'added':
      return { badge: 'A', icon: 'diff-added', tooltip: `已添加${propertySuffix}`, color: 'gitDecoration.addedResourceForeground' };
    case 'deleted':
      return { badge: 'D', icon: 'diff-removed', tooltip: `已删除${propertySuffix}`, color: 'gitDecoration.deletedResourceForeground' };
    case 'missing':
      return { badge: '!', icon: 'warning', tooltip: `文件缺失${propertySuffix}`, color: 'gitDecoration.deletedResourceForeground' };
    case 'replaced':
      return { badge: 'R', icon: 'replace', tooltip: `已替换${propertySuffix}`, color: 'gitDecoration.modifiedResourceForeground' };
    case 'conflicted':
    case 'obstructed':
      return { badge: 'C', icon: 'warning', tooltip: `存在冲突${propertySuffix}`, color: 'gitDecoration.conflictingResourceForeground' };
    case 'modified':
      return { badge: 'M', icon: 'diff-modified', tooltip: `已修改${propertySuffix}`, color: 'gitDecoration.modifiedResourceForeground' };
    case 'normal':
      if (props === 'modified') {
        return { badge: 'M', icon: 'diff-modified', tooltip: '属性已修改', color: 'gitDecoration.modifiedResourceForeground' };
      }
      break;
  }
  return {
    badge: 'M',
    icon: 'diff-modified',
    tooltip: `SVN 状态：${item}${propertySuffix}`,
    color: 'gitDecoration.modifiedResourceForeground'
  };
}
