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
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 2px; padding: 5px 10px; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { opacity: .45; cursor: default; }
    input, select { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 5px 7px; outline: none; }
    input:focus, select:focus { border-color: var(--vscode-focusBorder); }
    .page { width: 100%; max-width: 100%; min-width: 0; height: 100%; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; }
    .toolbar { width: 100%; max-width: 100%; min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .filters { width: 100%; max-width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .8fr) minmax(90px, .45fr) auto; align-items: end; gap: 8px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .filter-field { min-width: 0; display: grid; gap: 4px; }
    .filter-field label { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 16px; }
    .filter-field input, .filter-field select { width: 100%; min-width: 0; }
    .search-field, .period-field, .author-field { min-width: 0; }
    .filters > button { width: 88px; min-width: 88px; white-space: nowrap; }
    .date-range { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 6px; }
    .date-range span { color: var(--vscode-descriptionForeground); text-align: center; }
    .content { width: 100%; max-width: 100%; min-width: 0; min-height: 0; display: grid; grid-template-rows: minmax(140px, 55%) auto minmax(0, 1fr); overflow: hidden; }
    .details { min-width: 0; min-height: 0; overflow: auto; }
    #log-container { position: relative; width: 100%; max-width: 100%; min-width: 0; min-height: 0; overflow: auto; background: var(--vscode-editor-background); scrollbar-gutter: stable; }
    #log-inner { position: relative; width: 100%; min-width: 760px; }
    .log-row { width: 100%; min-width: 0; display: grid; grid-template-columns: 88px minmax(80px, 150px) 190px minmax(0, 1fr); align-items: start; cursor: default; }
    .log-header { position: sticky; top: 0; z-index: 2; text-align: left; background: var(--vscode-editorGroupHeader-tabsBackground); }
    .log-cell { min-width: 0; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .log-header .log-cell { font-weight: 600; }
    .log-row .commit-message { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; line-height: 1.4; }
    #logRows .log-row:hover { background: var(--vscode-list-hoverBackground); }
    #logRows .log-row.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    #log-container::-webkit-scrollbar { width: 10px; height: 10px; }
    #log-container::-webkit-scrollbar-track { background: var(--vscode-editor-background); }
    #log-container::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 5px; border: 2px solid var(--vscode-editor-background); }
    #log-container::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th { position: sticky; top: 0; z-index: 2; text-align: left; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; }
    td { border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    tr { cursor: default; }
    tr:hover { background: var(--vscode-list-hoverBackground); }
    .splitter { min-height: 28px; display: flex; align-items: center; padding: 4px 12px; color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground)); background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorGroupHeader-tabsBackground)); border-top: 2px solid var(--vscode-focusBorder); border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; letter-spacing: .2px; box-shadow: 0 -2px 6px color-mix(in srgb, var(--vscode-widget-shadow) 35%, transparent); }
    .splitter::before { content: ''; width: 3px; align-self: stretch; margin-right: 8px; border-radius: 2px; background: var(--vscode-focusBorder); }
    .details { padding: 10px 12px; }
    .details-head { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
    .message { white-space: pre-wrap; margin: 8px 0 12px; line-height: 1.5; user-select: text; }
    .paths { width: 100%; }
    .paths .action { width: 52px; font-weight: 700; }
    .path-copy { color: var(--vscode-descriptionForeground); }
    .status { width: 100%; max-width: 100%; min-width: 0; display: flex; justify-content: space-between; gap: 12px; padding: 5px 10px; color: var(--vscode-statusBar-foreground); background: var(--vscode-statusBar-background); white-space: nowrap; overflow: hidden; }
    .status > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .status > span:first-child { flex: 1; }
    .status > span:last-child { flex: 0 0 auto; }
    .error { color: var(--vscode-errorForeground); }
    .empty { padding: 32px; text-align: center; color: var(--vscode-descriptionForeground); }
    @media (max-width: 520px) {
      .filters { grid-template-columns: minmax(0, 1fr) minmax(100px, .4fr); }
      .search-field { grid-column: 1; grid-row: 1; }
      .author-field { grid-column: 2; grid-row: 1; }
      .period-field { grid-column: 1; grid-row: 2; }
      .filters > button { grid-column: 2; grid-row: 2; justify-self: end; }
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
            <span class="log-cell revision" role="columnheader">版本</span>
            <span class="log-cell author" role="columnheader">作者</span>
            <span class="log-cell date" role="columnheader">日期</span>
            <span class="log-cell commit-message" role="columnheader">提交信息</span>
          </div>
          <div id="logRows" role="rowgroup"></div>
          <div id="empty" class="empty" hidden>没有匹配的日志记录</div>
        </div>
      </div>
      <div class="splitter" role="separator" aria-label="日志列表与提交详情分隔栏">提交详情与具体改动</div>
      <div id="details" class="details"><div class="empty">选择一条日志查看提交信息与变更路径；按 Ctrl 可选择两条记录进行比较。</div></div>
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
    const byId = id => document.getElementById(id);
    const rows = byId('logRows');
    const details = byId('details');
    const filters = ['search', 'author', 'fromDate', 'toDate'];

    function send(command, extra = {}) { vscode.postMessage({ command, ...extra }); }
    function formatDate(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
    function selectedEntry() { return state.entries.find(entry => entry.revision === selected[0]); }
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
    function renderRows() {
      const entries = filteredEntries();
      rows.replaceChildren();
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'log-row';
        row.setAttribute('role', 'row');
        row.dataset.revision = String(entry.revision);
        row.classList.toggle('selected', selected.includes(entry.revision));
        const cells = [
          { className: 'revision', value: 'r' + entry.revision },
          { className: 'author', value: entry.author || '（无作者）' },
          { className: 'date', value: formatDate(entry.date) },
          { className: 'commit-message', value: entry.message || '（无提交信息）' }
        ];
        for (const item of cells) {
          const cell = document.createElement('span');
          cell.className = 'log-cell ' + item.className;
          cell.setAttribute('role', 'cell');
          cell.textContent = item.value;
          cell.title = item.value;
          row.appendChild(cell);
        }
        row.addEventListener('click', event => select(entry.revision, event.ctrlKey || event.metaKey));
        row.addEventListener('dblclick', () => send('openRevision', { revision: entry.revision }));
        rows.appendChild(row);
      }
      byId('empty').hidden = entries.length > 0 || state.loading;
      byId('summary').textContent = state.loading ? '正在加载…' : '已显示 ' + entries.length + ' / 已加载 ' + state.entries.length + ' 条';
    }
    function select(revision, additive) {
      if (additive) {
        selected = selected.includes(revision) ? selected.filter(value => value !== revision) : [...selected, revision].slice(-2);
      } else {
        selected = [revision];
      }
      renderRows(); renderDetails(); updateActions();
    }
    function renderDetails() {
      const entry = selectedEntry();
      if (!entry) {
        details.innerHTML = '<div class="empty">选择一条日志查看提交信息与变更路径；按 Ctrl 可选择两条记录进行比较。</div>';
        return;
      }
      details.replaceChildren();
      const head = document.createElement('div'); head.className = 'details-head';
      for (const value of ['版本 r' + entry.revision, '作者：' + (entry.author || '（无作者）'), '日期：' + formatDate(entry.date), '变更路径：' + entry.changedPaths.length]) {
        const span = document.createElement('span'); span.textContent = value; head.appendChild(span);
      }
      const message = document.createElement('div'); message.className = 'message'; message.textContent = entry.message || '（无提交信息）';
      const table = document.createElement('table'); table.className = 'paths';
      const thead = document.createElement('thead'); thead.innerHTML = '<tr><th class="action">动作</th><th>仓库路径</th><th>复制来源</th></tr>'; table.appendChild(thead);
      const body = document.createElement('tbody');
      for (const changed of entry.changedPaths) {
        const row = document.createElement('tr');
        const action = document.createElement('td'); action.className = 'action'; action.textContent = changed.action;
        const changedPath = document.createElement('td'); changedPath.textContent = changed.path; changedPath.title = changed.path;
        const copy = document.createElement('td'); copy.className = 'path-copy'; copy.textContent = changed.copyFromPath ? changed.copyFromPath + '@' + changed.copyFromRevision : '';
        row.append(action, changedPath, copy); body.appendChild(row);
      }
      table.appendChild(body); details.append(head, message, table);
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
    function render() {
      renderAuthors(); renderRows(); renderDetails(); updateActions();
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
    byId('clearFilters').onclick = () => { byId('search').value = ''; byId('author').value = ''; byId('fromDate').value = ''; byId('toDate').value = ''; renderRows(); };
    for (const id of filters) byId(id).addEventListener(id === 'search' ? 'input' : 'change', renderRows);
    window.addEventListener('message', event => {
      if (event.data.type === 'state') { state = event.data; selected = selected.filter(revision => state.entries.some(entry => entry.revision === revision)); byId('summary').className = ''; render(); }
      if (event.data.type === 'error') { byId('summary').textContent = event.data.message; byId('summary').className = 'error'; }
    });
    send('ready');
  </script>
</body>
</html>`;
}
