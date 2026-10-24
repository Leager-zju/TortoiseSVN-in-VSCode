import * as path from 'node:path';
import * as vscode from 'vscode';
import { changedPathDiff } from './logView';
import { getSvnLog, getSvnTargetInfo, SvnLogChangedPath, SvnLogEntry } from './svn';

const FILE_HISTORY_VIEW_ID = 'svn.fileHistoryView';
const CHANGED_PATH_SCHEME = 'svn-history-path';
const COMMIT_MARK_SCHEME = 'svn-history-commit';
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
  private target: vscode.Uri | undefined;
  private entries: SvnLogEntry[] = [];
  private readonly expanded = new Set<number>();
  private baseRevision: number | undefined;
  private repositoryRoot: string | undefined;
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

  /** 注册视图命令并开始跟随活动编辑器。 */
  start(): void {
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
