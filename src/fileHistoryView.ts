import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { changedPathDiff, repositoryUrl } from './logView';
import {
  findWorkingCopyRoot, getSvnLog, getSvnTargetInfo, mergeSvnRevision, parseSvnMergeOutput, reverseMergeSvn,
  SvnLogChangedPath, SvnLogEntry, SvnMergeChange, updateSvnToRevision, updateSvnWorkingCopy
} from './svn';

const FILE_HISTORY_VIEW_ID = 'svn.fileHistoryView';
const CHANGED_PATH_SCHEME = 'svn-history-path';
const COMMIT_MARK_SCHEME = 'svn-history-commit';
const LAST_MERGE_DIRECTORY_KEY = 'svn.fileHistory.lastMergeDirectory';
const PAGE_SIZE = 50;

type HistoryNode = CommitNode | ChangedPathNode | LoadMoreNode;

/**
 * “源代码管理”侧栏中的文件日志视图：跟随当前活动编辑器，按时间倒序列出该文件的 SVN 提交记录，
 * 展开提交可查看该次提交修改的全部路径。
 */
export class SvnFileHistoryView implements vscode.Disposable, vscode.TreeDataProvider<HistoryNode> {
  private readonly emitter = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<HistoryNode> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private state: vscode.Memento | undefined;
  private target: vscode.Uri | undefined;
  private entries: SvnLogEntry[] = [];
  private readonly expanded = new Set<number>();
  private baseRevision: number | undefined;
  private repositoryRoot: string | undefined;
  private targetUrl: string | undefined;
  private targetRepositoryPath: string | undefined;
  private nextRevision: number | undefined;
  private hasMore = false;
  private loading = false;
  private errorText: string | undefined;
  private stale = true;
  private requestId = 0;

  constructor() {
    this.view = this.createView();
  }

  /** 注册视图命令并开始跟随活动编辑器；state 用于记住“合并到目标分支”上次选择的目录。 */
  start(state?: vscode.Memento): void {
    this.state = state;
    const register = (command: string, callback: (...args: unknown[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(command, callback));
    register('svn.fileHistory.refresh', () => this.reload());
    register('svn.fileHistory.loadMore', () => this.loadMore());
    register('svn.fileHistory.openLog', () => this.openFullLog());
    register('svn.fileHistory.toggle', node => this.toggle(asCommit(node)));
    register('svn.fileHistory.openChanges', node => this.openCommitChanges(asCommit(node)));
    register('svn.fileHistory.openFileDiff', node => this.openFileDiff(node instanceof ChangedPathNode ? node : undefined));
    register('svn.fileHistory.compareWorking', node => this.compareWorking(asCommit(node)));
    register('svn.fileHistory.openRevision', node => this.openRevision(asCommit(node)));
    register('svn.fileHistory.copyRevision', node => this.copy(asCommit(node), commit => `r${commit.entry.revision}`));
    register('svn.fileHistory.copyMessage', node => this.copy(asCommit(node), commit => commit.entry.message));
    register('svn.fileHistory.updateToRevision', node => this.updateToRevision(asCommit(node)));
    register('svn.fileHistory.revertToRevision', node => this.revertToRevision(asCommit(node)));
    register('svn.fileHistory.revertChangesFromRevision', node => this.revertChangesFromRevision(asCommit(node)));
    register('svn.fileHistory.mergeToBranch', node => this.mergeToBranch(asCommit(node)));
    this.disposables.push(vscode.window.registerFileDecorationProvider(new ChangedPathDecorations()));

    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => this.track(editor)));
    if (this.view) {
      this.disposables.push(this.view.onDidChangeVisibility(event => {
        if (event.visible && this.stale) {
          void this.reload();
        }
      }));
    }
    this.track(vscode.window.activeTextEditor);
    this.updateMessage();
  }

  getTreeItem(element: HistoryNode): vscode.TreeItem {
    return element;
  }

  /**
   * 以扁平列表呈现：提交与其展开后的变更文件处于同一层级，从而不显示展开/折叠箭头，
   * 左侧由连续的提交线图标串联，展开状态由实心/空心圆点表示。
   */
  getChildren(element?: HistoryNode): HistoryNode[] {
    if (element || !this.target) {
      return [];
    }
    const nodes: HistoryNode[] = [];
    const base = this.baseRevision;
    // “当前”：工作副本所在版本中该文件最后一次提交，即修订号不大于 BASE 的第一条记录。
    const currentRevision = base === undefined ? undefined : this.entries.find(entry => entry.revision <= base)?.revision;
    this.entries.forEach((entry, index) => {
      const expanded = this.expanded.has(entry.revision) && entry.changedPaths.length > 0;
      const continues = index < this.entries.length - 1 || this.hasMore;
      const commit = new CommitNode(this.target!, entry, base, {
        above: index > 0,
        below: continues || expanded,
        expanded
      }, { current: entry.revision === currentRevision, latest: index === 0 });
      nodes.push(commit);
      if (expanded) {
        const files = sortChangedPaths(entry.changedPaths);
        files.forEach((changed, fileIndex) => nodes.push(new ChangedPathNode(
          commit, changed, changed.path === this.targetRepositoryPath,
          !continues && fileIndex === files.length - 1)));
      }
    });
    if (this.hasMore && this.entries.length > 0) {
      nodes.push(new LoadMoreNode(this.loading));
    }
    return nodes;
  }

  private toggle(commit: CommitNode | undefined): void {
    if (!commit) {
      return;
    }
    const revision = commit.entry.revision;
    if (!this.expanded.delete(revision)) {
      this.expanded.add(revision);
    }
    this.emitter.fire(undefined);
  }

  /** 工作副本可能已经更新或提交，标记日志过期；视图可见时立即重新加载。 */
  invalidate(): void {
    this.stale = true;
    if (this.view?.visible) {
      void this.reload();
    }
  }

  dispose(): void {
    this.requestId++;
    this.disposables.forEach(disposable => disposable.dispose());
    this.view?.dispose();
    this.emitter.dispose();
  }

  private createView(): vscode.TreeView<HistoryNode> | undefined {
    try {
      return vscode.window.createTreeView(FILE_HISTORY_VIEW_ID, {
        treeDataProvider: this,
        showCollapseAll: false
      });
    } catch (error) {
      const message = errorMessage(error);
      console.error(`[SVN Compass] 无法创建“文件日志”视图：${message}`);
      void vscode.window.showWarningMessage(
        `“文件日志”视图注册失败（${message}）。请卸载扩展后重新安装，并执行“开发人员: 重新加载窗口”。`);
      return undefined;
    }
  }

  private track(editor: vscode.TextEditor | undefined): void {
    const uri = editor ? localFileUri(editor.document.uri) : undefined;
    // 切到输出面板、Diff 中的历史版本等非本地文件时保留当前文件日志，与 Git 时间线行为一致。
    if (!uri || this.target && pathKey(this.target.fsPath) === pathKey(uri.fsPath)) {
      return;
    }
    this.target = uri;
    this.requestId++;
    this.entries = [];
    this.expanded.clear();
    this.baseRevision = undefined;
    this.repositoryRoot = undefined;
    this.targetUrl = undefined;
    this.targetRepositoryPath = undefined;
    this.nextRevision = undefined;
    this.hasMore = false;
    this.loading = false;
    this.errorText = undefined;
    this.stale = true;
    this.emitter.fire(undefined);
    this.updateMessage();
    if (this.view?.visible) {
      void this.reload();
    }
  }

  private async reload(): Promise<void> {
    const target = this.target;
    if (!target) {
      this.updateMessage();
      return;
    }
    const id = ++this.requestId;
    this.stale = false;
    this.loading = true;
    this.errorText = undefined;
    this.updateMessage();
    try {
      const [info, page] = await Promise.all([
        getSvnTargetInfo(target.fsPath).catch(() => undefined),
        getSvnLog(target.fsPath, undefined, PAGE_SIZE)
      ]);
      if (id !== this.requestId) {
        return;
      }
      const base = Number(info?.revision);
      this.baseRevision = Number.isInteger(base) && base > 0 ? base : undefined;
      this.repositoryRoot = info?.repositoryRoot;
      this.targetUrl = info?.url;
      this.targetRepositoryPath = info ? repositoryPathOf(info.url, info.repositoryRoot) : undefined;
      this.entries = page.entries;
      this.nextRevision = page.nextRevision;
      this.hasMore = page.hasMore && page.nextRevision !== undefined;
    } catch (error) {
      if (id !== this.requestId) {
        return;
      }
      this.entries = [];
      this.hasMore = false;
      this.errorText = friendlyError(error);
    } finally {
      if (id === this.requestId) {
        this.loading = false;
        this.emitter.fire(undefined);
        this.updateMessage();
      }
    }
  }

  private async loadMore(): Promise<void> {
    const target = this.target;
    if (!target || this.loading || !this.hasMore) {
      return;
    }
    const id = this.requestId;
    this.loading = true;
    this.emitter.fire(undefined);
    try {
      const page = await getSvnLog(target.fsPath, this.nextRevision, PAGE_SIZE);
      if (id !== this.requestId) {
        return;
      }
      const known = new Set(this.entries.map(entry => entry.revision));
      this.entries.push(...page.entries.filter(entry => !known.has(entry.revision)));
      this.nextRevision = page.nextRevision;
      this.hasMore = page.hasMore && page.nextRevision !== undefined;
    } catch (error) {
      if (id === this.requestId) {
        void vscode.window.showErrorMessage(`加载更多 SVN 文件日志失败：${errorMessage(error)}`);
      }
    } finally {
      if (id === this.requestId) {
        this.loading = false;
        this.emitter.fire(undefined);
        this.updateMessage();
      }
    }
  }

  private updateMessage(): void {
    if (!this.view) {
      return;
    }
    this.view.description = this.target ? path.basename(this.target.fsPath) : undefined;
    if (!this.target) {
      this.view.message = '打开一个 SVN 版本管理中的文件以查看其提交记录。';
    } else if (this.loading && this.entries.length === 0) {
      this.view.message = `正在加载 ${path.basename(this.target.fsPath)} 的提交记录…`;
    } else if (this.errorText) {
      this.view.message = this.errorText;
    } else if (!this.stale && this.entries.length === 0) {
      this.view.message = '该文件没有 SVN 提交记录。';
    } else {
      this.view.message = undefined;
    }
  }

  private async openFullLog(): Promise<void> {
    if (!this.target) {
      void vscode.window.showInformationMessage('请先打开一个 SVN 版本管理中的文件。');
      return;
    }
    await vscode.commands.executeCommand('svn.log', this.target);
  }

  /** 在多文件 Diff 编辑器中显示该提交修改的全部文件。 */
  private async openCommitChanges(commit: CommitNode | undefined): Promise<void> {
    const root = this.requireRepositoryRoot();
    if (!commit || !root) {
      return;
    }
    const revision = commit.entry.revision;
    const files = sortChangedPaths(commit.entry.changedPaths).filter(changed => changed.kind !== 'dir');
    if (files.length === 0) {
      void vscode.window.showInformationMessage(`r${revision} 没有修改文件内容（仅目录或属性变更）。`);
      return;
    }
    const resources = files.map(changed => {
      const { before, after } = changedPathDiff(root, revision, changed);
      return [changed.action === 'D' ? before : after, before, after] as const;
    });
    await vscode.commands.executeCommand('vscode.changes',
      `r${revision}：${firstLine(commit.entry.message)}`, resources);
  }

  private async openFileDiff(node: ChangedPathNode | undefined): Promise<void> {
    const root = this.requireRepositoryRoot();
    if (!node || !root || node.changed.kind === 'dir') {
      return;
    }
    const { before, after, title } = changedPathDiff(root, node.commit.entry.revision, node.changed);
    await vscode.commands.executeCommand('vscode.diff', before, after, title, { preview: true });
  }

  private requireRepositoryRoot(): string | undefined {
    if (!this.repositoryRoot) {
      void vscode.window.showWarningMessage('无法读取该文件的 SVN 仓库信息，请刷新文件日志后重试。');
    }
    return this.repositoryRoot;
  }

  private async compareWorking(commit: CommitNode | undefined): Promise<void> {
    if (!commit) {
      return;
    }
    const file = commit.file;
    await vscode.commands.executeCommand('vscode.diff', revisionUri(file, commit.entry.revision), file,
      `${path.basename(file.fsPath)}（r${commit.entry.revision} ↔ 工作副本）`);
  }

  private async openRevision(commit: CommitNode | undefined): Promise<void> {
    if (!commit) {
      return;
    }
    await vscode.window.showTextDocument(revisionUri(commit.file, commit.entry.revision), { preview: false });
  }

  private async copy(commit: CommitNode | undefined, text: (commit: CommitNode) => string): Promise<void> {
    if (commit) {
      await vscode.env.clipboard.writeText(text(commit));
    }
  }

  /** svn update -r REV：把该文件更新到所选修订。 */
  private async updateToRevision(commit: CommitNode | undefined): Promise<void> {
    if (!commit) {
      return;
    }
    const revision = commit.entry.revision;
    const choice = await vscode.window.showWarningMessage(
      `是否将“${path.basename(commit.file.fsPath)}”更新到 r${revision}？该文件的本地修改会保留，可能产生冲突。`,
      { modal: true }, '更新到此版本');
    if (choice !== '更新到此版本') {
      return;
    }
    await this.runOperation(`更新到 r${revision}`, () =>
      updateSvnToRevision(commit.file.fsPath, revision));
  }

  /** svn merge -r BASE:REV：把文件内容退回到所选修订，结果作为本地修改保留。 */
  private async revertToRevision(commit: CommitNode | undefined): Promise<void> {
    const url = this.requireTargetUrl();
    if (!commit || !url) {
      return;
    }
    const revision = commit.entry.revision;
    const from = this.baseRevision ?? revision;
    const choice = await vscode.window.showWarningMessage(
      `是否把“${path.basename(commit.file.fsPath)}”的内容退回到 r${revision}？` +
      `将以本地修改的形式保留，不会自动提交。`,
      { modal: true }, '回退到此版本');
    if (choice !== '回退到此版本') {
      return;
    }
    await this.runOperation(`回退到 r${revision}`, () =>
      reverseMergeSvn(commit.file.fsPath, url, from, { from, to: revision }));
  }

  /** svn merge -c -REV：撤销该次提交对这个文件的修改，结果作为本地修改保留。 */
  private async revertChangesFromRevision(commit: CommitNode | undefined): Promise<void> {
    const url = this.requireTargetUrl();
    if (!commit || !url) {
      return;
    }
    const revision = commit.entry.revision;
    const choice = await vscode.window.showWarningMessage(
      `是否撤销 r${revision} 对“${path.basename(commit.file.fsPath)}”的修改？` +
      `将以本地修改的形式保留，不会自动提交。`,
      { modal: true }, '回退该版本的修改');
    if (choice !== '回退该版本的修改') {
      return;
    }
    await this.runOperation(`撤销 r${revision} 的修改`, () =>
      reverseMergeSvn(commit.file.fsPath, url, revision, { change: revision }));
  }

  /**
   * 把该次提交的改动合并到用户选择的目标目录对应的位置（其他分支的工作副本根目录、子目录，
   * 或包含嵌套工作副本的上层目录），用一次 svn merge -c REV 完成，并先 --dry-run 预演供用户确认。
   */
  private async mergeToBranch(commit: CommitNode | undefined): Promise<void> {
    if (!commit) {
      return;
    }
    const revision = commit.entry.revision;
    try {
      const sourceRoot = await findWorkingCopyRoot(commit.file.fsPath);
      if (!sourceRoot) {
        throw new Error('无法确定当前文件所在的 SVN 工作副本。');
      }
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(await this.defaultMergeDirectory(sourceRoot)),
        openLabel: '合并到此目录',
        title: `选择要合并 r${revision} 的目标目录（与源目录结构相同的其他分支目录）`
      });
      const selected = picked?.[0]?.fsPath;
      if (!selected) {
        return;
      }
      await this.state?.update(LAST_MERGE_DIRECTORY_KEY, selected);
      const plan = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `SVN：正在定位 r${revision} 的合并目标…` },
        () => this.resolveMergeTarget(commit, sourceRoot, selected));
      if (!plan) {
        return;
      }
      const changes = await this.dryRunMerge(plan, revision);
      if (!changes) {
        return;
      }

      const targetDirectory = plan.targetDirectory;
      const files = changes.filter(change => change.path !== '.');
      if (files.length === 0) {
        void vscode.window.showInformationMessage(
          `r${revision} 在“${plan.sourcePath}”下的改动已存在于“${targetDirectory}”，或没有可合并的内容。`);
        return;
      }
      const conflicts = files.filter(change => change.conflicted);
      const MAX_LISTED = 30;
      const listed = files.slice(0, MAX_LISTED)
        .map(change => `${change.conflicted ? '⚠ ' : ''}${change.status.trim()}  ${change.path}`);
      if (files.length > MAX_LISTED) {
        listed.push(`…以及另外 ${files.length - MAX_LISTED} 个文件`);
      }
      const detail = [
        `源：${plan.sourceUrl}@${revision}`,
        `目标：${targetDirectory}`,
        ...(pathKey(targetDirectory) !== pathKey(selected) ? [`（由所选目录“${selected}”按目录结构定位）`] : []),
        '',
        ...listed,
        '',
        conflicts.length > 0
          ? `预计有 ${conflicts.length} 个文件冲突，合并后需手动解决。`
          : '预演未发现冲突。',
        '合并结果将作为本地修改保留在目标工作副本中，不会自动提交。'
      ].join('\n');
      const action = conflicts.length > 0 ? '仍然合并' : '合并';
      const choice = await vscode.window.showWarningMessage(
        `是否把 r${revision} 的 ${files.length} 个文件改动合并到目标目录？`,
        { modal: true, detail }, action);
      if (choice !== action) {
        return;
      }
      await this.runOperation(`合并 r${revision} 到 ${path.basename(targetDirectory)}`,
        () => mergeSvnRevision(targetDirectory, plan.sourceUrl, revision, false),
        output => {
          const conflicted = parseSvnMergeOutput(output).filter(change => change.conflicted);
          if (conflicted.length > 0) {
            void vscode.window.showWarningMessage(
              `SVN：r${revision} 已合并到 ${targetDirectory}，但有 ${conflicted.length} 个文件冲突，请在“冲突文件列表”中处理。`);
          } else {
            void vscode.window.showInformationMessage(
              `SVN：r${revision} 已合并到 ${targetDirectory}，请检查后提交。`);
          }
        });
    } catch (error) {
      void vscode.window.showErrorMessage(`SVN：合并 r${revision} 失败。${mergeErrorMessage(error)}`);
    }
  }

  /** 目录选择窗口的初始位置：上次选择且仍存在的目录，否则为源工作副本的上一级目录。 */
  private async defaultMergeDirectory(sourceRoot: string): Promise<string> {
    const last = this.state?.get<string>(LAST_MERGE_DIRECTORY_KEY);
    if (last) {
      try {
        if ((await fs.stat(last)).isDirectory()) {
          return last;
        }
      } catch {
        // 上次的目录已不存在，回退到默认位置。
      }
    }
    return path.dirname(sourceRoot);
  }

  /** 预演合并；目标是混合修订工作副本时，询问是否先更新目标目录再重试。 */
  private async dryRunMerge(plan: MergePlan, revision: number): Promise<SvnMergeChange[] | undefined> {
    const run = () => vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `SVN：正在预演合并 r${revision}…` },
      () => mergeSvnRevision(plan.targetDirectory, plan.sourceUrl, revision, true));
    try {
      return parseSvnMergeOutput(await run());
    } catch (error) {
      if (!/E195020|mixed-revision/i.test(errorMessage(error))) {
        throw error;
      }
      const choice = await vscode.window.showWarningMessage(
        `目标目录包含多个修订版本，svn 要求先更新后才能合并。是否现在更新“${plan.targetDirectory}”？`,
        { modal: true, detail: errorMessage(error) }, '更新并继续');
      if (choice !== '更新并继续') {
        return undefined;
      }
      const output = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `SVN：正在更新 ${plan.targetDirectory}…` },
        () => updateSvnWorkingCopy(plan.targetDirectory));
      const updateConflicts = parseSvnMergeOutput(output).filter(change => change.conflicted);
      if (updateConflicts.length > 0) {
        throw new Error(`更新目标目录时产生 ${updateConflicts.length} 个冲突，请先处理冲突后再合并。`);
      }
      void vscode.commands.executeCommand('svn.refresh');
      return parseSvnMergeOutput(await run());
    }
  }

  /**
   * 确定合并的源路径与目标目录：
   * 1. 按本地目录结构对应：在所选目录下按“源文件目录相对其某个上层目录”的相对路径找到对应目录，
   *    以两者仓库路径的公共后缀推出分支映射（如 /trunk → /branches/V120）。所选目录是包含嵌套工作副本的
   *    上层目录时，自动定位到与源工作副本对应的嵌套工作副本。
   * 2. 退回到“所选目录在其工作副本中的相对位置”映射，同样校验分支映射。
   */
  private async resolveMergeTarget(
    commit: CommitNode, sourceRoot: string, selected: string
  ): Promise<MergePlan | undefined> {
    const revision = commit.entry.revision;
    const fileDirectory = path.dirname(commit.file.fsPath);
    const [sourceInfo, fileDirectoryInfo] = await Promise.all([
      getSvnTargetInfo(sourceRoot), getSvnTargetInfo(fileDirectory)
    ]);
    const sourceRootPath = repositoryPathOf(sourceInfo.url, sourceInfo.repositoryRoot);
    const fileDirectoryPath = repositoryPathOf(fileDirectoryInfo.url, fileDirectoryInfo.repositoryRoot);
    if (sourceRootPath === undefined || fileDirectoryPath === undefined) {
      throw new Error('无法解析源工作副本对应的仓库路径。');
    }
    const sameRepository = (info: { repositoryUuid?: string }) =>
      !sourceInfo.repositoryUuid || !info.repositoryUuid || info.repositoryUuid === sourceInfo.repositoryUuid;

    let resolved: { targetDirectory: string; sourcePath: string } | undefined;
    let sameLocation = false;

    // 策略 1：按本地目录结构定位。
    const candidates = await Promise.all(ancestorsOf(fileDirectory).map(async anchor => {
      const counterpart = path.join(selected, path.relative(anchor, fileDirectory));
      const info = await directoryInfo(counterpart);
      if (!info || !sameRepository(info)) {
        return undefined;
      }
      const counterpartPath = repositoryPathOf(info.url, info.repositoryRoot);
      const mapping = counterpartPath === undefined ? undefined : branchMapping(fileDirectoryPath, counterpartPath);
      return mapping ? { anchor, mapping } : undefined;
    }));
    const best = candidates
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
      .sort((left, right) => right.mapping.common - left.mapping.common)[0];
    if (best?.mapping.same) {
      sameLocation = true;
    } else if (best) {
      const anchorContainsSource = isInsideDirectory(best.anchor, sourceRoot);
      const targetDirectory = anchorContainsSource
        ? path.join(selected, path.relative(best.anchor, sourceRoot))
        : selected;
      const sourcePath = anchorContainsSource
        ? sourceRootPath
        : path.posix.join(sourceRootPath, toPosix(path.relative(sourceRoot, best.anchor)));
      const info = await directoryInfo(targetDirectory);
      const { sourcePrefix, targetPrefix } = best.mapping;
      const mapped = sourcePrefix === '' || sourcePath === sourcePrefix || sourcePath.startsWith(`${sourcePrefix}/`);
      const expected = mapped ? targetPrefix + sourcePath.slice(sourcePrefix.length) || '/' : undefined;
      if (!info || !expected || repositoryPathOf(info.url, info.repositoryRoot) !== expected) {
        throw new Error(`按目录结构定位到“${targetDirectory}”，但它对应的仓库路径与源“${sourcePath}”不对应，` +
          '两个目录的工作副本结构不一致，请直接选择与源工作副本对应的目录。');
      }
      resolved = { targetDirectory, sourcePath };
    }

    // 策略 2：所选目录在其工作副本中的相对位置。
    if (!resolved && !sameLocation) {
      const selectedInfo = await directoryInfo(selected);
      const targetRoot = selectedInfo && sameRepository(selectedInfo)
        ? await findWorkingCopyRoot(selected).catch(() => undefined)
        : undefined;
      const selectedPath = selectedInfo ? repositoryPathOf(selectedInfo.url, selectedInfo.repositoryRoot) : undefined;
      if (targetRoot && selectedPath !== undefined) {
        const sourcePath = path.posix.join(sourceRootPath, toPosix(path.relative(targetRoot, selected)));
        const mapping = branchMapping(sourcePath, selectedPath);
        if (mapping?.same) {
          sameLocation = true;
        } else if (mapping) {
          resolved = { targetDirectory: selected, sourcePath };
        }
      }
    }

    if (sameLocation) {
      void vscode.window.showInformationMessage(`所选目录就是 r${revision} 的来源位置，无需合并。`);
      return undefined;
    }
    if (!resolved) {
      throw new Error(`无法确定“${selected}”与源工作副本“${sourceRoot}”的对应关系。` +
        '请选择与源目录结构相同的分支目录（其下应能找到与当前文件相同相对路径的目录）。');
    }

    const { targetDirectory, sourcePath } = resolved;
    const prefix = sourcePath === '/' ? '/' : `${sourcePath}/`;
    if (!commit.entry.changedPaths.some(changed => changed.path === sourcePath || changed.path.startsWith(prefix))) {
      void vscode.window.showInformationMessage(`r${revision} 在“${sourcePath}”下没有改动，无需合并到“${targetDirectory}”。`);
      return undefined;
    }
    const targetInfo = await getSvnTargetInfo(targetDirectory);
    // 用目标仓库的根地址拼接，避免同一仓库因访问地址不同（不同域名、http/https）被当成外部仓库。
    const sourceUrl = sourcePath === '/'
      ? targetInfo.repositoryRoot.replace(/\/+$/, '')
      : repositoryUrl(targetInfo.repositoryRoot, sourcePath);
    return { sourceUrl, sourcePath, targetDirectory };
  }

  private async runOperation(
    label: string, operation: () => Promise<string>, report?: (output: string) => void
  ): Promise<void> {
    try {
      const output = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: `SVN：${label}` },
        operation);
      if (report) {
        report(output);
      } else {
        void vscode.window.showInformationMessage(`SVN：${label} 已完成。`);
      }
      this.invalidate();
      await vscode.commands.executeCommand('svn.refresh');
    } catch (error) {
      void vscode.window.showErrorMessage(`SVN：${label} 失败。${mergeErrorMessage(error)}`);
    }
  }

  private requireTargetUrl(): string | undefined {
    if (!this.targetUrl) {
      void vscode.window.showWarningMessage('无法读取该文件的 SVN 仓库地址，请刷新文件日志后重试。');
    }
    return this.targetUrl;
  }
}

class CommitNode extends vscode.TreeItem {
  constructor(
    readonly file: vscode.Uri,
    readonly entry: SvnLogEntry,
    baseRevision: number | undefined,
    graph: { above: boolean; below: boolean; expanded: boolean },
    marks: { current: boolean; latest: boolean }
  ) {
    super(firstLine(entry.message), vscode.TreeItemCollapsibleState.None);
    const date = new Date(entry.date);
    const validDate = !Number.isNaN(date.getTime());
    const newer = baseRevision !== undefined && entry.revision > baseRevision;
    this.id = `${pathKey(file.fsPath)}#${entry.revision}`;
    this.contextValue = 'svn.fileHistoryCommit';
    this.description = [
      marks.latest ? '最新' : undefined,
      marks.current ? '当前' : undefined,
      `r${entry.revision}`,
      entry.author || '（未知作者）',
      validDate ? relativeTime(date) : entry.date,
      newer ? '未更新' : undefined
    ].filter(Boolean).join(' · ');
    if (marks.current || marks.latest) {
      // 仅用于让 ChangedPathDecorations 为标题着色；图标已显式指定，不会显示文件图标。
      this.resourceUri = vscode.Uri.from({
        scheme: COMMIT_MARK_SCHEME,
        path: `/r${entry.revision}`,
        query: new URLSearchParams({ mark: marks.current ? 'current' : newer ? 'newer' : 'latest' }).toString()
      });
    }
    this.iconPath = graphIcon({ kind: 'commit', ...graph, newer, current: marks.current });
    this.tooltip = commitTooltip(entry, date, validDate, newer, marks);
    if (entry.changedPaths.length > 0) {
      this.command = {
        command: 'svn.fileHistory.toggle',
        title: graph.expanded ? '收起变更文件' : '展开变更文件',
        arguments: [this]
      };
    }
  }
}

class ChangedPathNode extends vscode.TreeItem {
  constructor(
    readonly commit: CommitNode,
    readonly changed: SvnLogChangedPath,
    isTarget: boolean,
    lastRow: boolean
  ) {
    const resourceUri = vscode.Uri.from({
      scheme: CHANGED_PATH_SCHEME,
      path: changed.path.startsWith('/') ? changed.path : `/${changed.path}`,
      query: new URLSearchParams({ action: changed.action, revision: String(commit.entry.revision) }).toString()
    });
    super(resourceUri, vscode.TreeItemCollapsibleState.None);
    const directory = path.posix.dirname(changed.path).replace(/^\/+/, '');
    this.id = `${commit.id}:${changed.path}`;
    this.contextValue = changed.kind === 'dir' ? 'svn.fileHistoryDir' : 'svn.fileHistoryFile';
    this.description = [
      changed.kind === 'dir' ? '目录' : undefined,
      directory,
      isTarget ? '当前文件' : undefined
    ].filter(Boolean).join(' · ');
    this.iconPath = graphIcon({ kind: 'file', last: lastRow });
    const copyFrom = changed.copyFromPath ? `\n复制自 ${changed.copyFromPath}@${changed.copyFromRevision}` : '';
    this.tooltip = `${actionLabel(changed.action)}：${changed.path}${copyFrom}`;
    this.command = changed.kind === 'dir'
      ? undefined
      : { command: 'svn.fileHistory.openFileDiff', title: '打开更改', arguments: [this] };
  }
}

/** 为提交下的变更路径显示 A/M/D/R 徽标与颜色，并为“当前”“最新”提交的标题着色。 */
class ChangedPathDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === COMMIT_MARK_SCHEME) {
      const mark = new URLSearchParams(uri.query).get('mark');
      const color = {
        current: 'gitDecoration.addedResourceForeground',
        newer: 'gitDecoration.modifiedResourceForeground',
        latest: 'textLink.foreground'
      }[mark ?? ''];
      return color ? new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor(color)) : undefined;
    }
    if (uri.scheme !== CHANGED_PATH_SCHEME) {
      return undefined;
    }
    const action = new URLSearchParams(uri.query).get('action') ?? '';
    const color = {
      A: 'gitDecoration.addedResourceForeground',
      D: 'gitDecoration.deletedResourceForeground',
      M: 'gitDecoration.modifiedResourceForeground',
      R: 'gitDecoration.renamedResourceForeground'
    }[action];
    return new vscode.FileDecoration(action || undefined, actionLabel(action),
      color ? new vscode.ThemeColor(color) : undefined);
  }
}

class LoadMoreNode extends vscode.TreeItem {
  constructor(loading: boolean) {
    super(loading ? '正在加载…' : '加载更多…', vscode.TreeItemCollapsibleState.None);
    this.id = 'svn.fileHistory.loadMore';
    this.iconPath = loading ? new vscode.ThemeIcon('loading~spin') : graphIcon({ kind: 'more' });
    this.command = loading
      ? undefined
      : { command: 'svn.fileHistory.loadMore', title: '加载更多' };
  }
}

type GraphIcon =
  | { kind: 'commit'; above: boolean; below: boolean; expanded: boolean; newer: boolean; current: boolean }
  | { kind: 'file'; last: boolean }
  | { kind: 'more' };

type GraphPalette = { line: string; commit: string; newer: string; current: string };

const GRAPH_PALETTE: { dark: GraphPalette; light: GraphPalette } = {
  dark: { line: '#6e7681', commit: '#3794ff', newer: '#cca700', current: '#3fb950' },
  light: { line: '#8c959f', commit: '#0969da', newer: '#bf8803', current: '#1a7f37' }
};
const graphIconCache = new Map<string, { light: vscode.Uri; dark: vscode.Uri }>();

/**
 * 生成 16×22 的提交线 SVG（与列表行等高），使相邻行的竖线首尾相接形成连续的时间线。
 * 提交为圆点：展开时实心、收起时空心；“当前”提交为绿色并带外环；变更文件为从竖线引出的分支。
 */
function graphIcon(icon: GraphIcon): { light: vscode.Uri; dark: vscode.Uri } {
  const key = JSON.stringify(icon);
  let cached = graphIconCache.get(key);
  if (!cached) {
    cached = { light: svgUri(graphSvg(icon, GRAPH_PALETTE.light)), dark: svgUri(graphSvg(icon, GRAPH_PALETTE.dark)) };
    graphIconCache.set(key, cached);
  }
  return cached;
}

function graphSvg(icon: GraphIcon, palette: GraphPalette): string {
  const line = (y1: number, y2: number, extra = '') =>
    `<line x1="8" y1="${y1}" x2="8" y2="${y2}" stroke="${palette.line}" stroke-width="1.5"${extra}/>`;
  let body: string;
  if (icon.kind === 'commit') {
    const color = icon.current ? palette.current : icon.newer ? palette.newer : palette.commit;
    const gap = icon.current ? 6.5 : 4.5;
    body = (icon.above ? line(0, 11 - gap) : '') + (icon.below ? line(11 + gap, 22) : '') +
      (icon.current ? `<circle cx="8" cy="11" r="6" stroke="${color}" stroke-width="1" fill="none" opacity="0.7"/>` : '') +
      `<circle cx="8" cy="11" r="3.5" stroke="${color}" stroke-width="2" fill="${icon.expanded ? color : 'none'}"/>`;
  } else if (icon.kind === 'file') {
    body = line(0, icon.last ? 11.75 : 22) +
      `<path d="M8 11 H13.5" stroke="${palette.line}" stroke-width="1.5" fill="none"/>`;
  } else {
    body = line(0, 14, ' stroke-dasharray="2 2"');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="22" viewBox="0 0 16 22">${body}</svg>`;
}

function svgUri(svg: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);
}

function commitTooltip(
  entry: SvnLogEntry, date: Date, validDate: boolean, newer: boolean,
  marks: { current: boolean; latest: boolean }
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString('', true);
  tooltip.appendMarkdown(`$(git-commit) **r${entry.revision}**`);
  tooltip.appendText(`  ${entry.author || '（未知作者）'}`);
  tooltip.appendMarkdown('\n\n$(clock) ');
  tooltip.appendText(validDate ? `${date.toLocaleString()}（${relativeTime(date)}）` : entry.date);
  if (marks.latest) {
    tooltip.appendMarkdown('\n\n$(star-full) **最新**：该文件在仓库中的最新提交');
  }
  if (marks.current) {
    tooltip.appendMarkdown('\n\n$(pass-filled) **当前**：工作副本中该文件所在的提交');
  }
  if (newer) {
    tooltip.appendMarkdown('\n\n$(cloud-download) 该提交晚于工作副本版本，尚未更新到本地');
  }
  tooltip.appendMarkdown('\n\n---\n\n');
  tooltip.appendText(entry.message.trim() || '（无提交信息）');
  if (entry.changedPaths.length > 0) {
    tooltip.appendMarkdown(`\n\n---\n\n$(files) ${entry.changedPaths.length} 个变更路径，点击提交展开查看`);
  }
  return tooltip;
}

function sortChangedPaths(paths: readonly SvnLogChangedPath[]): SvnLogChangedPath[] {
  return [...paths].sort((left, right) => left.path.localeCompare(right.path));
}

function actionLabel(action: string): string {
  return { A: '新增', D: '删除', M: '修改', R: '替换' }[action] ?? action;
}

/** 把仓库 URL 转成以 / 开头的仓库内路径，与 svn log 的变更路径格式一致。 */
function repositoryPathOf(url: string, repositoryRoot: string): string | undefined {
  const root = repositoryRoot.replace(/\/+$/, '');
  if (url.replace(/\/+$/, '') === root) {
    return '/';
  }
  if (!url.startsWith(`${root}/`)) {
    return undefined;
  }
  try {
    return decodeURIComponent(url.slice(root.length));
  } catch {
    return undefined;
  }
}

function asCommit(value: unknown): CommitNode | undefined {
  return value instanceof CommitNode ? value : undefined;
}

function localFileUri(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme === 'file') {
    return uri;
  }
  if (!['svn-base', 'svn-working', 'svn-revision'].includes(uri.scheme)) {
    return undefined;
  }
  const filePath = new URLSearchParams(uri.query).get('path');
  return filePath && path.isAbsolute(filePath) ? vscode.Uri.file(filePath) : undefined;
}

function revisionUri(file: vscode.Uri, revision: number): vscode.Uri {
  const query = new URLSearchParams({ path: file.fsPath, revision: String(revision) });
  return file.with({ scheme: 'svn-revision', query: query.toString() });
}

function firstLine(message: string): string {
  return message.trim().split(/\r?\n/, 1)[0] || '（无提交信息）';
}

function relativeTime(date: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) {
    return '刚刚';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} 天前`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} 个月前`;
  }
  return `${Math.floor(days / 365)} 年前`;
}

function friendlyError(error: unknown): string {
  const message = errorMessage(error);
  if (/not a working copy|not under version control|E155007|E155010|W155010/i.test(message)) {
    return '该文件不在 SVN 版本管理中，没有可显示的提交记录。';
  }
  return `无法读取 SVN 文件日志：${message}`;
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type MergePlan = { sourceUrl: string; sourcePath: string; targetDirectory: string };

type BranchMapping = { same: boolean; common: number; sourcePrefix: string; targetPrefix: string };

/**
 * 比较两个仓库路径的公共后缀，推出分支映射：
 * /trunk/Sources/Content/X 与 /branches/V120/Sources/Content/X → /trunk ↔ /branches/V120。
 * 两路径完全相同时 same 为 true；没有公共后缀时返回 undefined。
 */
function branchMapping(sourcePath: string, targetPath: string): BranchMapping | undefined {
  const source = sourcePath.split('/').filter(Boolean);
  const target = targetPath.split('/').filter(Boolean);
  let common = 0;
  while (common < source.length && common < target.length &&
         source[source.length - 1 - common] === target[target.length - 1 - common]) {
    common++;
  }
  const join = (segments: string[]) => segments.length > 0 ? `/${segments.join('/')}` : '';
  const sourcePrefix = join(source.slice(0, source.length - common));
  const targetPrefix = join(target.slice(0, target.length - common));
  if (sourcePrefix === targetPrefix) {
    return { same: true, common, sourcePrefix, targetPrefix };
  }
  return common > 0 ? { same: false, common, sourcePrefix, targetPrefix } : undefined;
}

function ancestorsOf(directory: string): string[] {
  const result: string[] = [];
  let current = path.resolve(directory);
  for (;;) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return result;
    }
    current = parent;
  }
}

/** 目录存在且受 SVN 版本管理时返回其信息，否则返回 undefined。 */
async function directoryInfo(directory: string): Promise<Awaited<ReturnType<typeof getSvnTargetInfo>> | undefined> {
  try {
    if (!(await fs.stat(directory)).isDirectory()) {
      return undefined;
    }
    const info = await getSvnTargetInfo(directory);
    return info.kind === 'dir' ? info : undefined;
  } catch {
    return undefined;
  }
}

function isInsideDirectory(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toPosix(relative: string): string {
  return relative.split(path.sep).filter(Boolean).join('/');
}

/** 为常见的合并/更新错误补充处理建议。 */
function mergeErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (/E195020|mixed-revision/i.test(message)) {
    return `${message}\n目标工作副本包含多个修订版本，请先对目标目录执行“更新”后再合并。`;
  }
  if (/E155015/.test(message)) {
    return `${message}\n目标工作副本存在未解决的冲突，请先处理后再合并。`;
  }
  return message;
}
