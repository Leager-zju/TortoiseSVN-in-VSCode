import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface PatchFileEntry {
  path: string;
  mustExist: boolean;
}

export interface PatchRootMatch {
  strip: number;
  targets: string[];
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

export function patchFileEntries(text: string): PatchFileEntry[] {
  const lines = text.split(/\r\n|\r|\n/);
  const entries: PatchFileEntry[] = [];
  let pendingIndex: string | undefined;
  let git = false;
  const flushIndex = () => {
    if (pendingIndex) {
      entries.push({ path: pendingIndex, mustExist: true });
    }
    pendingIndex = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      // 跳过差异块正文，避免把删除的 "-- 注释" 之类的行误认成文件头。
      let oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1]);
      let newRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      while ((oldRemaining > 0 || newRemaining > 0) && index + 1 < lines.length) {
        const body = lines[index + 1];
        const marker = body.length === 0 ? ' ' : body[0];
        if (marker === ' ') {
          oldRemaining -= 1;
          newRemaining -= 1;
        } else if (marker === '-') {
          oldRemaining -= 1;
        } else if (marker === '+') {
          newRemaining -= 1;
        } else if (marker !== '\\') {
          break;
        }
        index += 1;
      }
      continue;
    }
    if (line.startsWith('Index: ')) {
      flushIndex();
      git = false;
      pendingIndex = headerPath(line.slice(7), false);
      continue;
    }
    if (line.startsWith('diff --git ')) {
      flushIndex();
      git = true;
      continue;
    }
    if (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
      const oldRaw = line.slice(4);
      const oldPath = headerPath(oldRaw, git);
      const newPath = headerPath(lines[index + 1].slice(4), git);
      const target = newPath ?? oldPath;
      if (target) {
        const added = oldPath === undefined || /\t\((?:revision 0|nonexistent)\)\s*$/.test(oldRaw);
        entries.push({ path: target, mustExist: !added });
      }
      pendingIndex = undefined;
      index += 1;
    }
  }
  flushIndex();
  return entries;
}

function headerPath(raw: string, git: boolean): string | undefined {
  let value = raw.split('\t')[0].trim().replace(/^"(.*)"$/, '$1');
  if (!value || value === '/dev/null') {
    return undefined;
  }
  if (git && /^[ab]\//.test(value)) {
    value = value.slice(2);
  }
  return value;
}

/**
 * 在工作区目录下定位 Patch 路径：工作区路径的末尾若干段与 Patch 路径的开头若干段相同时，
 * 去掉这几段（svn patch --strip）后再拼到工作区目录下。优先使用重叠最长的匹配。
 * 修改 / 删除的文件必须已存在；新增文件去掉前缀后的第一级目录必须已存在。
 */
export async function matchPatchRoot(
  root: string,
  entries: readonly PatchFileEntry[],
  exists: (filePath: string) => Promise<boolean>,
  isDirectory: (filePath: string) => Promise<boolean>
): Promise<PatchRootMatch | undefined> {
  const rootPath = path.resolve(root);
  const rootSegments = splitSegments(rootPath);
  const accept = (targets: string[]) => targetsValid(rootPath, entries, targets, exists, isDirectory);
  if (entries.some(entry => path.isAbsolute(entry.path))) {
    const targets = entries.map(entry => path.resolve(rootPath, entry.path));
    if (!targets.every(target => isInside(rootPath, target))) {
      return undefined;
    }
    return await accept(targets) ? { strip: 0, targets } : undefined;
  }

  const segments = entries.map(entry => splitSegments(entry.path));
  const maxStrip = Math.min(rootSegments.length, ...segments.map(value => value.length - 1));
  for (let strip = maxStrip; strip >= 0; strip -= 1) {
    const suffix = rootSegments.slice(rootSegments.length - strip);
    if (!segments.every(value => sameSegments(suffix, value.slice(0, strip)))) {
      continue;
    }
    const targets = segments.map(value => path.join(rootPath, ...value.slice(strip)));
    if (await accept(targets)) {
      return { strip, targets };
    }
  }
  return undefined;
}

async function targetsValid(
  rootPath: string,
  entries: readonly PatchFileEntry[],
  targets: readonly string[],
  exists: (filePath: string) => Promise<boolean>,
  isDirectory: (filePath: string) => Promise<boolean>
): Promise<boolean> {
  const checks = await Promise.all(entries.map((entry, order) => {
    if (entry.mustExist) {
      return exists(targets[order]);
    }
    const relative = splitSegments(path.relative(rootPath, targets[order]));
    // 直接位于工作区根下的新文件，其所在目录就是工作区本身。
    return relative.length <= 1 || isDirectory(path.join(rootPath, relative[0]));
  }));
  return checks.every(Boolean);
}

function splitSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.');
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (segment: string) => process.platform === 'win32' ? segment.toLowerCase() : segment;
  return left.length === right.length && left.every((segment, order) => normalize(segment) === normalize(right[order]));
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export const PATCH_TEXT_EDITOR_VIEW_TYPE = 'svn.applyPatchText';
const PATCH_TEXT_INPUT_NAME = '应用Patch文本';
// VS Code 内部的模态编辑器分组（MODAL_GROUP），用户设置等编辑器即以此方式弹出。
const MODAL_GROUP = -4;

export class PatchTextEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly apply: (text: string) => Promise<boolean>) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(_document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true };
    bindPatchTextPanel(panel, this.apply);
  }
}

export async function showPatchTextInput(storageUri: vscode.Uri): Promise<void> {
  const directory = vscode.Uri.joinPath(storageUri, 'patch-input');
  const input = vscode.Uri.joinPath(directory, PATCH_TEXT_INPUT_NAME);
  await fs.mkdir(directory.fsPath, { recursive: true });
  await fs.writeFile(input.fsPath, '', { flag: 'a' });
  try {
    await vscode.commands.executeCommand('_workbench.openWith', input, PATCH_TEXT_EDITOR_VIEW_TYPE, [MODAL_GROUP]);
  } catch {
    await vscode.commands.executeCommand('vscode.openWith', input, PATCH_TEXT_EDITOR_VIEW_TYPE);
  }
}

function bindPatchTextPanel(panel: vscode.WebviewPanel, apply: (text: string) => Promise<boolean>): void {
  let disposed = false;
  let busy = false;
  const subscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    const value = message as { command?: string; text?: unknown };
    if (value.command === 'cancel') {
      panel.dispose();
      return;
    }
    if (value.command !== 'apply' || busy) {
      return;
    }
    busy = true;
    void panel.webview.postMessage({ type: 'busy', busy: true });
    try {
      if (await apply(typeof value.text === 'string' ? value.text : '')) {
        panel.dispose();
      }
    } finally {
      busy = false;
      if (!disposed) {
        void panel.webview.postMessage({ type: 'busy', busy: false });
      }
    }
  });
  panel.onDidDispose(() => {
    disposed = true;
    subscription.dispose();
  });
  panel.webview.html = patchTextHtml();
}

function patchTextHtml(): string {
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
    button, textarea { font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 2px; padding: 5px 10px; cursor: pointer; }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .45; cursor: default; }
    .page { height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    textarea { width: 100%; height: 100%; margin: 0; resize: none; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre; tab-size: 4; }
    textarea:focus { border-color: var(--vscode-focusBorder); }
  </style>
</head>
<body>
  <main class="page">
    <div class="toolbar">
      <button id="apply">应用</button>
      <button id="cancel" class="secondary">取消</button>
    </div>
    <textarea id="patch" spellcheck="false" wrap="off" placeholder="在此粘贴 .patch 内容"></textarea>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const patch = document.getElementById('patch');
    const apply = document.getElementById('apply');
    const cancel = document.getElementById('cancel');
    apply.onclick = () => vscode.postMessage({ command: 'apply', text: patch.value });
    cancel.onclick = () => vscode.postMessage({ command: 'cancel' });
    window.addEventListener('message', event => {
      if (event.data.type === 'busy') { apply.disabled = event.data.busy; cancel.disabled = event.data.busy; }
    });
    patch.focus();
  </script>
</body>
</html>`;
}
