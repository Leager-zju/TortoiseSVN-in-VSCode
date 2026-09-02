import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getSvnBlame, getSvnRevisionLog, SvnBlameLine, SvnLogEntry } from './svn';

type BlameCacheEntry = {
  state: string;
  lines: Map<number, SvnBlameLine>;
};

type DocumentBlame = {
  uri: vscode.Uri;
  lines: Map<number, SvnBlameLine>;
  details: Map<number, SvnLogEntry | null>;
  generation: number;
};

const MAX_CACHE_ENTRIES = 32;
const MAX_DETAIL_CACHE_ENTRIES = 512;
const MAX_ANNOTATED_LINES = 20000;
const DETAIL_CONCURRENCY = 4;
const UNKNOWN_AUTHOR = '未知作者';
// 行内 Blame 是插在代码内容区的伪列，越窄越不干扰阅读，因此作者名按显示宽度截断。
const MAX_AUTHOR_WIDTH = 6;
const AUTHOR_TIME_SEPARATOR = '·';
const COLUMN_SEPARATOR = '│';
// 普通空格会被编辑器折叠，补白必须换成不换行空格才能对齐。
const PAD_SPACE = '\u00A0';

export class SvnBlameAnnotator implements vscode.Disposable, vscode.HoverProvider {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly documents = new Map<string, DocumentBlame>();
  private readonly blameCache = new Map<string, BlameCacheEntry>();
  private readonly detailCache = new Map<string, SvnLogEntry | null>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      before: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
        margin: '0 0.5em 0 0'
      }
    });
    this.disposables.push(
      this.decorationType,
      vscode.languages.registerHoverProvider({ scheme: 'file' }, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      // 文件内容变化后行号会漂移，继续显示会指向错误的行，因此直接清除。
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length > 0) {
          this.clear(event.document.uri);
        }
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        const entry = this.documents.get(documentKey(document.uri));
        if (entry) {
          entry.generation++;
          this.documents.delete(documentKey(document.uri));
        }
      })
    );
  }

  async toggle(editor: vscode.TextEditor, line: number): Promise<void> {
    const document = editor.document;
    if (document.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('Blame 仅支持本地工作副本文件。');
      return;
    }
    if (line < 0 || line >= document.lineCount) {
      return;
    }

    const key = documentKey(document.uri);
    // 只要该文件已处于 Blame 状态，再次点击即整篇关闭。
    if (this.documents.has(key)) {
      this.clear(document.uri);
      return;
    }

    if (document.isDirty) {
      const choice = await vscode.window.showWarningMessage(
        'SVN Blame 基于磁盘内容。需要先保存文件，才能确保行号准确。',
        { modal: true },
        '保存并查看'
      );
      if (choice !== '保存并查看' || !await document.save()) {
        return;
      }
      if (line >= document.lineCount) {
        return;
      }
    }

    const filePath = document.uri.fsPath;
    let blame: Map<number, SvnBlameLine>;
    try {
      blame = await this.blameLines(filePath);
    } catch (error) {
      const message = errorMessage(error);
      const friendly = /not a working copy|not under version control|is not under version control/i.test(message)
        ? '该文件不在 SVN 版本管理中，无法查看 Blame 信息。'
        : `无法读取该文件的 SVN Blame 信息：${message}`;
      void vscode.window.showErrorMessage(friendly);
      return;
    }

    // 整篇标注：每一行都显示，空行与 SVN 未记录的行无法渲染，直接跳过。
    const annotated = new Map<number, SvnBlameLine>();
    let truncated = false;
    for (let number = 0; number < document.lineCount; number += 1) {
      if (annotated.size >= MAX_ANNOTATED_LINES) {
        truncated = true;
        break;
      }
      if (document.lineAt(number).text.length === 0) {
        continue;
      }
      const blameLine = blame.get(number);
      if (blameLine) {
        annotated.set(number, blameLine);
      }
    }
    if (annotated.size === 0) {
      void vscode.window.showInformationMessage('SVN 没有记录该文件的 Blame 信息。');
      return;
    }
    if (truncated) {
      void vscode.window.showWarningMessage(
        `文件较大，仅显示前 ${MAX_ANNOTATED_LINES} 行的 Blame 信息。`);
    }

    const entry: DocumentBlame = {
      uri: document.uri,
      lines: annotated,
      details: new Map<number, SvnLogEntry | null>(),
      generation: 0
    };
    this.documents.set(key, entry);
    this.render(document.uri);
    await this.loadDetails(entry, editor);
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const entry = this.documents.get(documentKey(document.uri));
    if (!entry) {
      return undefined;
    }
    const blame = entry.lines.get(position.line);
    if (!blame) {
      return undefined;
    }
    return new vscode.Hover(await this.hoverMessage(entry, blame));
  }

  clear(uri?: vscode.Uri): void {
    for (const [key, entry] of [...this.documents]) {
      if (uri && key !== documentKey(uri)) {
        continue;
      }
      entry.generation++;
      this.documents.delete(key);
    }
    this.renderAll();
  }

  dispose(): void {
    this.documents.clear();
    this.blameCache.clear();
    this.detailCache.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private async blameLines(filePath: string): Promise<Map<number, SvnBlameLine>> {
    const fileKey = pathKey(filePath);
    const state = await this.fileState(filePath);
    const cached = this.blameCache.get(fileKey);
    if (cached && cached.state === state) {
      return cached.lines;
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在查询 ${path.basename(filePath)} 的 SVN Blame…`
      },
      () => this.loadBlame(filePath, fileKey, state)
    );
  }

  private async loadBlame(
    filePath: string,
    fileKey: string,
    state: string
  ): Promise<Map<number, SvnBlameLine>> {
    const blame = await getSvnBlame(filePath);
    const lines = new Map(blame.map(line => [line.lineNumber - 1, line]));
    if (this.blameCache.size >= MAX_CACHE_ENTRIES) {
      this.blameCache.clear();
    }
    this.blameCache.set(fileKey, { state, lines });
    return lines;
  }

  private async fileState(filePath: string): Promise<string> {
    try {
      const stat = await fs.stat(filePath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return '';
    }
  }

  private async loadDetails(entry: DocumentBlame, editor: vscode.TextEditor): Promise<void> {
    const pending = [...new Set([...entry.lines.values()].map(line => line.revision))]
      .filter((revision): revision is number => revision !== undefined && revision > 0)
      .filter(revision => !entry.details.has(revision));
    if (pending.length === 0) {
      return;
    }

    // 整篇 Blame 可能涉及成百个版本，先加载视口内的版本，其余在后台慢慢补齐。
    const visibleLines = new Set<number>();
    for (const range of editor.visibleRanges) {
      for (let line = range.start.line; line <= range.end.line && line < editor.document.lineCount; line += 1) {
        visibleLines.add(line);
      }
    }
    const visibleRevisions = new Set<number>();
    for (const [line, blame] of entry.lines) {
      if (visibleLines.has(line) && blame.revision !== undefined) {
        visibleRevisions.add(blame.revision);
      }
    }
    const first = pending.filter(revision => visibleRevisions.has(revision));
    const rest = pending.filter(revision => !visibleRevisions.has(revision));
    await this.loadRevisions(entry, first);
    if (rest.length > 0) {
      void this.loadRevisions(entry, rest);
    }
  }

  private async loadRevisions(entry: DocumentBlame, revisions: number[]): Promise<void> {
    if (revisions.length === 0) {
      return;
    }
    const generation = entry.generation;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < revisions.length) {
        const revision = revisions[cursor++];
        const detail = await this.detailFor(entry.uri.fsPath, revision);
        if (entry.generation === generation) {
          entry.details.set(revision, detail);
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(DETAIL_CONCURRENCY, revisions.length) },
      () => worker()
    ));
    if (entry.generation !== generation || !this.documents.has(documentKey(entry.uri))) {
      return;
    }
    this.render(entry.uri);
  }

  private async detailFor(filePath: string, revision: number): Promise<SvnLogEntry | null> {
    const key = `${pathKey(filePath)}:${revision}`;
    const cached = this.detailCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let detail: SvnLogEntry | null;
    try {
      detail = (await getSvnRevisionLog(filePath, revision)) ?? null;
    } catch {
      detail = null;
    }
    if (this.detailCache.size >= MAX_DETAIL_CACHE_ENTRIES) {
      this.detailCache.clear();
    }
    this.detailCache.set(key, detail);
    return detail;
  }

  private renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.render(editor.document.uri);
    }
  }

  private render(uri: vscode.Uri): void {
    const editor = vscode.window.visibleTextEditors.find(
      value => value.document.uri.toString() === uri.toString());
    if (!editor) {
      return;
    }
    const entry = this.documents.get(documentKey(uri));
    if (!entry) {
      editor.setDecorations(this.decorationType, []);
      return;
    }
    const document = editor.document;
    const visible = [...entry.lines]
      .sort((left, right) => left[0] - right[0])
      .filter(([line]) => line < document.lineCount && document.lineAt(line).text.length > 0);
    // 列宽取当前所有 Blame 行中最宽的标签，避免出现无谓的补白。
    const width = visible.reduce(
      (max, [, blame]) => Math.max(max, displayWidth(blameLabel(blame))), 0);

    const options: vscode.DecorationOptions[] = [];
    for (const [line, blame] of visible) {
      const text = document.lineAt(line).text;
      const label = blameLabel(blame);
      options.push({
        range: new vscode.Range(line, 0, line, text.length),
        renderOptions: { before: { contentText: alignLabel(label, width) } }
      });
    }
    editor.setDecorations(this.decorationType, options);
  }

  private async hoverMessage(
    entry: DocumentBlame,
    blame: SvnBlameLine
  ): Promise<vscode.MarkdownString> {
    const markdown = new vscode.MarkdownString();
    if (blame.revision === undefined) {
      markdown.appendMarkdown(`**${escapeMarkdown(blame.author || UNKNOWN_AUTHOR)}** · 未提交的本地修改\n\n`);
      markdown.appendMarkdown(`第 ${blame.lineNumber} 行尚未提交到 SVN，没有对应的版本记录。`);
      return markdown;
    }

    const date = new Date(blame.date);
    const hasDate = !Number.isNaN(date.getTime());
    markdown.appendMarkdown(
      `### r${blame.revision} · ${escapeMarkdown(blame.author || UNKNOWN_AUTHOR)}\n\n`);
    if (hasDate) {
      markdown.appendMarkdown(`${formatDateTime(date)}（${relativeTime(date)}）\n\n`);
    }

    let detail = entry.details.get(blame.revision);
    if (detail === undefined) {
      // 整篇 Blame 下后台可能还没轮到该版本，悬停时按需补齐。
      detail = await this.detailFor(entry.uri.fsPath, blame.revision);
      entry.details.set(blame.revision, detail);
    }
    if (detail === null) {
      markdown.appendMarkdown('_无法读取该版本的提交信息。_');
      return markdown;
    }

    const message = compactMessage(detail.message);
    markdown.appendMarkdown(message ? escapeMarkdown(message) : '_（该版本没有提交说明）_');
    if (detail.changedPaths.length > 0) {
      markdown.appendMarkdown(`\n\n---\n\n本次提交共变更 ${detail.changedPaths.length} 个路径：\n`);
      for (const changedPath of detail.changedPaths.slice(0, 8)) {
        markdown.appendMarkdown(
          `- \`${escapeMarkdown(changedPath.path)}\`（${actionLabel(changedPath.action)}）\n`);
      }
      if (detail.changedPaths.length > 8) {
        markdown.appendMarkdown(`- ……等 ${detail.changedPaths.length} 项\n`);
      }
    }
    return markdown;
  }
}

export function blameLineNumber(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const line = lineNumberFromValue(value);
    if (line !== undefined) {
      return line;
    }
  }
  return undefined;
}

function lineNumberFromValue(value: unknown): number | undefined {
  // 行号上下文菜单可能以 1 起始的行号、0 起始的索引或带行号的对象传递当前行。
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value - 1 : undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['lineNumber', 'line', 'startLineNumber'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate > 0 ? candidate - 1 : candidate;
    }
  }
  for (const key of ['range', 'selection'] as const) {
    const candidate = record[key];
    if (candidate && typeof candidate === 'object') {
      const line = lineNumberFromValue(candidate);
      if (line !== undefined) {
        return line;
      }
    }
  }
  return undefined;
}

function blameLabel(blame: SvnBlameLine): string {
  const author = truncateToWidth(blame.author || UNKNOWN_AUTHOR, MAX_AUTHOR_WIDTH);
  if (blame.revision === undefined) {
    return `${author}${AUTHOR_TIME_SEPARATOR}本地`;
  }
  const date = new Date(blame.date);
  if (Number.isNaN(date.getTime())) {
    return `${author}${AUTHOR_TIME_SEPARATOR}r${blame.revision}`;
  }
  return `${author}${AUTHOR_TIME_SEPARATOR}${shortRelativeTime(date)}`;
}

// 把同一文档内的所有 Blame 标签补白到相同宽度，让分隔符对齐成一条竖线。
function alignLabel(label: string, width: number): string {
  const padding = Math.max(0, width - displayWidth(label));
  return `${label}${PAD_SPACE.repeat(padding)}${COLUMN_SEPARATOR}`;
}

function shortRelativeTime(date: Date, now = Date.now()): string {
  const diff = now - date.getTime();
  if (!Number.isFinite(diff) || diff < 60_000) {
    return '刚刚';
  }
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) {
    return `${Math.floor(diff / minute)}分`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)}时`;
  }
  const days = Math.floor(diff / day);
  if (days < 30) {
    return `${days}天`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)}月`;
  }
  return `${Math.floor(days / 365)}年`;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += isWideCharacter(character) ? 2 : 1;
  }
  return width;
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) {
    return text;
  }
  let width = 0;
  let result = '';
  // 末尾留 1 列给省略号。
  for (const character of text) {
    const characterWidth = isWideCharacter(character) ? 2 : 1;
    if (width + characterWidth > maxWidth - 1) {
      break;
    }
    result += character;
    width += characterWidth;
  }
  return `${result}…`;
}

function isWideCharacter(character: string): boolean {
  const code = character.codePointAt(0);
  if (code === undefined) {
    return false;
  }
  return code >= 0x1100 && (
    code <= 0x115f ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function relativeTime(date: Date, now = Date.now()): string {
  const diff = now - date.getTime();
  if (!Number.isFinite(diff) || diff < 60_000) {
    return '刚刚';
  }
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) {
    return `${Math.floor(diff / minute)} 分钟前`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)} 小时前`;
  }
  const days = Math.floor(diff / day);
  if (days < 30) {
    return `${days} 天前`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)} 个月前`;
  }
  return `${Math.floor(days / 365)} 年前`;
}

function compactMessage(message: string): string {
  const lines = message.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  if (lines.length <= 20) {
    return lines.join('\n').trim();
  }
  return `${lines.slice(0, 20).join('\n')}\n……（提交说明已省略 ${lines.length - 20} 行）`;
}

function actionLabel(action: string): string {
  switch (action.toUpperCase()) {
    case 'A':
      return '添加';
    case 'D':
      return '删除';
    case 'M':
      return '修改';
    case 'R':
      return '替换';
    default:
      return '其他';
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]>#])/g, '\\$1').replace(/\r?\n/g, '  \n');
}

function documentKey(uri: vscode.Uri): string {
  return pathKey(uri.fsPath);
}

function pathKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
