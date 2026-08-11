import {randomBytes} from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {getRevisionDiff, getSvnLog, getSvnTargetInfo, SvnLogEntry, SvnTargetInfo} from './svn';

const PAGE_SIZE = 100;

export class SvnLogViewer implements vscode.Disposable {
  private readonly panels = new Map<string, SvnLogPanel>();

  show(targetUri: vscode.Uri): void {
    const key = pathKey(targetUri.fsPath);
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    const panel = new SvnLogPanel(targetUri, () => this.panels.delete(key));
    this.panels.set(key, panel);
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }
}

class SvnLogPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private entries: SvnLogEntry[] = [];
  private targetInfo: SvnTargetInfo|undefined;
  private nextRevision: number|undefined;
  private hasMore = true;
  private loading = false;
  private disposed = false;

  constructor(
      private readonly targetUri: vscode.Uri,
      private readonly onDispose: () => void) {
    this.panel = vscode.window.createWebviewPanel(
        'svnLog', `SVN 日志：${path.basename(targetUri.fsPath)}`,
        vscode.ViewColumn.Active,
        {enableScripts: true, retainContextWhenHidden: true});
    this.disposables.push(
        this.panel.onDidDispose(() => this.dispose()),
        this.panel.webview.onDidReceiveMessage(
            message => void this.handleMessage(message)));
    this.panel.webview.html = logHtml(this.panel.webview);
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.panel.dispose();
    this.onDispose();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || !('command' in message)) {
      return;
    }
    const value = message as {
      command: string;
      revisions?: number[];
      revision?: number;
      changedPath?: string;
      text?: string
    };
    try {
      switch (value.command) {
        case 'ready':
        case 'refresh':
          await this.load(true, false);
          break;
        case 'loadMore':
          await this.load(false, false);
          break;
        case 'loadAll':
          await this.load(false, true);
          break;
        case 'openRevision':
          await this.openRevision(value.revision);
          break;
        case 'comparePrevious':
          await this.comparePrevious(value.revision);
          break;
        case 'compareSelected':
          await this.compareSelected(value.revisions);
          break;
        case 'compareWorking':
          await this.compareWorking(value.revision);
          break;
        case 'showChanges':
          await this.showChanges(value.revision);
          break;
        case 'openFileDiff':
          await this.openFileDiff(value.revision, value.changedPath);
          break;
        case 'openWorking':
          if (this.targetInfo?.kind === 'dir') {
            await vscode.commands.executeCommand(
                'revealInExplorer', this.targetUri);
          } else {
            await vscode.window.showTextDocument(
                this.targetUri, {preview: false});
          }
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(value.text ?? '');
          break;
      }
    } catch (error) {
      this.post({type: 'error', message: errorMessage(error)});
    }
  }

  private async load(reset: boolean, loadAll: boolean): Promise<void> {
    if (this.loading || (!reset && !this.hasMore)) {
      return;
    }
    this.loading = true;
    if (reset) {
      this.entries = [];
      this.nextRevision = undefined;
      this.hasMore = true;
      this.targetInfo = undefined;
    }
    this.postState();

    try {
      if (!this.targetInfo) {
        this.targetInfo = await getSvnTargetInfo(this.targetUri.fsPath);
      }
      do {
        const page = await getSvnLog(
            this.targetUri.fsPath, this.nextRevision, PAGE_SIZE);
        const revisions = new Set(this.entries.map(entry => entry.revision));
        for (const entry of page.entries) {
          if (!revisions.has(entry.revision)) {
            this.entries.push(entry);
            revisions.add(entry.revision);
          }
        }
        this.entries.sort((left, right) => right.revision - left.revision);
        this.nextRevision = page.nextRevision;
        this.hasMore = page.hasMore && page.nextRevision !== undefined;
        this.postState();
      } while (loadAll && this.hasMore && !this.disposed);
    } finally {
      this.loading = false;
      this.postState();
    }
  }

  private async openRevision(revision: number|undefined): Promise<void> {
    if (!revision || !this.ensureFileTarget()) {
      return;
    }
    await vscode.window.showTextDocument(
        revisionUri(this.targetUri, revision), {preview: false});
  }

  private async comparePrevious(revision: number|undefined): Promise<void> {
    if (!revision || !this.ensureFileTarget()) {
      return;
    }
    const index = this.entries.findIndex(entry => entry.revision === revision);
    const previous = index >= 0 ? this.entries[index + 1] : undefined;
    if (!previous) {
      void vscode.window.showInformationMessage(
          '当前已加载记录中没有更早的文件修订，请先加载更多日志。');
      return;
    }
    await this.openDiff(previous.revision, revision);
  }

  private async compareSelected(revisions: number[]|undefined): Promise<void> {
    if (!this.ensureFileTarget()) {
      return;
    }
    const selected =
        [...new Set(revisions ?? [])].sort((left, right) => left - right);
    if (selected.length !== 2) {
      void vscode.window.showInformationMessage('请选择两条日志记录进行比较。');
      return;
    }
    await this.openDiff(selected[0], selected[1]);
  }

  private async compareWorking(revision: number|undefined): Promise<void> {
    if (!revision || !this.ensureFileTarget()) {
      return;
    }
    await vscode.commands.executeCommand(
        'vscode.diff', revisionUri(this.targetUri, revision), this.targetUri,
        `${path.basename(this.targetUri.fsPath)}（r${revision} ↔ 工作副本）`);
  }

  private ensureFileTarget(): boolean {
    if (this.targetInfo?.kind === 'file') {
      return true;
    }
    void vscode.window.showInformationMessage(
        '目录日志支持查看提交和变更路径，但不支持以文本方式打开或比较修订。');
    return false;
  }

  private async openDiff(fromRevision: number, toRevision: number):
      Promise<void> {
    await vscode.commands.executeCommand(
        'vscode.diff', revisionUri(this.targetUri, fromRevision),
        revisionUri(this.targetUri, toRevision),
        `${path.basename(this.targetUri.fsPath)}（r${fromRevision} ↔ r${
            toRevision}）`);
  }

  private async showChanges(revision: number|undefined): Promise<void> {
    if (!revision) {
      return;
    }
    const content = await getRevisionDiff(this.targetUri.fsPath, revision);
    const document =
        await vscode.workspace.openTextDocument({language: 'diff', content});
    await vscode.window.showTextDocument(document, {preview: true});
  }

  private async openFileDiff(
      revision: number|undefined, changedPath: string|undefined): Promise<void> {
    if (!revision || !changedPath || !this.targetInfo) {
      return;
    }
    const entry = this.entries.find(item => item.revision === revision);
    const changed = entry?.changedPaths.find(item => item.path === changedPath);
    if (!changed || changed.kind === 'dir') {
      return;
    }

    const target = repositoryUrl(this.targetInfo.repositoryRoot, changed.path);
    const copyRevision = Number(changed.copyFromRevision);
    const hasCopySource = Boolean(
        changed.action === 'A' && changed.copyFromPath &&
        Number.isInteger(copyRevision) && copyRevision > 0);
    const beforeRevision = Math.max(1, revision - 1);
    const beforeTarget = hasCopySource ?
        repositoryUrl(this.targetInfo.repositoryRoot, changed.copyFromPath!) :
        target;
    const before = repositoryRevisionUri(
        beforeTarget, changed.path,
        hasCopySource ? copyRevision : beforeRevision,
        hasCopySource ? copyRevision :
            ['D', 'R'].includes(changed.action) ? beforeRevision : revision,
        changed.action === 'A' && !hasCopySource || revision === 1);
    const after = repositoryRevisionUri(
        target, changed.path, revision, revision, changed.action === 'D');
    const fileName = path.posix.basename(changed.path) || changed.path;
    await vscode.commands.executeCommand(
        'vscode.diff', before, after,
        `${fileName}（r${revision} ${changed.action}）`);
  }

  private postState(): void {
    this.post({
      type: 'state',
      target: this.targetUri.fsPath,
      info: this.targetInfo,
      entries: this.entries,
      hasMore: this.hasMore,
      loading: this.loading
    });
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }
}

function revisionUri(file: vscode.Uri, revision: number): vscode.Uri {
  return file.with({
    scheme: 'svn-revision',
    query: `path=${encodeURIComponent(file.fsPath)}&revision=${revision}`
  });
}

function repositoryRevisionUri(
    target: string, repositoryPath: string, revision: number,
    pegRevision: number, empty: boolean): vscode.Uri {
  const query = new URLSearchParams({
    path: target,
    revision: String(revision),
    pegRevision: String(pegRevision),
    empty: String(empty)
  });
  return vscode.Uri.from({
    scheme: 'svn-revision',
    path: `/${path.posix.basename(repositoryPath) || 'content'}`,
    query: query.toString()
  });
}

function repositoryUrl(root: string, repositoryPath: string): string {
  const encodedPath = repositoryPath.replace(/^\/+/, '').split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
  return `${root.replace(/\/$/, '')}/${encodedPath}`;
}

function pathKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${
      nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { width: 100%; max-width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); }
    button, input, select { font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 3px; padding: 5px 10px; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { opacity: .45; cursor: default; }
    input, select { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 5px 7px; outline: none; }
    input:focus, select:focus { border-color: var(--vscode-focusBorder); }
    .page { width: 100%; max-width: 100%; min-width: 0; height: 100%; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; }
    .toolbar { width: 100%; max-width: 100%; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .version-overview { min-width: 0; margin-left: auto; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); }
    .version-pill { padding: 3px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 10px; white-space: nowrap; }
    .version-pill.latest { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .version-pill.current { color: var(--vscode-textLink-foreground); }
    .version-gap { white-space: nowrap; font-weight: 600; }
    .filters { width: 100%; max-width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .8fr) minmax(90px, .45fr) auto; align-items: end; gap: 8px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .filter-field { min-width: 0; display: grid; gap: 4px; }
    .filter-field label { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 16px; }
    .filter-field input, .filter-field select { width: 100%; min-width: 0; }
    .search-field, .period-field, .author-field { min-width: 0; }
    .filters > button { width: 88px; min-width: 88px; white-space: nowrap; }
    .date-range { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 6px; }
    .date-range span { color: var(--vscode-descriptionForeground); text-align: center; }
    .content, #log-container, #log-inner { width: 100%; max-width: 100%; min-width: 0; min-height: 0; }
    .content { overflow: hidden; }
    #log-container { height: 100%; overflow: auto; background: var(--vscode-editor-background); scrollbar-gutter: stable; }
    #log-inner { position: relative; }
    .log-row { width: 100%; min-width: 0; display: grid; grid-template-columns: 42px minmax(62px, .55fr) minmax(72px, 1fr) minmax(124px, 1.25fr) minmax(160px, 3fr); align-items: stretch; cursor: pointer; }
    .log-header { position: sticky; top: 0; z-index: 5; cursor: default; background: var(--vscode-editorGroupHeader-tabsBackground); }
    .log-cell { min-width: 0; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .log-header .log-cell { font-weight: 600; }
    .graph-cell { position: relative; padding: 0; overflow: visible; }
    .commit-item .graph-cell::before { content: ''; position: absolute; top: 0; bottom: 0; left: 20px; width: 2px; background: var(--vscode-panel-border); }
    .graph-node { position: absolute; z-index: 1; left: 15px; top: 50%; width: 12px; height: 12px; margin-top: -6px; border: 3px solid var(--vscode-textLink-foreground); border-radius: 50%; background: var(--vscode-editor-background); }
    .commit-item.latest .graph-node { border-color: var(--vscode-gitDecoration-addedResourceForeground); background: var(--vscode-gitDecoration-addedResourceForeground); }
    .commit-item.current .graph-node { border-color: var(--vscode-textLink-foreground); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-textLink-foreground) 25%, transparent); }
    .summary-message { display: flex; min-width: 0; align-items: center; gap: 6px; }
    .summary-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .row-chevron { flex: 0 0 auto; width: 14px; color: var(--vscode-descriptionForeground); }
    .row-badge { flex: 0 0 auto; padding: 1px 5px; border-radius: 8px; border: 1px solid currentColor; font-size: 11px; line-height: 15px; }
    .row-badge.latest { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .row-badge.current { color: var(--vscode-textLink-foreground); }
    .row-badge.pending { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .commit-item:hover > .log-row { background: var(--vscode-list-hoverBackground); }
    .commit-item.selected > .log-row { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .commit-details { margin-left: 42px; padding: 12px clamp(10px, 2vw, 22px) 16px; border-bottom: 1px solid var(--vscode-panel-border); border-left: 2px solid var(--vscode-textLink-foreground); background: var(--vscode-editor-inactiveSelectionBackground); }
    .details-head { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
    .message { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 14px; line-height: 1.5; user-select: text; }
    .changes-title { margin: 0 0 7px; font-weight: 600; }
    .change-tree { width: 100%; min-width: 0; border: 1px solid var(--vscode-panel-border); border-radius: 3px; overflow: hidden; background: var(--vscode-editor-background); }
    .tree-row { width: 100%; min-width: 0; min-height: 28px; display: flex; align-items: center; gap: 6px; padding: 3px 7px; border-bottom: 1px solid var(--vscode-panel-border); }
    .tree-row:last-child { border-bottom: 0; }
    .tree-indent { flex: 0 0 auto; }
    .tree-icon { flex: 0 0 16px; color: var(--vscode-descriptionForeground); text-align: center; }
    .tree-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button.tree-file { min-width: 0; flex: 1; display: flex; align-items: center; gap: 6px; padding: 2px 4px; color: var(--vscode-textLink-foreground); background: transparent; text-align: left; overflow: hidden; }
    button.tree-file:hover { color: var(--vscode-textLink-activeForeground); background: var(--vscode-list-hoverBackground); }
    .change-action { flex: 0 0 22px; font-weight: 700; text-align: center; }
    .change-action.A { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .change-action.M, .change-action.R { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .change-action.D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .copy-source { min-width: 0; max-width: 38%; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #log-container::-webkit-scrollbar { width: 10px; height: 10px; }
    #log-container::-webkit-scrollbar-track { background: var(--vscode-editor-background); }
    #log-container::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 5px; border: 2px solid var(--vscode-editor-background); }
    #log-container::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
    .status { width: 100%; max-width: 100%; min-width: 0; display: flex; justify-content: space-between; gap: 12px; padding: 5px 10px; color: var(--vscode-statusBar-foreground); background: var(--vscode-statusBar-background); white-space: nowrap; overflow: hidden; }
    .status > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .status > span:first-child { flex: 1; }
    .status > span:last-child { flex: 0 0 auto; }
    .error { color: var(--vscode-errorForeground); }
    .empty { padding: 32px; text-align: center; color: var(--vscode-descriptionForeground); }
    @media (max-width: 760px) {
      .version-overview { width: 100%; margin-left: 0; justify-content: flex-start; }
      .log-row { grid-template-columns: 42px 68px minmax(118px, 1.1fr) minmax(120px, 2fr); }
      .log-row > .author { display: none; }
    }
    @media (max-width: 520px) {
      .filters { grid-template-columns: minmax(0, 1fr) minmax(100px, .4fr); }
      .search-field { grid-column: 1; grid-row: 1; }
      .author-field { grid-column: 2; grid-row: 1; }
      .period-field { grid-column: 1; grid-row: 2; }
      .filters > button { grid-column: 2; grid-row: 2; justify-self: end; }
      .log-row { grid-template-columns: 34px 64px minmax(0, 1fr); }
      .log-row > .date { display: none; }
      .commit-item .graph-cell::before { left: 16px; }
      .graph-node { left: 11px; }
      .commit-details { margin-left: 34px; }
      .copy-source { display: none; }
    }
  </style>
</head>
<body>
  <main class="page">
    <div class="toolbar">
      <button id="refresh">刷新</button>
      <button id="openRevision" class="secondary" disabled>打开修订</button>
      <button id="comparePrevious" class="secondary" disabled>与上次修改比较</button>
      <button id="compareSelected" class="secondary" disabled>比较所选修订</button>
      <button id="compareWorking" class="secondary" disabled>与工作副本比较</button>
      <button id="showChanges" class="secondary" disabled>查看本次变更</button>
      <button id="openWorking" class="secondary">打开工作副本</button>
      <button id="copyRevision" class="secondary" disabled>复制版本号</button>
      <div id="versionOverview" class="version-overview" aria-live="polite"></div>
    </div>
    <div class="filters">
      <div class="filter-field search-field">
        <label for="search">筛选</label>
        <input id="search" type="search" placeholder="版本号、作者、提交信息或路径">
      </div>
      <div class="filter-field period-field">
        <label for="fromDate">时期</label>
        <div class="date-range">
          <input id="fromDate" type="date" aria-label="起始日期" title="起始日期">
          <span>至</span>
          <input id="toDate" type="date" aria-label="结束日期" title="结束日期">
        </div>
      </div>
      <div class="filter-field author-field">
        <label for="author">作者</label>
        <select id="author"><option value="">所有作者</option></select>
      </div>
      <button id="clearFilters" class="secondary">清除筛选</button>
    </div>
    <section class="content">
      <div id="log-container">
        <div id="log-inner" role="table" aria-label="SVN 日志">
          <div class="log-row log-header" role="row">
            <span class="log-cell graph-cell" role="columnheader" aria-label="提交图"></span>
            <span class="log-cell revision" role="columnheader">版本</span>
            <span class="log-cell author" role="columnheader">作者</span>
            <span class="log-cell date" role="columnheader">日期</span>
            <span class="log-cell commit-message" role="columnheader">提交信息</span>
          </div>
          <div id="logRows" role="rowgroup"></div>
          <div id="empty" class="empty" hidden>没有匹配的日志记录</div>
        </div>
      </div>
    </section>
    <footer class="status">
      <span id="target">正在读取 SVN 信息…</span>
      <span><span id="summary"></span> <button id="loadMore" class="secondary" hidden>加载更多</button> <button id="loadAll" class="secondary" hidden>加载全部</button></span>
    </footer>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = { entries: [], hasMore: false, loading: true };
    let selected = [];
    let expandedRevision;
    const byId = id => document.getElementById(id);
    const rows = byId('logRows');
    const filters = ['search', 'author', 'fromDate', 'toDate'];

    function send(command, extra = {}) { vscode.postMessage({ command, ...extra }); }
    function formatDate(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
    function firstLine(value) { return (value || '（无提交信息）').split(/\\r?\\n/, 1)[0]; }
    function currentRevision() { const value = Number(state.info?.revision); return Number.isInteger(value) && value > 0 ? value : undefined; }
    function filteredEntries() {
      const query = byId('search').value.trim().toLocaleLowerCase();
      const author = byId('author').value;
      const fromValue = byId('fromDate').value;
      const toValue = byId('toDate').value;
      const from = fromValue ? new Date(fromValue + 'T00:00:00').getTime() : -Infinity;
      const to = toValue ? new Date(toValue + 'T23:59:59.999').getTime() : Infinity;
      return state.entries.filter(entry => {
        const time = new Date(entry.date).getTime();
        const text = [entry.revision, entry.author, entry.message, ...entry.changedPaths.map(item => item.path)].join(' ').toLocaleLowerCase();
        const dateMatches = !fromValue && !toValue || Number.isFinite(time) && time >= from && time <= to;
        return (!query || text.includes(query)) && (!author || entry.author === author) && dateMatches;
      });
    }
    function renderAuthors() {
      const current = byId('author').value;
      const authors = [...new Set(state.entries.map(entry => entry.author).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      byId('author').replaceChildren(new Option('所有作者', ''), ...authors.map(author => new Option(author, author)));
      byId('author').value = authors.includes(current) ? current : '';
    }
    function textCell(className, value) {
      const cell = document.createElement('span');
      cell.className = 'log-cell ' + className;
      cell.setAttribute('role', 'cell');
      cell.textContent = value;
      cell.title = value;
      return cell;
    }
    function badge(label, className) {
      const value = document.createElement('span');
      value.className = 'row-badge ' + className;
      value.textContent = label;
      return value;
    }
    function renderRows() {
      const entries = filteredEntries();
      const latestRevision = state.entries[0]?.revision;
      const workingRevision = currentRevision();
      rows.replaceChildren();
      for (const entry of entries) {
        const item = document.createElement('div');
        const isLatest = entry.revision === latestRevision;
        const isCurrent = entry.revision === workingRevision;
        item.className = 'commit-item' + (isLatest ? ' latest' : '') + (isCurrent ? ' current' : '');
        item.classList.toggle('selected', selected.includes(entry.revision));
        item.dataset.revision = String(entry.revision);

        const row = document.createElement('div');
        row.className = 'log-row';
        row.setAttribute('role', 'row');
        row.setAttribute('tabindex', '0');
        row.setAttribute('aria-expanded', String(expandedRevision === entry.revision));
        const graph = document.createElement('span');
        graph.className = 'log-cell graph-cell';
        graph.setAttribute('role', 'cell');
        const node = document.createElement('span'); node.className = 'graph-node'; graph.appendChild(node);
        row.append(
          graph,
          textCell('revision', 'r' + entry.revision),
          textCell('author', entry.author || '（无作者）'),
          textCell('date', formatDate(entry.date))
        );
        const message = document.createElement('span');
        message.className = 'log-cell commit-message summary-message';
        message.setAttribute('role', 'cell');
        const chevron = document.createElement('span');
        chevron.className = 'row-chevron';
        chevron.textContent = expandedRevision === entry.revision ? '▾' : '›';
        const summary = document.createElement('span');
        summary.className = 'summary-text';
        summary.textContent = firstLine(entry.message);
        summary.title = entry.message || '（无提交信息）';
        message.append(chevron, summary);
        if (isLatest) message.appendChild(badge('最新', 'latest'));
        if (isCurrent) message.appendChild(badge('当前', 'current'));
        if (workingRevision !== undefined && entry.revision > workingRevision) message.appendChild(badge('待更新', 'pending'));
        row.appendChild(message);
        row.addEventListener('click', event => {
          if (event.detail === 1) select(entry.revision, event.ctrlKey || event.metaKey);
        });
        row.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(entry.revision, event.ctrlKey || event.metaKey); }
        });
        item.appendChild(row);
        if (expandedRevision === entry.revision) item.appendChild(renderDetails(entry));
        rows.appendChild(item);
      }
      byId('empty').hidden = entries.length > 0 || state.loading;
      byId('summary').textContent = state.loading ? '正在加载…' : '已显示 ' + entries.length + ' / 已加载 ' + state.entries.length + ' 条';
    }
    function select(revision, additive) {
      if (additive) {
        selected = selected.includes(revision) ? selected.filter(value => value !== revision) : [...selected, revision].slice(-2);
        if (selected.includes(revision)) expandedRevision = revision;
        else if (expandedRevision === revision) expandedRevision = undefined;
      } else {
        const collapse = selected.length === 1 && selected[0] === revision && expandedRevision === revision;
        selected = [revision];
        expandedRevision = collapse ? undefined : revision;
      }
      renderRows();
      updateActions();
    }
    function changeTree(changes) {
      const root = { children: new Map() };
      const paths = changes.map(change => change.path.split('/').filter(Boolean));
      let commonLength = paths[0]?.length || 0;
      for (let index = 1; index < paths.length && commonLength > 0; index++) {
        let matched = 0;
        while (matched < commonLength && paths[index][matched] === paths[0][matched]) matched++;
        commonLength = matched;
      }
      if (changes.length === 1 && changes[0].kind !== 'dir') {
        commonLength = Math.max(0, commonLength - 1);
      }

      let treeRoot = root;
      if (commonLength > 0) {
        const commonPath = '/' + paths[0].slice(0, commonLength).join('/');
        const commonName = (commonLength > 1 ? '…/' : '/') + paths[0][commonLength - 1];
        treeRoot = { name: commonName, path: commonPath, children: new Map() };
        root.children.set(commonPath, treeRoot);
      }

      for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
        const change = changes[changeIndex];
        const segments = paths[changeIndex];
        let parent = treeRoot;
        let currentPath = commonLength > 0 ? '/' + segments.slice(0, commonLength).join('/') : '';
        for (const segment of segments.slice(commonLength)) {
          currentPath += '/' + segment;
          if (!parent.children.has(segment)) parent.children.set(segment, { name: segment, path: currentPath, children: new Map() });
          parent = parent.children.get(segment);
        }
        parent.change = change;
      }
      return root;
    }
    function appendTreeNodes(container, parent, depth, revision) {
      const nodes = [...parent.children.values()].sort((left, right) => {
        const leftDirectory = left.children.size > 0 || left.change?.kind === 'dir';
        const rightDirectory = right.children.size > 0 || right.change?.kind === 'dir';
        return Number(rightDirectory) - Number(leftDirectory) || left.name.localeCompare(right.name);
      });
      for (const treeNode of nodes) {
        const isDirectory = treeNode.children.size > 0 || treeNode.change?.kind === 'dir';
        const row = document.createElement('div');
        row.className = 'tree-row';
        row.title = treeNode.path;
        const action = document.createElement('span');
        action.className = 'change-action ' + (treeNode.change?.action || '');
        action.textContent = treeNode.change?.action || '';
        const indent = document.createElement('span');
        indent.className = 'tree-indent';
        indent.style.width = depth * 16 + 'px';
        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = isDirectory ? '▾' : '◇';
        row.append(action, indent, icon);
        if (treeNode.change && !isDirectory) {
          const file = document.createElement('button');
          file.className = 'tree-file';
          file.textContent = treeNode.name;
          file.title = '查看 ' + treeNode.path + ' 的 Diff';
          file.onclick = event => { event.stopPropagation(); send('openFileDiff', { revision, changedPath: treeNode.change.path }); };
          row.appendChild(file);
        } else {
          const name = document.createElement('span');
          name.className = 'tree-name';
          name.textContent = treeNode.name;
          row.appendChild(name);
        }
        if (treeNode.change?.copyFromPath) {
          const copy = document.createElement('span');
          copy.className = 'copy-source';
          copy.textContent = '来自 ' + treeNode.change.copyFromPath + '@' + treeNode.change.copyFromRevision;
          copy.title = copy.textContent;
          row.appendChild(copy);
        }
        container.appendChild(row);
        appendTreeNodes(container, treeNode, depth + 1, revision);
      }
    }
    function renderDetails(entry) {
      const details = document.createElement('div');
      details.className = 'commit-details';
      const head = document.createElement('div'); head.className = 'details-head';
      for (const value of ['版本 r' + entry.revision, '作者：' + (entry.author || '（无作者）'), '日期：' + formatDate(entry.date), '改动：' + entry.changedPaths.length + ' 项']) {
        const span = document.createElement('span'); span.textContent = value; head.appendChild(span);
      }
      const message = document.createElement('div');
      message.className = 'message';
      message.textContent = entry.message || '（无提交信息）';
      const title = document.createElement('div');
      title.className = 'changes-title';
      title.textContent = '改动文件（点击文件查看 Diff）';
      details.append(head, message, title);
      if (entry.changedPaths.length === 0) {
        const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '此提交没有返回改动路径'; details.appendChild(empty);
      } else {
        const tree = document.createElement('div'); tree.className = 'change-tree';
        appendTreeNodes(tree, changeTree(entry.changedPaths), 0, entry.revision);
        details.appendChild(tree);
      }
      return details;
    }
    function updateActions() {
      const one = selected.length === 1;
      const isFile = state.info?.kind === 'file';
      byId('openRevision').disabled = !one || !isFile;
      byId('comparePrevious').disabled = !one || !isFile;
      byId('compareSelected').disabled = selected.length !== 2 || !isFile;
      byId('compareWorking').disabled = !one || !isFile;
      byId('showChanges').disabled = !one;
      byId('copyRevision').disabled = !one;
      byId('openWorking').textContent = isFile ? '打开工作副本' : '在资源管理器中定位';
    }
    function renderVersionOverview() {
      const overview = byId('versionOverview');
      const latest = state.entries[0]?.revision;
      const current = currentRevision();
      overview.replaceChildren();
      if (!latest || !current) return;
      const latestPill = document.createElement('span'); latestPill.className = 'version-pill latest'; latestPill.textContent = '最新 r' + latest;
      const currentPill = document.createElement('span'); currentPill.className = 'version-pill current'; currentPill.textContent = '当前 r' + current;
      const gap = document.createElement('span'); gap.className = 'version-gap';
      const newer = state.entries.filter(entry => entry.revision > current).length;
      const countLabel = state.hasMore && !state.entries.some(entry => entry.revision <= current) ? '至少 ' + newer : String(newer);
      gap.textContent = latest > current ? '相差 ' + (latest - current) + ' 个修订号 · ' + countLabel + ' 条相关更新' : latest === current ? '已是最新版本' : '工作副本已包含路径最新修订';
      overview.append(latestPill, currentPill, gap);
    }
    function render() {
      renderAuthors(); renderRows(); renderVersionOverview(); updateActions();
      const info = state.info;
      byId('target').textContent = info ? state.target + '  •  ' + info.url + (info.revision ? '  •  工作副本 r' + info.revision : '') : (state.target || '正在读取 SVN 信息…');
      byId('loadMore').hidden = !state.hasMore; byId('loadAll').hidden = !state.hasMore;
      for (const id of ['refresh', 'loadMore', 'loadAll']) byId(id).disabled = state.loading;
    }

    byId('refresh').onclick = () => send('refresh');
    byId('loadMore').onclick = () => send('loadMore');
    byId('loadAll').onclick = () => send('loadAll');
    byId('openRevision').onclick = () => send('openRevision', { revision: selected[0] });
    byId('comparePrevious').onclick = () => send('comparePrevious', { revision: selected[0] });
    byId('compareSelected').onclick = () => send('compareSelected', { revisions: selected });
    byId('compareWorking').onclick = () => send('compareWorking', { revision: selected[0] });
    byId('showChanges').onclick = () => send('showChanges', { revision: selected[0] });
    byId('openWorking').onclick = () => send('openWorking');
    byId('copyRevision').onclick = () => send('copy', { text: String(selected[0] || '') });
    function applyFilters() {
      const visible = new Set(filteredEntries().map(entry => entry.revision));
      selected = selected.filter(revision => visible.has(revision));
      if (!visible.has(expandedRevision)) expandedRevision = undefined;
      renderRows();
      updateActions();
    }
    byId('clearFilters').onclick = () => { byId('search').value = ''; byId('author').value = ''; byId('fromDate').value = ''; byId('toDate').value = ''; applyFilters(); };
    for (const id of filters) byId(id).addEventListener(id === 'search' ? 'input' : 'change', applyFilters);
    window.addEventListener('message', event => {
      if (event.data.type === 'state') {
        state = event.data;
        selected = selected.filter(revision => state.entries.some(entry => entry.revision === revision));
        if (!state.entries.some(entry => entry.revision === expandedRevision)) expandedRevision = undefined;
        byId('summary').className = '';
        render();
      }
      if (event.data.type === 'error') { byId('summary').textContent = event.data.message; byId('summary').className = 'error'; }
    });
    send('ready');
  </script>
</body>
</html>`;
}
