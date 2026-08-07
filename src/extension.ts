import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createVirtualDocumentUri, SvnRepository } from './scm';
import { findWorkingCopyRoot, getBaseContent, launchTortoise } from './svn';

class SvnDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly kind: 'base' | 'working') {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const filePath = new URLSearchParams(uri.query).get('path');
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
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshDebounce: NodeJS.Timeout | undefined;
  private discovering: Promise<void> | undefined;

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
    register('svn.revert', (first, selected) => this.runNative('revert', commandUris(first, selected)));
    register('svn.add', (first, selected) => this.runNative('add', commandUris(first, selected)));
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

  private runNative(command: 'update' | 'commit' | 'revert' | 'add', uris: vscode.Uri[]): void {
    const targets = uris.filter(uri => uri.scheme === 'file').map(uri => uri.fsPath);
    if (targets.length === 0) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active?.scheme === 'file') {
        targets.push(active.fsPath);
      }
    }
    this.runNativePaths(command, targets);
  }

  private runNativePaths(
    command: 'update' | 'commit' | 'revert' | 'add',
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
    vscode.workspace.registerTextDocumentContentProvider('svn-working', new SvnDocumentProvider('working'))
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

function pathKey(value: string): string {
  return path.normalize(value).toLocaleLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
