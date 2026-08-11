import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SvnLogViewer } from './logView';
import { createVirtualDocumentUri, isVersionedChange, SvnRepository } from './scm';
import { SelectionHistoryLine, SvnSelectionHistoryViewer } from './selectionHistoryView';
import {
  findWorkingCopyRoot,
  getBaseContent,
  getRevisionContent,
  getSvnBlame,
  launchTortoise,
  revertSvnTargets,
  SvnStatusEntry
} from './svn';

class SvnDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly kind: 'base' | 'working' | 'revision') {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parameters = new URLSearchParams(uri.query);
    const filePath = parameters.get('path');
    if (!filePath) {
      return '';
    }

    if (this.kind === 'working') {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch {
        return '';
      }
    }

    if (this.kind === 'revision') {
      if (parameters.get('empty') === 'true') {
        return '';
      }
      const revision = Number(parameters.get('revision'));
      const pegValue = parameters.get('pegRevision');
      const pegRevision = pegValue === null ? undefined : Number(pegValue);
      if (!Number.isInteger(revision) || revision <= 0 ||
          pegRevision !== undefined && (!Number.isInteger(pegRevision) || pegRevision <= 0)) {
        throw new Error('无效的 SVN 修订号。');
      }
      return getRevisionContent(filePath, revision, pegRevision);
    }

    try {
      return await getBaseContent(filePath);
    } catch {
      return '';
    }
  }
}

class RepositoryManager implements vscode.Disposable {
  private readonly repositories = new Map<string, SvnRepository>();
  private readonly output = vscode.window.createOutputChannel('SVN');
  private readonly logViewer = new SvnLogViewer();
  private readonly selectionHistoryViewer = new SvnSelectionHistoryViewer();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshDebounce: NodeJS.Timeout | undefined;
  private discovering: Promise<void> | undefined;
  private readonly selectionHistoryRequests = new Map<string, number>();

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(this.output);
  }

  async initialize(): Promise<void> {
    this.registerCommands();
    this.registerEvents();
    this.restartAutoRefresh();
    await this.discoverRepositories();
  }

  async discoverRepositories(): Promise<void> {
    if (this.discovering) {
      return this.discovering;
    }
    this.discovering = this.doDiscoverRepositories();
    try {
      await this.discovering;
    } finally {
      this.discovering = undefined;
    }
  }

  async refreshAll(showErrors = false): Promise<void> {
    const results = await Promise.allSettled([...this.repositories.values()].map(repository => repository.refresh()));
    for (const result of results) {
      if (result.status === 'rejected') {
        const message = errorMessage(result.reason);
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
        if (showErrors) {
          void vscode.window.showErrorMessage(`SVN 状态刷新失败：${message}`);
        }
      }
    }
    await this.updateResourceContexts();
  }

  scheduleRefresh(): void {
    if (this.refreshDebounce) {
      clearTimeout(this.refreshDebounce);
    }
    this.refreshDebounce = setTimeout(() => void this.refreshAll(), 500);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    if (this.refreshDebounce) {
      clearTimeout(this.refreshDebounce);
    }
    for (const repository of this.repositories.values()) {
      repository.dispose();
    }
    this.repositories.clear();
    this.logViewer.dispose();
    this.selectionHistoryViewer.dispose();
    void vscode.commands.executeCommand('setContext', 'svn.changedResourcePaths', []);
    void vscode.commands.executeCommand('setContext', 'svn.unversionedResourcePaths', []);
  }

  private async doDiscoverRepositories(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const scopesByRoot = new Map<string, { root: string; scopes: Set<string> }>();

    await Promise.all(
      folders.map(async folder => {
        const [containingRoot, adminFiles] = await Promise.all([
          findWorkingCopyRoot(folder.uri.fsPath),
          vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/.svn/wc.db'), null, 200)
        ]);

        if (containingRoot) {
          addScope(scopesByRoot, containingRoot, folder.uri.fsPath);
        }
        for (const adminFile of adminFiles) {
          const nestedRoot = path.dirname(path.dirname(adminFile.fsPath));
          addScope(scopesByRoot, nestedRoot, nestedRoot);
        }
      })
    );

    for (const [key, repository] of this.repositories) {
      if (!scopesByRoot.has(key)) {
        repository.dispose();
        this.repositories.delete(key);
      }
    }

    for (const [key, discovered] of scopesByRoot) {
      const targets = compactScopes(discovered.root, [...discovered.scopes]);
      const existing = this.repositories.get(key);
      if (existing && samePaths(existing.targets, targets)) {
        continue;
      }
      existing?.dispose();
      this.repositories.set(key, new SvnRepository(vscode.Uri.file(discovered.root), targets));
    }

    await this.refreshAll();
  }

  private async updateResourceContexts(): Promise<void> {
    const changedPaths = new Set<string>();
    const unversionedPaths = new Set<string>();
    for (const repository of this.repositories.values()) {
      for (const entry of repository.statusEntries) {
        const values = [vscode.Uri.file(entry.path).path, vscode.Uri.file(entry.path).fsPath];
        const target = entry.item === 'unversioned'
          ? unversionedPaths
          : isVersionedChange(entry)
            ? changedPaths
            : undefined;
        if (target) {
          values.forEach(value => target.add(value));
        }
      }
    }
    await Promise.all([
      vscode.commands.executeCommand('setContext', 'svn.changedResourcePaths', [...changedPaths]),
      vscode.commands.executeCommand('setContext', 'svn.unversionedResourcePaths', [...unversionedPaths])
    ]);
  }

  private statusFor(uri: vscode.Uri): SvnStatusEntry | undefined {
    const key = pathKey(uri.fsPath);
    for (const repository of this.repositories.values()) {
      const status = repository.statusEntries.find(entry => pathKey(entry.path) === key);
      if (status) {
        return status;
      }
    }
    return undefined;
  }

  private registerCommands(): void {
    const register = (command: string, callback: (...args: unknown[]) => unknown) => {
      this.context.subscriptions.push(vscode.commands.registerCommand(command, callback));
    };

    register('svn.refresh', () => this.refreshAll(true));
    register('svn.diff', async (first, selected) => {
      const uri = commandUris(first, selected)[0] ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file') {
        void vscode.window.showWarningMessage('请选择一个本地文件进行 SVN Diff。');
        return;
      }
      const status = this.statusFor(uri);
      if (!status || !isVersionedChange(status)) {
        void vscode.window.showInformationMessage('该文件没有可比较的 SVN 本地改动。');
        return;
      }
      const base = createVirtualDocumentUri('svn-base', uri);
      const working = createVirtualDocumentUri('svn-working', uri);
      await vscode.commands.executeCommand(
        'vscode.diff',
        base,
        working,
        `${path.basename(uri.fsPath)}（BASE ↔ 工作副本）`
      );
    });

    register('svn.update', (first, selected) => this.runNative('update', commandUris(first, selected)));
    register('svn.commit', (first, selected) => this.runNative('commit', commandUris(first, selected)));
    register('svn.log', (first, selected) => {
      const uri = commandUris(first, selected)[0] ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file') {
        void vscode.window.showWarningMessage('请选择一个本地 SVN 文件或目录查看日志。');
        return;
      }
      this.logViewer.show(uri);
    });
    register('svn.selectionHistory', first => this.showSelectionHistory(first));
    register('svn.revert', (first, selected) => this.confirmAndRevert(commandUris(first, selected)));
    register('svn.add', (first, selected) => this.runNative(
      'add',
      commandUris(first, selected),
      status => status?.item === 'unversioned',
      '所选资源已经加入 SVN 版本管理或不在工作副本中。'
    ));
    register('svn.commitScm', (rootArg: unknown) => {
      const rootUri = toUri(rootArg);
      if (!rootUri) {
        return;
      }
      const repository = this.repositories.get(pathKey(rootUri.fsPath));
      if (!repository) {
        return;
      }
      const message = repository.sourceControl.inputBox.value.trim();
      const extraArgs = message ? [`/logmsg:${message}`] : [];
      this.runNativePaths('commit', repository.targets, extraArgs);
      repository.sourceControl.inputBox.value = '';
    });
  }

  private async showSelectionHistory(contextValue: unknown): Promise<void> {
    let editor = vscode.window.activeTextEditor;
    const contextUri = toUri(contextValue);
    if (!editor || editor.document.uri.scheme !== 'file' ||
        (contextUri && contextUri.toString() !== editor.document.uri.toString())) {
      void vscode.window.showWarningMessage('请在本地文件编辑器中选中内容后查看 SVN 历史。');
      return;
    }
    const requestedUri = editor.document.uri;

    if (editor.document.isDirty) {
      const choice = await vscode.window.showWarningMessage(
        'SVN 逐行历史基于磁盘内容。需要先保存文件，才能确保选区行号准确。',
        { modal: true },
        '保存并查看'
      );
      if (choice !== '保存并查看' || !await editor.document.save()) {
        return;
      }
      editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== requestedUri.toString()) {
        void vscode.window.showWarningMessage('保存后活动编辑器已改变，请重新选择内容。');
        return;
      }
    }

    const ranges = selectedLineRanges(editor.selections);
    if (ranges.length === 0) {
      void vscode.window.showInformationMessage('请先选中至少一行文件内容。');
      return;
    }
    const status = this.statusFor(editor.document.uri);
    if (status?.item === 'unversioned') {
      void vscode.window.showInformationMessage('该文件尚未加入 SVN 版本管理，没有可查询的历史。');
      return;
    }

    const document = editor.document;
    const documentVersion = document.version;
    const selectedLines = snapshotSelectedLines(document, ranges);
    const requestKey = pathKey(document.uri.fsPath);
    const requestId = (this.selectionHistoryRequests.get(requestKey) ?? 0) + 1;
    this.selectionHistoryRequests.set(requestKey, requestId);
    try {
      const blameLines = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在分析 ${path.basename(document.uri.fsPath)} 的选中内容 SVN 历史…`
        },
        () => getSvnBlame(document.uri.fsPath)
      );
      if (this.selectionHistoryRequests.get(requestKey) !== requestId) {
        return;
      }
      const blameByLine = new Map(blameLines.map(line => [line.lineNumber, line]));
      const missingLine = selectedLines.find(line => !blameByLine.has(line.lineNumber));
      if (missingLine) {
        throw new Error(`SVN Blame 结果缺少第 ${missingLine.lineNumber} 行，请保存文件后重试。`);
      }
      const lines: SelectionHistoryLine[] = selectedLines.map(line => {
        const blame = blameByLine.get(line.lineNumber)!;
        return {
          ...line,
          revision: blame.revision,
          author: blame.author,
          date: blame.date
        };
      });
      this.selectionHistoryViewer.show(document.uri, {
        rangeLabel: formatLineRanges(ranges),
        lines,
        stale: document.version !== documentVersion
      });
    } catch (error) {
      if (this.selectionHistoryRequests.get(requestKey) !== requestId) {
        return;
      }
      const message = errorMessage(error);
      const friendly = /not a working copy|not under version control|is not under version control/i.test(message)
        ? '该文件不在 SVN 版本管理中，无法查看选中内容历史。'
        : `无法读取选中内容的 SVN 历史：${message}`;
      void vscode.window.showErrorMessage(friendly);
    }
  }

  private registerEvents(): void {
    this.context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh()),
      vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discoverRepositories()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('svn')) {
          this.restartAutoRefresh();
          void this.discoverRepositories();
        }
      })
    );
  }

  private restartAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const configuration = vscode.workspace.getConfiguration('svn');
    if (!configuration.get<boolean>('autoRefresh', true)) {
      return;
    }
    const interval = Math.max(1000, configuration.get<number>('refreshInterval', 3000));
    this.refreshTimer = setInterval(() => void this.refreshAll(), interval);
  }

  private async confirmAndRevert(uris: vscode.Uri[]): Promise<void> {
    const resources = uris.filter(uri => uri.scheme === 'file');
    if (resources.length === 0) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active?.scheme === 'file') {
        resources.push(active);
      }
    }

    const targets = resources
      .filter(uri => {
        const status = this.statusFor(uri);
        return status !== undefined && isVersionedChange(status);
      })
      .map(uri => uri.fsPath);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('所选资源没有可回退的 SVN 本地改动。');
      return;
    }

    const singleFile = targets.length === 1;
    const detail = singleFile
      ? `是否确实要放弃“${path.basename(targets[0])}”中的更改？此操作无法撤销。`
      : `是否确实要放弃所选 ${targets.length} 个文件中的更改？此操作无法撤销。`;
    const choice = await vscode.window.showWarningMessage(
      detail,
      { modal: true },
      singleFile ? '放弃文件' : '放弃所选文件'
    );
    if (!choice) {
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: singleFile ? `正在回退 ${path.basename(targets[0])}…` : `正在回退 ${targets.length} 个文件…`
        },
        () => revertSvnTargets(targets)
      );
      await this.refreshAll(true);
    } catch (error) {
      void vscode.window.showErrorMessage(`SVN 回退失败：${errorMessage(error)}`);
    }
  }

  private runNative(
    command: 'update' | 'commit' | 'add',
    uris: vscode.Uri[],
    accepts?: (status: SvnStatusEntry | undefined) => boolean,
    emptyMessage = '没有可操作的文件或目录。'
  ): void {
    const resources = uris.filter(uri => uri.scheme === 'file');
    if (resources.length === 0) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active?.scheme === 'file') {
        resources.push(active);
      }
    }
    const targets = resources
      .filter(uri => accepts?.(this.statusFor(uri)) ?? true)
      .map(uri => uri.fsPath);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(emptyMessage);
      return;
    }
    this.runNativePaths(command, targets);
  }

  private runNativePaths(
    command: 'update' | 'commit' | 'add',
    targets: string[],
    extraArgs: string[] = []
  ): void {
    try {
      const child = launchTortoise(command, targets, extraArgs);
      child.once('error', error => void vscode.window.showErrorMessage(`无法启动 TortoiseSVN：${error.message}`));
      child.once('close', () => this.scheduleRefresh());
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('svn-base', new SvnDocumentProvider('base')),
    vscode.workspace.registerTextDocumentContentProvider('svn-working', new SvnDocumentProvider('working')),
    vscode.workspace.registerTextDocumentContentProvider('svn-revision', new SvnDocumentProvider('revision'))
  );

  const manager = new RepositoryManager(context);
  context.subscriptions.push(manager);
  await manager.initialize();
}

export function deactivate(): void {}

function commandUris(first: unknown, selected: unknown): vscode.Uri[] {
  const values = [first, ...(Array.isArray(selected) ? selected : [])];
  const unique = new Map<string, vscode.Uri>();
  for (const value of values) {
    const uri = toUri(value);
    if (uri) {
      unique.set(uri.toString(), uri);
    }
  }
  return [...unique.values()];
}

function toUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) {
    return value;
  }
  if (value && typeof value === 'object' && 'resourceUri' in value) {
    const resourceUri = (value as { resourceUri?: unknown }).resourceUri;
    return resourceUri instanceof vscode.Uri ? resourceUri : undefined;
  }
  return undefined;
}

function addScope(
  map: Map<string, { root: string; scopes: Set<string> }>,
  root: string,
  scope: string
): void {
  const normalizedRoot = path.normalize(root);
  const key = pathKey(normalizedRoot);
  const existing = map.get(key) ?? { root: normalizedRoot, scopes: new Set<string>() };
  existing.scopes.add(path.normalize(scope));
  map.set(key, existing);
}

function compactScopes(root: string, scopes: string[]): string[] {
  const sorted = [...new Set(scopes)].sort((left, right) => left.length - right.length);
  const result: string[] = [];
  for (const scope of sorted) {
    if (!result.some(parent => isSameOrParent(parent, scope))) {
      result.push(scope);
    }
  }
  return result.some(scope => pathKey(scope) === pathKey(root)) ? [root] : result;
}

function isSameOrParent(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => pathKey(value) === pathKey(right[index]));
}

type LineRange = { start: number; end: number };

function selectedLineRanges(selections: readonly vscode.Selection[]): LineRange[] {
  const ranges = selections
    .filter(selection => !selection.isEmpty)
    .map(selection => {
      const start = selection.start.line;
      const end = selection.end.character === 0 && selection.end.line > start
        ? selection.end.line - 1
        : selection.end.line;
      return { start, end };
    })
    .filter(range => range.end >= range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: LineRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function snapshotSelectedLines(
  document: vscode.TextDocument,
  ranges: readonly LineRange[]
): Array<{ lineNumber: number; text: string }> {
  const lines: Array<{ lineNumber: number; text: string }> = [];
  for (const range of ranges) {
    const end = Math.min(range.end, document.lineCount - 1);
    for (let line = range.start; line <= end; line++) {
      lines.push({ lineNumber: line + 1, text: document.lineAt(line).text });
    }
  }
  return lines;
}

function formatLineRanges(ranges: readonly LineRange[]): string {
  return ranges.map(range => {
    const start = range.start + 1;
    const end = range.end + 1;
    return start === end ? String(start) : `${start}–${end}`;
  }).join(', ');
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
