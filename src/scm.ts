import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { WorkspaceExcludes } from './excludes';
import { getSvnNodeKind, getSvnStatus, reassignSvnChangelist, setSvnChangelist, SvnStatusEntry } from './svn';

export function createVirtualDocumentUri(scheme: string, file: vscode.Uri): vscode.Uri {
  const query = `path=${encodeURIComponent(file.fsPath)}&version=${Date.now()}`;
  return file.with({ scheme, query });
}

type StoredPatchRoots = Record<string, string>;
type IndexedStatus = {
  entry: SvnStatusEntry;
  repository: SvnRepository;
};

const DEFAULT_GROUP_ID = 'changes';
const DEFAULT_GROUP_LABEL = '默认分组';
const PATCH_ROOTS_STORAGE_KEY = 'svn.patches.roots.v1';
const PATCH_VIEW_ID = 'svn.patchView';

export class SvnRepository {
  private statuses = new Map<string, SvnStatusEntry>();
  private hiddenPaths = new Set<string>();
  private running: Promise<void> | undefined;
  private loaded = false;
  private initialized = false;
  private revision = 0;
  private updating: Promise<unknown> = Promise.resolve();

  constructor(
    readonly rootUri: vscode.Uri,
    readonly targets: string[]
  ) {}

  get statusEntries(): readonly SvnStatusEntry[] {
    return [...this.statuses.values()].filter(entry => !this.hiddenPaths.has(pathKey(entry.path)));
  }

  refreshExcludes(): Promise<void> {
    return this.enqueueUpdate(async () => {
      this.revision++;
      await this.updateVisibility(this.statuses, new WorkspaceExcludes(this.targets));
    });
  }

  private async updateVisibility(statuses: Map<string, SvnStatusEntry>, excludes: WorkspaceExcludes): Promise<void> {
    const hidden = await excludes.excludedPaths([...statuses.values()].map(entry => entry.path));
    this.hiddenPaths = new Set([...hidden].map(pathKey));
  }

  /** 最近一次状态查询是否成功。 */
  get ready(): boolean {
    return this.loaded;
  }

  refresh(afterChanges = false): Promise<void> {
    if (this.running) {
      return afterChanges
        ? this.running.catch(() => undefined).then(() => this.refresh())
        : this.running;
    }
    this.running = this.load().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  changeChangelist(targets: readonly string[], changelist: string | undefined): Promise<void> {
    return this.mutateChangelist(
      visible => setSvnChangelist(this.rootUri.fsPath, changelist, visible), targets
    );
  }

  reassignChangelist(from: string, to: string | undefined): Promise<void> {
    const targets = this.statusEntries.filter(entry => entry.changelist === from).map(entry => entry.path);
    return this.mutateChangelist(
      visible => reassignSvnChangelist(this.rootUri.fsPath, from, to, visible), targets, false
    );
  }

  private enqueueUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.updating.then(operation);
    this.updating = result.catch(() => undefined);
    return result;
  }

  private mutateChangelist(
    action: (visible: readonly string[]) => Promise<void>, targets: readonly string[], explicitAssignment = true
  ): Promise<void> {
    return this.enqueueUpdate(async () => {
      this.revision++;
      try {
        const excludes = new WorkspaceExcludes(this.targets);
        const hidden = await excludes.excludedPaths(targets);
        const visible = targets.filter(target => !hidden.has(target));
        try {
          await action(visible);
        } catch (error) {
          await this.loadTargets(targets, explicitAssignment).catch(() => {
            this.loaded = false;
          });
          throw error;
        }
        try {
          await this.loadTargets(targets, explicitAssignment);
        } catch (error) {
          this.loaded = false;
          throw error;
        }
      } finally {
        this.revision++;
      }
    });
  }

  private async resetNewChanges(entries: SvnStatusEntry[], excludes: WorkspaceExcludes): Promise<void> {
    if (!this.initialized) {
      return;
    }
    const hidden = await excludes.excludedPaths(entries.map(entry => entry.path));
    const newChanges = entries.filter(entry => {
      const previous = this.statuses.get(pathKey(entry.path));
      return !hidden.has(entry.path) && entry.changelist && isVersionedChange(entry) &&
        (!previous || !isVersionedChange(previous));
    });
    if (newChanges.length > 0) {
      this.revision++;
      await setSvnChangelist(this.rootUri.fsPath, undefined, newChanges.map(entry => entry.path));
      for (const entry of newChanges) {
        entry.changelist = undefined;
      }
    }
  }

  private async loadTargets(targets: readonly string[], explicitAssignment: boolean): Promise<void> {
    if (targets.length === 0) {
      return;
    }
    const entries = await getSvnStatus(this.rootUri.fsPath, [...targets]);
    const excludes = new WorkspaceExcludes(this.targets);
    if (!explicitAssignment) {
      await this.resetNewChanges(entries, excludes);
    }
    const statuses = new Map(this.statuses);
    for (const target of targets) {
      statuses.delete(pathKey(target));
    }
    for (const entry of entries) {
      statuses.set(pathKey(entry.path), entry);
    }
    await this.updateVisibility(statuses, excludes);
    this.statuses = statuses;
  }

  private async load(): Promise<void> {
    const revision = this.revision;
    let current = false;
    try {
      const entries = await getSvnStatus(this.rootUri.fsPath, this.targets);
      await this.enqueueUpdate(async () => {
        if (revision !== this.revision) {
          return;
        }
        current = true;
        const excludes = new WorkspaceExcludes(this.targets);
        await this.resetNewChanges(entries, excludes);
        const statuses = new Map(entries.map(entry => [pathKey(entry.path), entry]));
        await this.updateVisibility(statuses, excludes);
        this.statuses = statuses;
        this.initialized = true;
        this.loaded = true;
      });
    } catch (error) {
      if (current || revision === this.revision) {
        this.loaded = false;
      }
      throw error;
    }
  }
}

export class SvnSourceControl implements vscode.Disposable, vscode.FileDecorationProvider, vscode.TreeDataProvider<PatchTreeItem> {
  readonly sourceControl: vscode.SourceControl;
  readonly changes: vscode.SourceControlResourceGroup;
  private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationEmitter.event;
  private readonly patchEmitter = new vscode.EventEmitter<PatchTreeItem | undefined>();
  readonly onDidChangeTreeData = this.patchEmitter.event;
  private readonly decorationRegistration: vscode.Disposable;
  private readonly patchView: vscode.TreeView<PatchTreeItem>;
  private readonly resourceGroups = new Map<string, vscode.SourceControlResourceGroup>();
  private readonly changelistGroups = new Map<string, vscode.SourceControlResourceGroup>();
  private groupOperation: Promise<unknown> = Promise.resolve();
  private readonly patchDirectory: vscode.Uri;
  private readonly patchRoots: Map<string, string>;
  private patchItems: PatchTreeItem[] = [];
  private repositories: SvnRepository[] = [];
  private statuses = new Map<string, IndexedStatus>();

  constructor(
    private readonly patchState: vscode.Memento,
    patchDirectory: vscode.Uri
  ) {
    this.patchDirectory = patchDirectory;
    this.patchRoots = new Map(Object.entries(
      sanitizePatchRoots(patchState.get<StoredPatchRoots>(PATCH_ROOTS_STORAGE_KEY))));
    this.sourceControl = vscode.scm.createSourceControl('svn', '更改');
    this.changes = this.sourceControl.createResourceGroup(DEFAULT_GROUP_ID, DEFAULT_GROUP_LABEL);
    this.resourceGroups.set(DEFAULT_GROUP_ID, this.changes);
    this.sourceControl.inputBox.visible = false;
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: uri => {
        if (uri.scheme !== 'file' || !this.repositoryForUri(uri)) {
          return undefined;
        }
        const entry = this.statusFor(uri);
        return entry && isVersionedChange(entry)
          ? createVirtualDocumentUri('svn-base', uri)
          : undefined;
      }
    };
    this.decorationRegistration = vscode.window.registerFileDecorationProvider(this);
    this.patchView = vscode.window.createTreeView(PATCH_VIEW_ID, {
      treeDataProvider: this,
      showCollapseAll: false
    });
  }

  get statusEntries(): readonly SvnStatusEntry[] {
    return [...this.statuses.values()].map(value => value.entry)
      .filter(entry => entry.item === 'unversioned' || isVersionedChange(entry));
  }

  getTreeItem(element: PatchTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): PatchTreeItem[] {
    return this.patchItems;
  }

  async refreshPatches(): Promise<void> {
    await fs.mkdir(this.patchDirectory.fsPath, { recursive: true });
    const entries = await fs.readdir(this.patchDirectory.fsPath, { withFileTypes: true });
    const files = entries
      .filter(entry => entry.isFile() && isPatchFile(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
    const fileNames = new Set(files);
    for (const fileName of [...this.patchRoots.keys()]) {
      if (!fileNames.has(fileName)) {
        this.patchRoots.delete(fileName);
      }
    }
    this.patchItems = files.map(fileName => new PatchTreeItem(
      vscode.Uri.file(path.join(this.patchDirectory.fsPath, fileName)),
      this.patchRoots.get(fileName)
    ));
    this.patchView.badge = files.length > 0
      ? { value: files.length, tooltip: `${files.length} 个 Patch 文件` }
      : undefined;
    this.patchEmitter.fire(undefined);
    await this.persistPatchRoots();
  }

  patchRoot(uri: vscode.Uri): string | undefined {
    return this.patchRoots.get(path.basename(uri.fsPath));
  }

  get repositoryRoots(): readonly string[] {
    return this.repositories.map(repository => repository.rootUri.fsPath);
  }

  patchFileUri(fileName: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.patchDirectory.fsPath, fileName));
  }

  isPatchUri(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && pathKey(path.dirname(uri.fsPath)) === pathKey(this.patchDirectory.fsPath) &&
      isPatchFile(path.basename(uri.fsPath));
  }

  async rememberPatch(uri: vscode.Uri, rootPath: string): Promise<void> {
    this.patchRoots.set(path.basename(uri.fsPath), path.normalize(rootPath));
    await this.persistPatchRoots();
  }

  async forgetPatch(uri: vscode.Uri): Promise<void> {
    this.patchRoots.delete(path.basename(uri.fsPath));
    await this.persistPatchRoots();
  }

  get groups(): readonly vscode.SourceControlResourceGroup[] {
    return [this.changes, ...this.changelistGroups.values()];
  }

  async setRepositories(repositories: readonly SvnRepository[]): Promise<void> {
    this.repositories = [...repositories]
      .sort((left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length);
    this.update();
  }

  update(): void {
    const nextStatuses = new Map<string, IndexedStatus>();
    const repositories = [...this.repositories]
      .sort((left, right) => left.rootUri.fsPath.length - right.rootUri.fsPath.length);
    for (const repository of repositories) {
      for (const entry of repository.statusEntries) {
        nextStatuses.set(pathKey(entry.path), { entry, repository });
      }
    }

    const changedDecorations = changedStatusUris(this.statuses, nextStatuses);
    this.statuses = nextStatuses;
    this.updateResourceGroups();
    if (changedDecorations.length > 0) {
      this.decorationEmitter.fire(changedDecorations);
    }
  }

  statusFor(uri: vscode.Uri): SvnStatusEntry | undefined {
    return this.statuses.get(pathKey(uri.fsPath))?.entry;
  }

  repositoryForUri(uri: vscode.Uri): SvnRepository | undefined {
    const indexed = this.statuses.get(pathKey(uri.fsPath));
    if (indexed) {
      return indexed.repository;
    }
    return this.repositories.find(repository =>
      isSameOrParentPath(repository.rootUri.fsPath, uri.fsPath));
  }

  resourceGroup(value: unknown): vscode.SourceControlResourceGroup | undefined {
    if (!value || typeof value !== 'object' || !('id' in value)) {
      return undefined;
    }
    const group = this.resourceGroups.get(String((value as { id: unknown }).id));
    return group === value ? group : undefined;
  }

  groupLabel(group: vscode.SourceControlResourceGroup): string {
    return group.label;
  }

  groupTargets(group: vscode.SourceControlResourceGroup): string[] {
    return group.resourceStates.map(state => state.resourceUri.fsPath);
  }

  createGroup(label: string, uris: readonly vscode.Uri[]): Promise<vscode.SourceControlResourceGroup> {
    return this.enqueueGroupOperation(async () => {
      const normalized = this.validatedGroupLabel(label);
      await this.applyChangelist(this.relatedChanges(uris), normalized);
      const group = this.changelistGroups.get(normalized);
      if (!group) {
        throw new Error('没有可加入 changelist 的版本化文件，不能创建空分组。');
      }
      return group;
    });
  }

  renameGroup(group: vscode.SourceControlResourceGroup, label: string): Promise<void> {
    return this.enqueueGroupOperation(async () => {
      const current = this.changelistGroupName(group);
      if (current === undefined) {
        throw new Error('请选择一个现有 SVN changelist，默认分组不能重命名。');
      }
      const next = this.validatedGroupLabel(label, group.id);
      if (next !== current) {
        await this.reassignChangelist(current, next);
      }
    });
  }

  deleteGroup(group: vscode.SourceControlResourceGroup): Promise<void> {
    return this.enqueueGroupOperation(async () => {
      const current = this.changelistGroupName(group);
      if (current === undefined) {
        throw new Error('请选择一个现有 SVN changelist，默认分组不能删除。');
      }
      await this.reassignChangelist(current, undefined);
    });
  }

  moveResources(uris: readonly vscode.Uri[], group: vscode.SourceControlResourceGroup): Promise<void> {
    return this.enqueueGroupOperation(async () => {
      if (this.resourceGroups.get(group.id) !== group) {
        throw new Error('目标分组不存在。');
      }
      const changelist = group.id === DEFAULT_GROUP_ID ? undefined : this.changelistGroupName(group);
      await this.applyChangelist(this.relatedChanges(uris), changelist);
    });
  }

  findGroupByLabel(label: string): vscode.SourceControlResourceGroup | undefined {
    return this.changelistGroups.get(label) ?? (label === DEFAULT_GROUP_LABEL ? this.changes : undefined);
  }

  private enqueueGroupOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.groupOperation.then(operation);
    this.groupOperation = result.catch(() => undefined);
    return result;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file' || !this.repositoryForUri(uri)) {
      return undefined;
    }
    const entry = this.statusFor(uri);
    if (!entry || !isVersionedChange(entry)) {
      return undefined;
    }
    const presentation = statusPresentation(entry.item, entry.props);
    return {
      badge: presentation.badge,
      tooltip: `SVN：${presentation.tooltip}`,
      color: new vscode.ThemeColor(presentation.color),
      propagate: false
    };
  }

  dispose(): void {
    this.patchView.dispose();
    this.patchEmitter.dispose();
    this.decorationRegistration.dispose();
    this.decorationEmitter.dispose();
    this.sourceControl.dispose();
  }

  private relatedChanges(uris: readonly vscode.Uri[]): IndexedStatus[] {
    const selectedPaths = uris
      .map(uri => path.normalize(uri.fsPath))
      .filter(filePath => this.statuses.has(pathKey(filePath)));
    if (selectedPaths.length !== uris.length) {
      throw new Error('所选文件不属于当前 SVN 改动。');
    }
    return [...this.statuses.values()]
      .filter(indexed => isVersionedChange(indexed.entry))
      .filter(indexed => selectedPaths.some(selected =>
        isSameOrParentPath(selected, indexed.entry.path)));
  }

  private async applyChangelist(items: readonly IndexedStatus[], changelist: string | undefined): Promise<void> {
    const byRepository = new Map<SvnRepository, SvnStatusEntry[]>();
    for (const { entry, repository } of items) {
      if (repository.ready && entry.changelist === changelist) {
        continue;
      }
      const entries = byRepository.get(repository) ?? [];
      entries.push(entry);
      byRepository.set(repository, entries);
    }
    try {
      for (const [repository, entries] of byRepository) {
        const targets = await withoutDirectories(repository.rootUri.fsPath, entries.map(entry => entry.path));
        if (targets.length > 0) {
          await repository.changeChangelist(targets, changelist);
        }
      }
    } finally {
      this.update();
    }
  }

  private async reassignChangelist(from: string, to: string | undefined): Promise<void> {
    if (this.repositories.some(repository => !repository.ready)) {
      throw new Error('工作副本状态尚未成功加载，请刷新 SVN 状态后重试。');
    }
    try {
      for (const repository of this.repositories) {
        if (repository.statusEntries.some(entry => entry.changelist === from)) {
          await repository.reassignChangelist(from, to);
        }
      }
    } finally {
      this.update();
    }
  }

  private changelistGroupName(group: vscode.SourceControlResourceGroup): string | undefined {
    for (const [name, value] of this.changelistGroups) {
      if (value === group) {
        return name;
      }
    }
    return undefined;
  }

  private groupIdForChangelist(changelist: string): string {
    let group = this.changelistGroups.get(changelist);
    if (!group) {
      const id = this.availableGroupId();
      group = this.sourceControl.createResourceGroup(id, changelist);
      this.resourceGroups.set(id, group);
      this.changelistGroups.set(changelist, group);
    }
    return group.id;
  }

  private updateResourceGroups(): void {
    const statesByGroup = new Map<string, vscode.SourceControlResourceState[]>();
    for (const id of this.resourceGroups.keys()) {
      statesByGroup.set(id, []);
    }
    const names = new Set<string>();
    for (const { entry } of this.statuses.values()) {
      if (entry.changelist) {
        names.add(entry.changelist);
        this.groupIdForChangelist(entry.changelist);
      }
    }
    const entries = this.statusEntries
      .filter(isVersionedChange)
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const entry of entries) {
      const groupId = entry.changelist ? this.groupIdForChangelist(entry.changelist) : DEFAULT_GROUP_ID;
      const states = statesByGroup.get(groupId) ?? [];
      states.push(this.toResourceState(entry));
      statesByGroup.set(groupId, states);
    }
    for (const [name, group] of this.changelistGroups) {
      if (!names.has(name)) {
        this.changelistGroups.delete(name);
        this.resourceGroups.delete(group.id);
        group.dispose();
      }
    }
    for (const [id, group] of this.resourceGroups) {
      group.resourceStates = statesByGroup.get(id) ?? [];
    }
    this.sourceControl.count = entries.length;
  }

  private validatedGroupLabel(label: string, currentId?: string): string {
    const normalized = label.trim();
    if (!normalized) {
      throw new Error('分组名不能为空。');
    }
    const existing = this.changelistGroups.get(normalized);
    if (existing && existing.id !== currentId) {
      throw new Error(`分组“${normalized}”已存在。`);
    }
    return normalized;
  }

  private availableGroupId(): string {
    let id: string;
    do {
      id = `custom-${createGroupId()}`;
    } while (this.resourceGroups.has(id));
    return id;
  }

  private persistPatchRoots(): Thenable<void> {
    return this.patchState.update(
      PATCH_ROOTS_STORAGE_KEY,
      Object.fromEntries(this.patchRoots) satisfies StoredPatchRoots
    );
  }

  private toResourceState(entry: SvnStatusEntry): vscode.SourceControlResourceState {
    const uri = vscode.Uri.file(entry.path);
    const presentation = statusPresentation(entry.item, entry.props);
    return {
      resourceUri: uri,
      command: {
        command: 'svn.diff',
        title: '打开 SVN Diff',
        arguments: [uri]
      },
      contextValue: isConflicted(entry) ? 'svn.conflicted' : 'svn.changed',
      decorations: {
        iconPath: new vscode.ThemeIcon(presentation.icon, new vscode.ThemeColor(presentation.color)),
        tooltip: presentation.tooltip,
        strikeThrough: entry.item === 'deleted' || entry.item === 'missing'
      }
    };
  }
}

class PatchTreeItem extends vscode.TreeItem {
  readonly contextValue = 'svn.patch';
  readonly command: vscode.Command;
  readonly iconPath = new vscode.ThemeIcon('file-code');

  constructor(
    readonly resourceUri: vscode.Uri,
    rootPath: string | undefined
  ) {
    super(path.basename(resourceUri.fsPath), vscode.TreeItemCollapsibleState.None);
    this.description = rootPath ? path.basename(rootPath) : undefined;
    this.tooltip = rootPath
      ? `${resourceUri.fsPath}\n工作副本：${rootPath}`
      : `${resourceUri.fsPath}\n未记录工作副本`;
    this.command = {
      command: 'svn.openPatch',
      title: '打开 Patch',
      arguments: [this]
    };
  }
}

function sanitizePatchRoots(value: unknown): StoredPatchRoots {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const roots: StoredPatchRoots = {};
  for (const [fileName, rootPath] of Object.entries(value)) {
    if (isPatchFile(fileName) && typeof rootPath === 'string' && rootPath.trim()) {
      roots[fileName] = path.normalize(rootPath);
    }
  }
  return roots;
}

function isPatchFile(fileName: string): boolean {
  return /\.(patch|diff)$/i.test(fileName);
}

function createGroupId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isVersionedChange(entry: SvnStatusEntry): boolean {
  if (entry.item === 'unversioned' || entry.item === 'ignored' || entry.item === 'external') {
    return false;
  }
  return !['none', 'normal'].includes(entry.item) || !['none', 'normal'].includes(entry.props);
}

export function isConflicted(entry: SvnStatusEntry): boolean {
  return entry.item === 'conflicted' || entry.props === 'conflicted';
}

function changedStatusUris(
  previous: Map<string, IndexedStatus>,
  current: Map<string, IndexedStatus>
): vscode.Uri[] {
  const changed: vscode.Uri[] = [];
  const keys = new Set([...previous.keys(), ...current.keys()]);
  for (const key of keys) {
    const before = previous.get(key)?.entry;
    const after = current.get(key)?.entry;
    if (before?.item !== after?.item || before?.props !== after?.props) {
      changed.push(vscode.Uri.file((after ?? before)!.path));
    }
  }
  return changed;
}

async function withoutDirectories(cwd: string, targets: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (let offset = 0; offset < targets.length; offset += 16) {
    const batch = targets.slice(offset, offset + 16);
    const directories = await Promise.all(batch.map(async target => {
      try {
        return (await fs.lstat(target)).isDirectory();
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw error;
        }
        return await getSvnNodeKind(cwd, target) === 'dir';
      }
    }));
    files.push(...batch.filter((_, index) => !directories[index]));
  }
  return files;
}

function isSameOrParentPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

type StatusPresentation = {
  badge: string;
  icon: string;
  tooltip: string;
  color: string;
};

function statusPresentation(item: string, props: string): StatusPresentation {
  if (props === 'conflicted') {
    return {
      badge: 'C',
      icon: 'warning',
      tooltip: '属性存在冲突',
      color: 'gitDecoration.conflictingResourceForeground'
    };
  }

  const propertySuffix = props === 'modified' ? '（属性已更改）' : '';
  switch (item) {
    case 'unversioned':
      return { badge: '?', icon: 'question', tooltip: '未加入版本管理', color: 'gitDecoration.untrackedResourceForeground' };
    case 'added':
      return { badge: 'A', icon: 'diff-added', tooltip: `已添加${propertySuffix}`, color: 'gitDecoration.addedResourceForeground' };
    case 'deleted':
      return { badge: 'D', icon: 'diff-removed', tooltip: `已删除${propertySuffix}`, color: 'gitDecoration.deletedResourceForeground' };
    case 'missing':
      return { badge: '!', icon: 'warning', tooltip: `文件缺失${propertySuffix}`, color: 'gitDecoration.deletedResourceForeground' };
    case 'replaced':
      return { badge: 'R', icon: 'replace', tooltip: `已替换${propertySuffix}`, color: 'gitDecoration.modifiedResourceForeground' };
    case 'conflicted':
    case 'obstructed':
      return { badge: 'C', icon: 'warning', tooltip: `存在冲突${propertySuffix}`, color: 'gitDecoration.conflictingResourceForeground' };
    case 'modified':
      return { badge: 'M', icon: 'diff-modified', tooltip: `已修改${propertySuffix}`, color: 'gitDecoration.modifiedResourceForeground' };
    case 'normal':
      if (props === 'modified') {
        return { badge: 'M', icon: 'diff-modified', tooltip: '属性已修改', color: 'gitDecoration.modifiedResourceForeground' };
      }
      break;
  }
  return {
    badge: 'M',
    icon: 'diff-modified',
    tooltip: `SVN 状态：${item}${propertySuffix}`,
    color: 'gitDecoration.modifiedResourceForeground'
  };
}
