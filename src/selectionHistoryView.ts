import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getRevisionDiff, getSvnLog, SvnLogEntry } from './svn';

export interface SelectionHistoryLine {
  lineNumber: number;
  text: string;
  revision?: number;
  author: string;
  date: string;
}

export interface SelectionHistorySnapshot {
  rangeLabel: string;
  lines: SelectionHistoryLine[];
  stale: boolean;
}

export class SvnSelectionHistoryViewer implements vscode.Disposable {
  private readonly panels = new Map<string, SelectionHistoryPanel>();

  show(targetUri: vscode.Uri, snapshot: SelectionHistorySnapshot): void {
    const key = pathKey(targetUri.fsPath);
    const existing = this.panels.get(key);
    if (existing) {
      existing.update(snapshot);
      existing.reveal();
      return;
    }
    const panel = new SelectionHistoryPanel(targetUri, snapshot, () => this.panels.delete(key));
    this.panels.set(key, panel);
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }
}

class SelectionHistoryPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private entries: SvnLogEntry[] = [];
  private failedRevisions: number[] = [];
  private ready = false;
  private loading = false;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly targetUri: vscode.Uri,
    private snapshot: SelectionHistorySnapshot,
    private readonly onDispose: () => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'svnSelectionHistory',
      `选中内容 SVN 历史：${path.basename(targetUri.fsPath)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage(message => void this.handleMessage(message))
    );
    this.panel.webview.html = selectionHistoryHtml(this.panel.webview);
  }

  update(snapshot: SelectionHistorySnapshot): void {
    this.snapshot = snapshot;
    this.entries = [];
    this.failedRevisions = [];
    this.generation++;
    this.panel.title = `选中内容 SVN 历史：${path.basename(this.targetUri.fsPath)}`;
    if (this.ready) {
      this.postState();
      void this.loadCommitDetails();
    }
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation++;
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
    const value = message as { command: string; revision?: number; lineNumber?: number; text?: string };
    try {
      switch (value.command) {
        case 'ready':
          this.ready = true;
          this.postState();
          await this.loadCommitDetails();
          break;
        case 'refresh':
          await vscode.window.showTextDocument(this.targetUri, { preview: false });
          await vscode.commands.executeCommand('svn.selectionHistory', this.targetUri);
          break;
        case 'openRevision':
          await this.openRevision(value.revision);
          break;
        case 'compareWorking':
          await this.compareWorking(value.revision);
          break;
        case 'showChanges':
          await this.showChanges(value.revision);
          break;
        case 'revealLine':
          await this.revealLine(value.lineNumber);
          break;
        case 'fullLog':
          await vscode.commands.executeCommand('svn.log', this.targetUri);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(value.text ?? '');
          break;
      }
    } catch (error) {
      this.post({ type: 'error', message: errorMessage(error) });
    }
  }

  private async loadCommitDetails(): Promise<void> {
    const revisions = [...new Set(
      this.snapshot.lines
        .map(line => line.revision)
        .filter((revision): revision is number => revision !== undefined)
    )].sort((left, right) => right - left);
    const generation = ++this.generation;
    this.entries = [];
    this.failedRevisions = [];
    if (revisions.length === 0) {
      this.loading = false;
      this.postState();
      return;
    }

    this.loading = true;
    this.postState();
    let cursor = 0;
    const errors: string[] = [];
    const worker = async () => {
      while (cursor < revisions.length && generation === this.generation && !this.disposed) {
        const revision = revisions[cursor++];
        try {
          const page = await getSvnLog(this.targetUri.fsPath, revision, 1);
          const entry = page.entries.find(item => item.revision === revision);
          if (!entry) {
            errors.push(`r${revision}：该路径在此版本没有可读取的日志详情`);
          } else if (generation === this.generation) {
            this.entries.push(entry);
            this.entries.sort((left, right) => right.revision - left.revision);
            this.postState();
          }
        } catch (error) {
          errors.push(`r${revision}：${errorMessage(error)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, revisions.length) }, worker));
    if (generation !== this.generation || this.disposed) {
      return;
    }
    this.loading = false;
    this.failedRevisions = errors.map(error => Number(/^r(\d+)/.exec(error)?.[1] ?? 0)).filter(Boolean);
    this.postState();
    if (errors.length > 0) {
      this.post({ type: 'error', message: `部分提交详情加载失败：${errors[0]}` });
    }
  }

  private async openRevision(revision: number | undefined): Promise<void> {
    if (!revision) {
      return;
    }
    await vscode.window.showTextDocument(revisionUri(this.targetUri, revision), { preview: false });
  }

  private async compareWorking(revision: number | undefined): Promise<void> {
    if (!revision) {
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      revisionUri(this.targetUri, revision),
      this.targetUri,
      `${path.basename(this.targetUri.fsPath)}（r${revision} ↔ 工作副本）`
    );
  }

  private async showChanges(revision: number | undefined): Promise<void> {
    if (!revision) {
      return;
    }
    const content = await getRevisionDiff(this.targetUri.fsPath, revision);
    const document = await vscode.workspace.openTextDocument({ language: 'diff', content });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async revealLine(lineNumber: number | undefined): Promise<void> {
    if (!lineNumber || lineNumber < 1) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(this.targetUri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const line = Math.min(lineNumber - 1, Math.max(0, document.lineCount - 1));
    const range = document.lineAt(line).range;
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private postState(): void {
    this.post({
      type: 'state',
      target: this.targetUri.fsPath,
      snapshot: this.snapshot,
      entries: this.entries,
      failedRevisions: this.failedRevisions,
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

function selectionHistoryHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); overflow: hidden; }
    button, input { font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 2px; padding: 5px 10px; cursor: pointer; }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .45; cursor: default; }
    input { min-width: 220px; flex: 1; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 5px 7px; outline: none; }
    input:focus { border-color: var(--vscode-focusBorder); }
    .page { height: 100vh; display: grid; grid-template-rows: auto auto 1fr auto; }
    .toolbar, .filterbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .content { min-height: 0; display: grid; grid-template-rows: minmax(190px, 55%) 1fr; }
    .table-wrap, .commit-list, .details { min-height: 0; overflow: auto; }
    .commit-area { min-height: 0; display: grid; grid-template-columns: minmax(300px, 42%) 1fr; border-top: 1px solid var(--vscode-panel-border); }
    .details { border-left: 1px solid var(--vscode-panel-border); padding: 10px 12px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th { position: sticky; top: 0; z-index: 2; text-align: left; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; }
    td { border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    tr { cursor: default; }
    tr:hover { background: var(--vscode-list-hoverBackground); }
    tr.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .line-number { width: 72px; text-align: right; color: var(--vscode-editorLineNumber-foreground); }
    .revision { width: 92px; } .author { width: 140px; } .date { width: 190px; }
    .code { font-family: var(--vscode-editor-font-family); }
    .local { color: var(--vscode-gitDecoration-untrackedResourceForeground, var(--vscode-descriptionForeground)); }
    .details-head { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
    .message { margin: 8px 0 12px; white-space: pre-wrap; line-height: 1.5; user-select: text; }
    .paths .action { width: 50px; font-weight: 700; }
    .status { display: flex; justify-content: space-between; gap: 12px; padding: 5px 10px; color: var(--vscode-statusBar-foreground); background: var(--vscode-statusBar-background); white-space: nowrap; }
    .status span { overflow: hidden; text-overflow: ellipsis; }
    .warning { color: var(--vscode-editorWarning-foreground); }
    .error { color: var(--vscode-errorForeground); }
    .empty { padding: 28px; text-align: center; color: var(--vscode-descriptionForeground); }
    @media (max-width: 850px) { .commit-area { grid-template-columns: 1fr; grid-template-rows: 45% 55%; } .details { border-left: 0; border-top: 1px solid var(--vscode-panel-border); } .date { width: 145px; } .author { width: 110px; } }
  </style>
</head>
<body>
  <main class="page">
    <div class="toolbar">
      <button id="refresh">重新分析当前选区</button>
      <button id="openRevision" class="secondary" disabled>打开修订</button>
      <button id="compareWorking" class="secondary" disabled>与工作副本比较</button>
      <button id="showChanges" class="secondary" disabled>查看本次变更</button>
      <button id="fullLog" class="secondary">完整文件日志</button>
      <button id="copyRevision" class="secondary" disabled>复制版本号</button>
    </div>
    <div class="filterbar"><input id="search" type="search" placeholder="筛选行号、版本、作者或代码内容"></div>
    <section class="content">
      <div class="table-wrap">
        <table aria-label="选中内容逐行历史">
          <thead><tr><th class="line-number">行</th><th class="revision">版本</th><th class="author">作者</th><th class="date">日期</th><th>当前内容</th></tr></thead>
          <tbody id="lineRows"></tbody>
        </table>
        <div id="empty" class="empty" hidden>没有匹配的选中行</div>
      </div>
      <div class="commit-area">
        <div class="commit-list">
          <table aria-label="相关提交">
            <thead><tr><th class="revision">版本</th><th class="author">作者</th><th>提交信息</th></tr></thead>
            <tbody id="commitRows"></tbody>
          </table>
          <div id="commitEmpty" class="empty">正在加载相关提交…</div>
        </div>
        <div id="details" class="details"><div class="empty">选择一行或相关提交以查看详细信息。</div></div>
      </div>
    </section>
    <footer class="status"><span id="target">正在分析…</span><span id="summary"></span></footer>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const byId = id => document.getElementById(id);
    let state = { snapshot: { lines: [], rangeLabel: '', stale: false }, entries: [], failedRevisions: [], loading: true };
    let selectedRevision;

    function send(command, extra = {}) { vscode.postMessage({ command, ...extra }); }
    function formatDate(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
    function selectedEntry() { return state.entries.find(entry => entry.revision === selectedRevision); }
    function filteredLines() {
      const query = byId('search').value.trim().toLocaleLowerCase();
      if (!query) return state.snapshot.lines;
      return state.snapshot.lines.filter(line => [line.lineNumber, line.revision || '未提交', line.author, line.text].join(' ').toLocaleLowerCase().includes(query));
    }
    function chooseRevision(revision) {
      selectedRevision = revision ?? null;
      renderLines(); renderCommits(); renderDetails(); updateActions();
    }
    function renderLines() {
      const lines = filteredLines();
      const body = byId('lineRows'); body.replaceChildren();
      for (const line of lines) {
        const row = document.createElement('tr');
        row.classList.toggle('selected', line.revision !== undefined && line.revision === selectedRevision);
        const values = [String(line.lineNumber), line.revision ? 'r' + line.revision : '未提交', line.author || '—', formatDate(line.date), line.text || ' '];
        values.forEach((value, index) => { const cell = document.createElement('td'); cell.textContent = value; cell.title = value; if (index === 0) cell.className = 'line-number'; if (index === 1 && !line.revision) cell.className = 'local'; if (index === 4) cell.className = 'code'; row.appendChild(cell); });
        row.onclick = () => chooseRevision(line.revision);
        row.ondblclick = () => send('revealLine', { lineNumber: line.lineNumber });
        body.appendChild(row);
      }
      byId('empty').hidden = lines.length > 0;
    }
    function renderCommits() {
      const body = byId('commitRows'); body.replaceChildren();
      for (const entry of state.entries) {
        const row = document.createElement('tr'); row.classList.toggle('selected', entry.revision === selectedRevision);
        for (const value of ['r' + entry.revision, entry.author || '（无作者）', entry.message || '（无提交信息）']) { const cell = document.createElement('td'); cell.textContent = value; cell.title = value; row.appendChild(cell); }
        row.onclick = () => chooseRevision(entry.revision);
        row.ondblclick = () => send('openRevision', { revision: entry.revision });
        body.appendChild(row);
      }
      const empty = byId('commitEmpty');
      const revisionCount = new Set(state.snapshot.lines.map(line => line.revision).filter(Boolean)).size;
      empty.hidden = state.entries.length > 0;
      empty.textContent = state.loading
        ? '正在加载相关提交…'
        : revisionCount === 0
          ? '选区只包含本地未提交内容'
          : state.failedRevisions.length > 0
            ? '相关提交详情加载失败'
            : '没有可显示的相关提交';
    }
    function renderDetails() {
      const details = byId('details'); const entry = selectedEntry();
      if (!selectedRevision) { details.innerHTML = '<div class="empty">该行是本地新增或修改的未提交内容。</div>'; return; }
      if (!entry) {
        const failed = state.failedRevisions.includes(selectedRevision);
        details.innerHTML = '<div class="empty">' + (failed ? '无法读取 r' + selectedRevision + ' 的提交详情。' : '正在加载 r' + selectedRevision + ' 的提交详情…') + '</div>';
        return;
      }
      details.replaceChildren();
      const head = document.createElement('div'); head.className = 'details-head';
      for (const value of ['版本 r' + entry.revision, '作者：' + (entry.author || '（无作者）'), '日期：' + formatDate(entry.date), '变更路径：' + entry.changedPaths.length]) { const span = document.createElement('span'); span.textContent = value; head.appendChild(span); }
      const message = document.createElement('div'); message.className = 'message'; message.textContent = entry.message || '（无提交信息）';
      const table = document.createElement('table'); table.className = 'paths';
      const thead = document.createElement('thead'); thead.innerHTML = '<tr><th class="action">动作</th><th>仓库路径</th></tr>'; table.appendChild(thead);
      const body = document.createElement('tbody');
      for (const changed of entry.changedPaths) { const row = document.createElement('tr'); const action = document.createElement('td'); action.className = 'action'; action.textContent = changed.action; const path = document.createElement('td'); path.textContent = changed.path; path.title = changed.path; row.append(action, path); body.appendChild(row); }
      table.appendChild(body); details.append(head, message, table);
    }
    function updateActions() {
      const enabled = Number.isInteger(selectedRevision) && selectedRevision > 0;
      for (const id of ['openRevision', 'compareWorking', 'showChanges', 'copyRevision']) byId(id).disabled = !enabled;
    }
    function render() {
      if (Number.isInteger(selectedRevision) && !state.snapshot.lines.some(line => line.revision === selectedRevision)) selectedRevision = undefined;
      if (selectedRevision === undefined) selectedRevision = state.snapshot.lines.find(line => line.revision)?.revision;
      renderLines(); renderCommits(); renderDetails(); updateActions();
      const localCount = state.snapshot.lines.filter(line => !line.revision).length;
      byId('target').textContent = state.target + '  •  选中行 ' + state.snapshot.rangeLabel;
      byId('summary').textContent = state.snapshot.lines.length + ' 行，' + new Set(state.snapshot.lines.map(line => line.revision).filter(Boolean)).size + ' 个相关提交' + (localCount ? '，' + localCount + ' 行未提交' : '') + (state.loading ? '，正在加载详情…' : '');
      byId('summary').className = state.snapshot.stale ? 'warning' : '';
      if (state.snapshot.stale) byId('summary').textContent += '（编辑器内容已变化，结果可能过期）';
    }

    byId('search').addEventListener('input', renderLines);
    byId('refresh').onclick = () => send('refresh');
    byId('openRevision').onclick = () => send('openRevision', { revision: selectedRevision });
    byId('compareWorking').onclick = () => send('compareWorking', { revision: selectedRevision });
    byId('showChanges').onclick = () => send('showChanges', { revision: selectedRevision });
    byId('fullLog').onclick = () => send('fullLog');
    byId('copyRevision').onclick = () => send('copy', { text: String(selectedRevision || '') });
    window.addEventListener('message', event => {
      if (event.data.type === 'state') { state = event.data; byId('summary').className = ''; render(); }
      if (event.data.type === 'error') { byId('summary').textContent = event.data.message; byId('summary').className = 'error'; }
    });
    send('ready');
  </script>
</body>
</html>`;
}
