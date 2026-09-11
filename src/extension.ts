import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { blameLineNumber, SvnBlameAnnotator } from './blame';
import { SvnConflictView } from './conflictView';
import { SvnLogViewer } from './logView';
import {
  createVirtualDocumentUri,
  isConflicted,
  isVersionedChange,
  SvnRepository,
  SvnSourceControl
} from './scm';
import { SelectionHistoryLine, SvnSelectionHistoryViewer } from './selectionHistoryView';
import {
  applySvnPatch,
  createSvnPatch,
  findWorkingCopyRoot,
  getBaseContent,
  getRevisionContent,
  getSvnBlame,
  launchTortoise,
  resolveSvnTargets,
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
  private readonly blameAnnotator = new SvnBlameAnnotator();
  private readonly conflictView = new SvnConflictView();
  private readonly sourceControl: SvnSourceControl;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshDebounce: NodeJS.Timeout | undefined;
  private discoveryDebounce: NodeJS.Timeout | undefined;
  private discovering: Promise<void> | undefined;
  private rediscoveryRequested = false;
  private readonly selectionHistoryRequests = new Map<string, number>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.sourceControl = new SvnSourceControl(
      context.workspaceState,
      context.globalState,
      vscode.Uri.joinPath(context.globalStorageUri, 'patches')
    );
    context.subscriptions.push(this.output, this.blameAnnotator, this.conflictView);
  }

  async initialize(): Promise<void> {
    this.registerCommands();
    await this.sourceControl.refreshPatches();
    this.registerEvents();
    this.restartAutoRefresh();
    await this.discoverRepositories();
  }

  async discoverRepositories(): Promise<void> {
    if (this.discovering) {
      this.rediscoveryRequested = true;
      return this.discovering;
    }

    do {
      this.rediscoveryRequested = false;
      this.discovering = this.doDiscoverRepositories();
      try {
        await this.discovering;
      } finally {
        this.discovering = undefined;
      }
    } while (this.rediscoveryRequested);
  }

  async refreshAll(showErrors = false): Promise<void> {
    const repositories = [...this.repositories.values()];
    const results = await Promise.allSettled(repositories.map(repository => repository.refresh()));
    this.sourceControl.update();
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const repository = repositories[index];
        const message = errorMessage(result.reason);
        this.log(`状态查询失败：root=${repository.rootUri.fsPath} targets=${formatPaths(repository.targets)} error=${message}`);
        if (showErrors) {
          void vscode.window.showErrorMessage(`SVN 状态刷新失败：${message}`);
        }
      }
    });
    await Promise.all([
      this.updateResourceContexts(),
      this.sourceControl.refreshPatches()
    ]);
    this.conflictView.setEntries(this.sourceControl.statusEntries);
  }

  scheduleRefresh(): void {
    if (this.refreshDebounce) {
      clearTimeout(this.refreshDebounce);
    }
    this.refreshDebounce = setTimeout(() => {
      void this.refreshAll().catch(error => this.log(`延迟刷新失败：${errorMessage(error)}`));
    }, 500);
  }

  scheduleDiscovery(): void {
    if (this.discoveryDebounce) {
      clearTimeout(this.discoveryDebounce);
    }
    this.discoveryDebounce = setTimeout(() => {
      void this.discoverRepositories().catch(error => this.log(`延迟发现失败：${errorMessage(error)}`));
    }, 500);
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    if (this.refreshDebounce) {
      clearTimeout(this.refreshDebounce);
    }
    if (this.discoveryDebounce) {
      clearTimeout(this.discoveryDebounce);
    }
    this.repositories.clear();
    this.sourceControl.dispose();
    this.logViewer.dispose();
    this.selectionHistoryViewer.dispose();
    void vscode.commands.executeCommand('setContext', 'svn.changedResourcePaths', []);
    void vscode.commands.executeCommand('setContext', 'svn.unversionedResourcePaths', []);
  }

  private async doDiscoverRepositories(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const scopesByRoot = new Map<string, { root: string; scopes: Set<string> }>();
    let discoveryComplete = true;

    await Promise.all(folders.map(async folder => {
      const folderPath = folder.uri.fsPath;
      const [rootResult, vscodeSearchResult, nativeSearchResult] = await Promise.allSettled([
        findWorkingCopyRoot(folderPath),
        vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/.svn/wc.db'), null),
        findWorkingCopyAdminFiles(folderPath, message => this.log(message))
      ]);

      if (rootResult.status === 'fulfilled') {
        if (rootResult.value) {
          addScope(scopesByRoot, rootResult.value, folderPath);
        }
      } else if (!isNotWorkingCopyError(rootResult.reason)) {
        discoveryComplete = false;
        this.log(`ERROR 查询工作区所属工作副本失败：folder=${folderPath} error=${errorMessage(rootResult.reason)}`);
      }

      const adminFiles = new Map<string, string>();
      if (vscodeSearchResult.status === 'fulfilled') {
        for (const uri of vscodeSearchResult.value) {
          adminFiles.set(pathKey(uri.fsPath), uri.fsPath);
        }
      } else {
        discoveryComplete = false;
        this.log(`ERROR VS Code 搜索 SVN 管理文件失败：folder=${folderPath} error=${errorMessage(vscodeSearchResult.reason)}`);
      }

      if (nativeSearchResult.status === 'fulfilled') {
        const scan = nativeSearchResult.value;
        discoveryComplete = discoveryComplete && scan.errors === 0;
        for (const adminFile of scan.adminFiles) {
          adminFiles.set(pathKey(adminFile), adminFile);
        }
      } else {
        discoveryComplete = false;
        this.log(`ERROR 原生扫描 SVN 管理文件失败：folder=${folderPath} error=${errorMessage(nativeSearchResult.reason)}`);
      }

      for (const adminFile of adminFiles.values()) {
        addScope(scopesByRoot, path.dirname(path.dirname(adminFile)), path.dirname(path.dirname(adminFile)));
      }
    }));

    if (discoveryComplete) {
      for (const [key, repository] of this.repositories) {
        if (!scopesByRoot.has(key)) {
          this.repositories.delete(key);
        }
      }
    }

    for (const [key, discovered] of scopesByRoot) {
      const targets = compactScopes(discovered.root, [...discovered.scopes]);
      const existing = this.repositories.get(key);
      if (!existing || !samePaths(existing.targets, targets)) {
        this.repositories.set(key, new SvnRepository(vscode.Uri.file(discovered.root), targets));
      }
    }

    await this.sourceControl.setRepositories([...this.repositories.values()]);
    await this.refreshAll();
  }

  private async updateResourceContexts(): Promise<void> {
    const changedPaths = new Set<string>();
    const unversionedPaths = new Set<string>();
    const conflictedPaths = new Set<string>();
    for (const entry of this.sourceControl.statusEntries) {
      const values = [vscode.Uri.file(entry.path).path, vscode.Uri.file(entry.path).fsPath];
      const target = entry.item === 'unversioned'
        ? unversionedPaths
        : isVersionedChange(entry)
          ? changedPaths
          : undefined;
      if (target) {
        values.forEach(value => target.add(value));
      }
      if (isConflicted(entry)) {
        values.forEach(value => conflictedPaths.add(value));
      }
    }
    await Promise.all([
      vscode.commands.executeCommand('setContext', 'svn.changedResourcePaths', [...changedPaths]),
      vscode.commands.executeCommand('setContext', 'svn.unversionedResourcePaths', [...unversionedPaths]),
      vscode.commands.executeCommand('setContext', 'svn.conflictedResourcePaths', [...conflictedPaths])
    ]);
  }

  private statusFor(uri: vscode.Uri): SvnStatusEntry | undefined {
    return this.sourceControl.statusFor(uri);
  }

  private registerCommands(): void {
    const register = (command: string, callback: (...args: unknown[]) => unknown) => {
      this.context.subscriptions.push(vscode.commands.registerCommand(command, callback));
    };

    register('svn.refresh', () => {
      this.output.show(true);
      return this.discoverRepositories();
    });
    register('svn.openFile', async first => {
      const source = toUri(first) ?? vscode.window.activeTextEditor?.document.uri;
      const uri = source ? toWorkingFileUri(source) : undefined;
      if (!uri) {
        void vscode.window.showWarningMessage('无法确定要打开的工作副本文件。');
        return;
      }

      try {
        const options: vscode.TextDocumentShowOptions = {
          preserveFocus: isSourceControlResourceState(first),
          preview: false,
          viewColumn: vscode.ViewColumn.Active
        };
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor?.document.uri.path === uri.path) {
          options.selection = activeEditor.selection;
        }
        await vscode.commands.executeCommand('vscode.open', uri, options);
      } catch (error) {
        void vscode.window.showErrorMessage(`无法打开工作副本文件：${errorMessage(error)}`);
      }
    });
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
      const working = status.item === 'deleted' || status.item === 'missing'
        ? createVirtualDocumentUri('svn-working', uri)
        : uri;
      await vscode.commands.executeCommand(
        'vscode.diff',
        base,
        working,
        `${path.basename(uri.fsPath)}（BASE ↔ 工作副本）`
      );
    });

    register('svn.update', (...values) => this.runNative('update', commandUris(...values)));
    register('svn.commit', (...values) => this.runNative('commit', commandUris(...values)));
    register('svn.log', (...values) => {
      const uri = commandUris(...values)[0] ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file') {
        void vscode.window.showWarningMessage('请选择一个本地 SVN 文件或目录查看日志。');
        return;
      }
      this.logViewer.show(uri);
    });
    register('svn.selectionHistory', first => this.showSelectionHistory(first));
    register('svn.blameLine', (...values) => this.blameLine(values));
    register('svn.revert', (...values) => this.confirmAndRevert(commandUris(...values)));
    register('svn.resolve', (...values) => this.resolveConflicts(commandUris(...values)));
    register('svn.openConflict', first => this.openConflictEditor(toUri(first)));
    register('svn.revertChange', (uri, changes, index) => this.revertChange(uri, changes, index));
    register('svn.createPatch', (...values) => this.createPatch(commandUris(...values)));
    register('svn.createPatchGroup', group => this.createGroupPatch(group));
    register('svn.openPatch', first => this.openPatch(toUri(first)));
    register('svn.applyPatch', first => this.applyPatch(toUri(first)));
    register('svn.removePatch', first => this.removePatch(toUri(first)));
    register('svn.add', (...values) => this.runNative(
      'add',
      commandUris(...values),
      status => status?.item === 'unversioned',
      '所选资源已经加入 SVN 版本管理或不在工作副本中。'
    ));
    register('svn.createCodeReview', (...values) => this.runNative(
      'gfcreatecr',
      commandUris(...values),
      status => status !== undefined && isVersionedChange(status),
      '所选资源没有可创建 Code Review 的 SVN 改动。'
    ));
    register('svn.moveToNewGroup', (...values) => this.moveToNewGroup(commandUris(...values)));
    register('svn.moveToExistingGroup', (...values) => this.moveToExistingGroup(commandUris(...values)));
    register('svn.renameGroup', group => this.renameGroup(group));
    register('svn.deleteGroup', group => this.deleteGroup(group));
    register('svn.commitGroup', group => this.runGroupNative('commit', group));
    register('svn.revertGroup', group => this.revertGroup(group));
    register('svn.createCodeReviewGroup', group => this.runGroupNative('gfcreatecr', group));
  }

  private async blameLine(values: unknown[]): Promise<void> {
    const uri = commandUris(...values)[0];
    const editor = (uri ? this.visibleEditor(uri) : undefined) ?? vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('请在本地文件编辑器中查看 Blame 信息。');
      return;
    }
    // 行号右键菜单可能把行号作为参数传入，否则回落到光标所在行。
    const line = blameLineNumber(values) ?? editor.selection.active.line;
    await this.blameAnnotator.toggle(editor, line);
  }

  private visibleEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
    const key = uri.toString();
    return vscode.window.visibleTextEditors.find(
      editor => editor.document.uri.toString() === key);
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
    const workingCopyWatcher = vscode.workspace.createFileSystemWatcher('**/.svn/wc.db');
    this.context.subscriptions.push(
      workingCopyWatcher,
      workingCopyWatcher.onDidCreate(() => this.scheduleDiscovery()),
      workingCopyWatcher.onDidDelete(() => this.scheduleDiscovery()),
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

  private async revertChange(
    uriValue: unknown,
    changesValue: unknown,
    indexValue: unknown
  ): Promise<void> {
    const uri = toUri(uriValue);
    const changes = toLineChanges(changesValue);
    const index = Number(indexValue);
    if (!uri || uri.scheme !== 'file' || !changes ||
        !Number.isInteger(index) || index < 0 || index >= changes.length) {
      void vscode.window.showWarningMessage('无法确定要回退的 SVN 差异，请重新打开快速差异后重试。');
      return;
    }

    const editor = vscode.window.visibleTextEditors.find(
      value => value.document.uri.toString() === uri.toString());
    if (!editor) {
      void vscode.window.showWarningMessage('请保持对应文件可见后再回退此差异。');
      return;
    }

    const status = this.statusFor(uri);
    if (!status || !['added', 'deleted', 'missing', 'modified', 'replaced'].includes(status.item) ||
        status.props === 'conflicted') {
      void vscode.window.showInformationMessage('该文件当前状态不支持安全地回退单个差异。');
      return;
    }
    const document = editor.document;
    if (document.isDirty) {
      void vscode.window.showWarningMessage('请先保存文件，再回退快速差异。这样可以避免覆盖其他未保存的编辑。');
      return;
    }
    const documentVersion = document.version;
    const choice = await vscode.window.showWarningMessage(
      `是否回退“${path.basename(uri.fsPath)}”中的当前差异？其他本地更改将保留。`,
      {modal: true},
      '回退此差异'
    );
    if (choice !== '回退此差异') {
      return;
    }
    if (document.version !== documentVersion) {
      void vscode.window.showWarningMessage('文件内容已变化，请重新打开快速差异后再回退。');
      return;
    }

    try {
      const baseContent = status.item === 'added' ? '' :
        await getBaseContent(uri.fsPath);
      if (document.version !== documentVersion || document.isDirty) {
        void vscode.window.showWarningMessage('文件内容已变化，请重新打开快速差异后再回退。');
        return;
      }
      if (baseContent.includes('\uFFFD')) {
        void vscode.window.showWarningMessage('SVN BASE 内容可能不是 UTF-8 编码，已取消回退以避免损坏文件。');
        return;
      }
      const changeEdit = createRevertChangeEdit(baseContent, document, changes[index]);
      const viewState = captureRevertViewState(editor, changeEdit.range);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, changeEdit.range, changeEdit.text);
      if (!await vscode.workspace.applyEdit(edit)) {
        throw new Error('VS Code 未能应用文件编辑。');
      }
      if (!await document.save()) {
        throw new Error('文件保存失败。');
      }
      restoreRevertViewState(editor, changeEdit.range.start, viewState);
      await this.refreshAll(true);
    } catch (error) {
      void vscode.window.showErrorMessage(`SVN 差异回退失败：${errorMessage(error)}`);
    }
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
        () => Promise.all(this.partitionTargets(targets).map(partition => revertSvnTargets(partition))).then(() => undefined)
      );
      await this.refreshAll(true);
    } catch (error) {
      void vscode.window.showErrorMessage(`SVN 回退失败：${errorMessage(error)}`);
    }
  }

  private async resolveConflicts(uris: vscode.Uri[]): Promise<void> {
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
        return status !== undefined && isConflicted(status);
      })
      .map(uri => uri.fsPath);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('所选资源没有处于冲突状态，无需解决冲突。');
      return;
    }

    const singleFile = targets.length === 1;
    const detail = singleFile
      ? `将把“${path.basename(targets[0])}”的当前内容标记为冲突已解决，并删除 .mine / .r* 临时文件。请先确认文件中的冲突标记已经处理完毕。`
      : `将把所选 ${targets.length} 个文件的当前内容标记为冲突已解决，并删除 .mine / .r* 临时文件。请先确认文件中的冲突标记已经处理完毕。`;
    const choice = await vscode.window.showWarningMessage(detail, { modal: true }, '标记为已解决');
    if (!choice) {
      return;
    }

    try {
      // --accept working 采用磁盘上的内容，未保存的编辑器改动必须先落盘。
      await this.saveTargetDocuments(targets);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: singleFile
            ? `正在解决 ${path.basename(targets[0])} 的冲突…`
            : `正在解决 ${targets.length} 个文件的冲突…`
        },
        () => Promise.all(this.partitionTargets(targets).map(partition => resolveSvnTargets(partition)))
            .then(() => undefined)
      );
      await this.refreshAll(true);
    } catch (error) {
      void vscode.window.showErrorMessage(`SVN 解决冲突失败：${errorMessage(error)}`);
    }
  }

  private async openConflictEditor(uri: vscode.Uri | undefined): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') {
      void vscode.window.showWarningMessage('请选择一个处于冲突状态的 SVN 文件。');
      return;
    }
    const status = this.statusFor(target);
    if (!status || !isConflicted(status)) {
      void vscode.window.showInformationMessage('该文件当前没有 SVN 冲突。');
      return;
    }

    // 使用 TortoiseMerge 的三方冲突编辑窗口，不可用时回落到 VS Code 编辑器自带的冲突处理。
    if (process.platform === 'win32') {
      try {
        const child = launchTortoise('conflicteditor', [target.fsPath]);
        child.once('error', () => {
          void vscode.window.showWarningMessage('无法启动 TortoiseSVN 冲突编辑窗口，已改为在 VS Code 中打开文件。');
          void this.showWorkingFile(target);
        });
        return;
      } catch (error) {
        void vscode.window.showWarningMessage(
          `无法启动 TortoiseSVN 冲突编辑窗口：${errorMessage(error)}，已改为在 VS Code 中打开文件。`);
      }
    }
    await this.showWorkingFile(target);
  }

  private async showWorkingFile(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.window.showTextDocument(uri, { preview: false });
    } catch (error) {
      void vscode.window.showErrorMessage(`无法打开文件：${errorMessage(error)}`);
    }
  }

  private async saveTargetDocuments(targets: readonly string[]): Promise<void> {
    const keys = new Set(targets.map(target => pathKey(target)));
    const dirty = vscode.workspace.textDocuments.filter(
      document => document.isDirty && !document.isUntitled && document.uri.scheme === 'file' &&
          keys.has(pathKey(document.uri.fsPath)));
    for (const document of dirty) {
      await document.save();
    }
  }

  private createGroupPatch(value: unknown): Promise<void> | undefined {
    const group = this.sourceControl.resourceGroup(value);
    if (!group) {
      return undefined;
    }
    return this.createPatch(
      this.sourceControl.groupTargets(group).map(filePath => vscode.Uri.file(filePath))
    );
  }

  private async createPatch(uris: vscode.Uri[]): Promise<void> {
    const resources = uris.filter(uri => uri.scheme === 'file');
    const targets = resources
      .filter(uri => {
        const status = this.statusFor(uri);
        return status !== undefined && isVersionedChange(status);
      })
      .map(uri => uri.fsPath);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('所选资源没有可创建 Patch 的 SVN 本地改动。');
      return;
    }
    const repositories = new Map<string, { root: string; targets: string[] }>();
    for (const target of targets) {
      const repository = this.sourceControl.repositoryForUri(vscode.Uri.file(target));
      if (!repository) {
        continue;
      }
      const key = pathKey(repository.rootUri.fsPath);
      const item = repositories.get(key) ?? { root: repository.rootUri.fsPath, targets: [] };
      item.targets.push(target);
      repositories.set(key, item);
    }
    if (repositories.size !== 1) {
      void vscode.window.showWarningMessage('创建 Patch 时请选择同一个 SVN 工作副本中的文件。');
      return;
    }
    const repository = [...repositories.values()][0];
    const input = await vscode.window.showInputBox({
      title: '创建 SVN Patch',
      prompt: '输入 Patch 文件名',
      value: `svn-${new Date().toISOString().replace(/[:.]/g, '-')}.patch`,
      ignoreFocusOut: true
    });
    if (input === undefined) {
      return;
    }
    const fileName = normalizePatchFileName(input);
    if (!fileName) {
      void vscode.window.showWarningMessage('Patch 文件名只能包含普通文件名，且扩展名必须为 .patch 或 .diff。');
      return;
    }
    let patchUri = this.sourceControl.patchFileUri(fileName);
    let suffix = 1;
    while (await fileExists(patchUri.fsPath)) {
      const extension = path.extname(fileName);
      const stem = fileName.slice(0, -extension.length);
      patchUri = this.sourceControl.patchFileUri(`${stem}-${suffix}${extension}`);
      suffix += 1;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在创建 ${path.basename(patchUri.fsPath)}…` },
        () => createSvnPatch(repository.targets, patchUri.fsPath, repository.root)
      );
      await this.sourceControl.rememberPatch(patchUri, repository.root);
      await this.sourceControl.refreshPatches();
      void vscode.window.showInformationMessage(`Patch 已创建：${path.basename(patchUri.fsPath)}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`创建 Patch 失败：${errorMessage(error)}`);
    }
  }

  private async openPatch(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri || !this.sourceControl.isPatchUri(uri)) {
      void vscode.window.showWarningMessage('无法确定要打开的 Patch 文件。');
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  private async applyPatch(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri || !this.sourceControl.isPatchUri(uri)) {
      void vscode.window.showWarningMessage('无法确定要应用的 Patch 文件。');
      return;
    }
    const repositoryRoots = this.sourceControl.repositoryRoots;
    const storedRoot = this.sourceControl.patchRoot(uri);
    let root = storedRoot && repositoryRoots.find(candidate => pathKey(candidate) === pathKey(storedRoot));
    if (!root) {
      if (repositoryRoots.length === 0) {
        void vscode.window.showWarningMessage('当前工作区中没有可应用该 Patch 的 SVN 工作副本。');
        return;
      }
      const selected = await vscode.window.showQuickPick(
        repositoryRoots.map(candidate => ({
          label: path.basename(candidate),
          description: candidate,
          root: candidate
        })),
        {
          title: `选择应用 ${path.basename(uri.fsPath)} 的 SVN 工作副本`,
          placeHolder: storedRoot
            ? `原工作副本当前未打开：${storedRoot}`
            : '该 Patch 未记录工作副本，请选择应用位置',
          ignoreFocusOut: true
        }
      );
      if (!selected) {
        return;
      }
      root = selected.root;
      await this.sourceControl.rememberPatch(uri, root);
      await this.sourceControl.refreshPatches();
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在应用 ${path.basename(uri.fsPath)}…` },
        () => applySvnPatch(uri.fsPath, root)
      );
      await this.refreshAll(true);
      void vscode.window.showInformationMessage(`Patch 已应用：${path.basename(uri.fsPath)}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`应用 Patch 失败：${errorMessage(error)}`);
    }
  }

  private async removePatch(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri || !this.sourceControl.isPatchUri(uri)) {
      void vscode.window.showWarningMessage('无法确定要移除的 Patch 文件。');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `是否移除 Patch 文件“${path.basename(uri.fsPath)}”？此操作不会回退已应用的修改。`,
      { modal: true },
      '移除 Patch'
    );
    if (choice !== '移除 Patch') {
      return;
    }
    try {
      await fs.rm(uri.fsPath, { force: true });
      await this.sourceControl.forgetPatch(uri);
      await this.sourceControl.refreshPatches();
    } catch (error) {
      void vscode.window.showErrorMessage(`移除 Patch 失败：${errorMessage(error)}`);
    }
  }

  private async moveToNewGroup(uris: vscode.Uri[]): Promise<void> {
    if (uris.length === 0) {
      void vscode.window.showWarningMessage('请选择要分组的 SVN 差异文件。');
      return;
    }
    const label = await vscode.window.showInputBox({
      title: '新建 SVN 分组',
      prompt: '输入分组名称',
      placeHolder: '分组名称',
      ignoreFocusOut: true
    });
    if (label === undefined) {
      return;
    }
    try {
      await this.sourceControl.createGroup(label, uris);
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  }

  private async moveToExistingGroup(uris: vscode.Uri[]): Promise<void> {
    if (uris.length === 0) {
      void vscode.window.showWarningMessage('请选择要分组的 SVN 差异文件。');
      return;
    }
    const label = await vscode.window.showQuickPick(this.sourceControl.groupLabels, {
      title: '移动到分组',
      placeHolder: '选择目标分组',
      ignoreFocusOut: true
    });
    if (!label) {
      return;
    }
    const group = this.sourceControl.findGroupByLabel(label);
    if (!group) {
      void vscode.window.showErrorMessage(`分组“${label}”已不存在。`);
      return;
    }
    try {
      await this.sourceControl.moveResources(uris, group);
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  }

  private async renameGroup(value: unknown): Promise<void> {
    const group = this.sourceControl.resourceGroup(value);
    if (!group) {
      return;
    }
    const current = this.sourceControl.groupLabel(group);
    const label = await vscode.window.showInputBox({
      title: '重命名 SVN 分组',
      prompt: '输入新的分组名称',
      value: current,
      valueSelection: [0, current.length],
      ignoreFocusOut: true
    });
    if (label === undefined || label.trim() === current) {
      return;
    }
    try {
      await this.sourceControl.renameGroup(group, label);
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  }

  private async deleteGroup(value: unknown): Promise<void> {
    const group = this.sourceControl.resourceGroup(value);
    if (!group) {
      return;
    }
    const label = this.sourceControl.groupLabel(group);
    const count = group.resourceStates.length;
    const choice = await vscode.window.showWarningMessage(
      `是否删除分组“${label}”？组内 ${count} 个差异文件将移入默认分组。`,
      { modal: true },
      '删除分组'
    );
    if (choice !== '删除分组') {
      return;
    }
    try {
      await this.sourceControl.deleteGroup(group);
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  }

  private runGroupNative(command: 'commit' | 'gfcreatecr', value: unknown): void {
    const group = this.sourceControl.resourceGroup(value);
    if (!group) {
      return;
    }
    const targets = this.sourceControl.groupTargets(group);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(`分组“${this.sourceControl.groupLabel(group)}”中没有差异文件。`);
      return;
    }
    this.runNativePaths(command, targets);
  }

  private revertGroup(value: unknown): void {
    const group = this.sourceControl.resourceGroup(value);
    if (!group) {
      return;
    }
    void this.confirmAndRevert(this.sourceControl.groupTargets(group).map(vscode.Uri.file));
  }

  private runNative(
    command: 'update' | 'commit' | 'add' | 'gfcreatecr',
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
    if (command === 'update' && targets.length === 0) {
      targets.push(...[...this.repositories.values()].flatMap(repository => repository.targets));
    }
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(emptyMessage);
      return;
    }
    this.runNativePaths(command, targets);
  }

  private runNativePaths(
    command: 'update' | 'commit' | 'add' | 'gfcreatecr',
    targets: string[]
  ): void {
    for (const partition of this.partitionTargets(targets)) {
      try {
        const child = launchTortoise(command, partition);
        child.once('error', error => void vscode.window.showErrorMessage(`无法启动 TortoiseSVN：${error.message}`));
        child.once('close', () => this.scheduleRefresh());
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
      }
    }
  }

  private partitionTargets(targets: readonly string[]): string[][] {
    const partitions = new Map<string, string[]>();
    for (const target of targets) {
      const repository = this.sourceControl.repositoryForUri(vscode.Uri.file(target));
      const key = repository ? pathKey(repository.rootUri.fsPath) : '';
      const partition = partitions.get(key) ?? [];
      partition.push(target);
      partitions.set(key, partition);
    }
    return [...partitions.values()];
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

type LineChange = {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
};

function toLineChanges(value: unknown): LineChange[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const changes: LineChange[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return undefined;
    }
    const candidate = item as Record<keyof LineChange, unknown>;
    const change = {
      originalStartLineNumber: Number(candidate.originalStartLineNumber),
      originalEndLineNumber: Number(candidate.originalEndLineNumber),
      modifiedStartLineNumber: Number(candidate.modifiedStartLineNumber),
      modifiedEndLineNumber: Number(candidate.modifiedEndLineNumber)
    };
    if (!Object.values(change).every(
      line => Number.isInteger(line) && line >= 0)) {
      return undefined;
    }
    changes.push(change);
  }
  return changes;
}

type RevertChangeEdit = {
  range: vscode.Range;
  text: string;
};

type RevertViewState = {
  selections: vscode.Selection[];
  insideChange: boolean[];
  topLine: number;
};

function captureRevertViewState(editor: vscode.TextEditor, range: vscode.Range): RevertViewState {
  return {
    selections: editor.selections.map(selection => new vscode.Selection(selection.anchor, selection.active)),
    insideChange: editor.selections.map(selection =>
      selection.start.isBeforeOrEqual(range.end) && selection.end.isAfterOrEqual(range.start)),
    topLine: editor.visibleRanges[0]?.start.line ?? 0
  };
}

function restoreRevertViewState(
  editor: vscode.TextEditor,
  anchor: vscode.Position,
  state: RevertViewState
): void {
  const document = editor.document;
  if (document.isClosed || document.lineCount === 0) {
    return;
  }
  const maxLine = document.lineCount - 1;
  const clamp = (position: vscode.Position): vscode.Position => {
    const line = Math.min(Math.max(position.line, 0), maxLine);
    const character = Math.min(Math.max(position.character, 0), document.lineAt(line).text.length);
    return new vscode.Position(line, character);
  };

  // 回退后把光标收回到被回退的文本块起点，避免它滑到编辑末尾而落到相邻差异上。
  const cursor = clamp(anchor);
  editor.selections = state.selections.map((selection, order) => state.insideChange[order]
    ? new vscode.Selection(cursor, cursor)
    : new vscode.Selection(clamp(selection.anchor), clamp(selection.active)));

  const topLine = Math.min(Math.max(state.topLine, 0), maxLine);
  const currentTop = editor.visibleRanges[0]?.start.line ?? 0;
  if (currentTop !== topLine) {
    editor.revealRange(new vscode.Range(topLine, 0, topLine, 0), vscode.TextEditorRevealType.AtTop);
  }
}

function createRevertChangeEdit(
  original: string,
  modified: vscode.TextDocument,
  change: LineChange
): RevertChangeEdit {
  const originalLines = indexTextLines(original);
  const isInsertion = change.originalEndLineNumber === 0;
  const isDeletion = change.modifiedEndLineNumber === 0;
  if (isInsertion && isDeletion) {
    throw new RangeError('差异两侧均为空。');
  }

  if (isInsertion) {
    validateLineRange(
      change.modifiedStartLineNumber,
      change.modifiedEndLineNumber,
      modified.lineCount
    );
    let start = new vscode.Position(change.modifiedStartLineNumber - 1, 0);
    const end = documentLineRangeEnd(modified, change.modifiedEndLineNumber);
    if (change.modifiedStartLineNumber > 1 &&
        change.originalStartLineNumber === originalLines.starts.length &&
        !endsWithLineBreak(original)) {
      start = modified.lineAt(change.modifiedStartLineNumber - 2).range.end;
    }
    return { range: new vscode.Range(start, end), text: '' };
  }

  validateLineRange(
    change.originalStartLineNumber,
    change.originalEndLineNumber,
    originalLines.starts.length
  );
  let text = originalLineRange(
    original,
    originalLines,
    change.originalStartLineNumber,
    change.originalEndLineNumber
  );
  text = convertEol(text, modified.eol);

  if (isDeletion) {
    if (change.modifiedStartLineNumber > modified.lineCount) {
      throw new RangeError(`无效的修改后行号：${change.modifiedStartLineNumber}`);
    }
    const position = change.modifiedStartLineNumber < modified.lineCount
      ? new vscode.Position(change.modifiedStartLineNumber, 0)
      : modified.lineAt(modified.lineCount - 1).range.end;
    if (change.modifiedStartLineNumber > 0 &&
        change.modifiedStartLineNumber === modified.lineCount &&
        !endsWithLineBreak(modified.getText())) {
      text = documentEol(modified) + text;
    }
    return { range: new vscode.Range(position, position), text };
  }

  validateLineRange(
    change.modifiedStartLineNumber,
    change.modifiedEndLineNumber,
    modified.lineCount
  );
  return {
    range: new vscode.Range(
      change.modifiedStartLineNumber - 1,
      0,
      documentLineRangeEnd(modified, change.modifiedEndLineNumber).line,
      documentLineRangeEnd(modified, change.modifiedEndLineNumber).character
    ),
    text
  };
}

type TextLineIndex = {
  starts: number[];
};

function indexTextLines(content: string): TextLineIndex {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    const character = content.charCodeAt(index);
    if (character !== 10 && character !== 13) {
      continue;
    }
    if (character === 13 && content.charCodeAt(index + 1) === 10) {
      index += 1;
    }
    starts.push(index + 1);
  }
  return { starts };
}

function originalLineRange(
  content: string,
  lines: TextLineIndex,
  startLineNumber: number,
  endLineNumber: number
): string {
  const start = lines.starts[startLineNumber - 1];
  const end = endLineNumber < lines.starts.length
    ? lines.starts[endLineNumber]
    : content.length;
  return content.slice(start, end);
}

function documentLineRangeEnd(
  document: vscode.TextDocument,
  endLineNumber: number
): vscode.Position {
  return endLineNumber < document.lineCount
    ? new vscode.Position(endLineNumber, 0)
    : document.lineAt(document.lineCount - 1).range.end;
}

function validateLineRange(start: number, end: number, lineCount: number): void {
  if (start < 1 || end < start || end > lineCount) {
    throw new RangeError(`无效的差异行范围：${start}-${end}`);
  }
}

function convertEol(content: string, eol: vscode.EndOfLine): string {
  return content.replace(/\r\n|\r|\n/g, documentEol(eol));
}

function documentEol(documentOrEol: vscode.TextDocument | vscode.EndOfLine): string {
  const eol = typeof documentOrEol === 'number'
    ? documentOrEol
    : documentOrEol.eol;
  return eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function endsWithLineBreak(content: string): boolean {
  return /[\r\n]$/.test(content);
}

function normalizePatchFileName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || path.basename(trimmed) !== trimmed || trimmed === '.' || trimmed === '..') {
    return undefined;
  }
  return /\.(patch|diff)$/i.test(trimmed) ? trimmed : `${trimmed}.patch`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function commandUris(...values: unknown[]): vscode.Uri[] {
  const unique = new Map<string, vscode.Uri>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    const uri = toUri(value);
    if (uri) {
      unique.set(uri.toString(), uri);
    }
  };
  values.forEach(collect);
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

function toWorkingFileUri(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme === 'file') {
    return uri;
  }
  if (!['svn-base', 'svn-working', 'svn-revision'].includes(uri.scheme)) {
    return undefined;
  }
  const filePath = new URLSearchParams(uri.query).get('path');
  return filePath ? vscode.Uri.file(filePath) : undefined;
}

function isSourceControlResourceState(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'resourceUri' in value;
}

type WorkingCopyScanResult = {
  adminFiles: string[];
  scannedDirectories: number;
  errors: number;
  elapsedMs: number;
};

async function findWorkingCopyAdminFiles(
  rootPath: string,
  log: (message: string) => void
): Promise<WorkingCopyScanResult> {
  const startedAt = Date.now();
  const adminFiles: string[] = [];
  const pending = [path.normalize(rootPath)];
  let scannedDirectories = 0;
  let errors = 0;
  while (pending.length > 0) {
    const batch = pending.splice(0, 32);
    const discoveredChildren = await Promise.all(batch.map(async directory => {
      try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        scannedDirectories += 1;
        const svnDirectory = entries.find(entry =>
          entry.isDirectory() && entry.name.toLocaleLowerCase() === '.svn');
        if (svnDirectory) {
          const wcDatabase = path.join(directory, svnDirectory.name, 'wc.db');
          try {
            const stat = await fs.stat(wcDatabase);
            if (stat.isFile()) {
              adminFiles.push(path.normalize(wcDatabase));
            }
          } catch (error) {
            log(`ERROR 原生扫描发现 .svn 但无法读取 wc.db：path=${wcDatabase} error=${errorMessage(error)}`);
          }
        }

        return entries
          .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() &&
            entry.name.toLocaleLowerCase() !== '.svn')
          .map(entry => path.join(directory, entry.name));
      } catch (error) {
        errors += 1;
        log(`ERROR 原生扫描目录失败：path=${directory} error=${errorMessage(error)}`);
        return [];
      }
    }));
    pending.push(...discoveredChildren.flat());
  }

  return {
    adminFiles,
    scannedDirectories,
    errors,
    elapsedMs: Date.now() - startedAt
  };
}

function formatPaths(paths: readonly string[]): string {
  return paths.length === 0 ? '[]' : `[${paths.join(' | ')}]`;
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

function isNotWorkingCopyError(error: unknown): boolean {
  const message = errorMessage(error);
  return /not a working copy|not under version control|is not under version control|E155007|E155010/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
