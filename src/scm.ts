import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getSvnStatus, SvnStatusEntry } from './svn';

export function createVirtualDocumentUri(scheme: string, file: vscode.Uri): vscode.Uri {
  const query = `path=${encodeURIComponent(file.fsPath)}&version=${Date.now()}`;
  return file.with({ scheme, query });
}

type StoredGroup = { id: string; label: string };
type StoredGroupState = {
  groups: StoredGroup[];
  assignments: Record<string, string>;
};
type GlobalStoredGroupState = StoredGroupState & {
  version: 2;
  migratedRepositories: string[];
};
type StoredPatchRoots = Record<string, string>;
type IndexedStatus = {
  entry: SvnStatusEntry;
  repository: SvnRepository;
};

const DEFAULT_GROUP_ID = 'changes';
const DEFAULT_GROUP_LABEL = '默认分组';
const GROUP_STORAGE_PREFIX = 'svn.resourceGroups.';
const GLOBAL_GROUP_STORAGE_KEY = 'svn.resourceGroups.global.v2';
const PATCH_ROOTS_STORAGE_KEY = 'svn.patches.roots.v1';
const PATCH_VIEW_ID = 'svn.patchView';

export class SvnRepository {
  private statuses = new Map<string, SvnStatusEntry>();
  private refreshing = false;

  constructor(
    readonly rootUri: vscode.Uri,
    readonly targets: string[]
  ) {}

  get statusEntries(): readonly SvnStatusEntry[] {
    return [...this.statuses.values()];
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const entries = await getSvnStatus(this.rootUri.fsPath, this.targets);
      this.statuses = new Map(entries.map(entry => [pathKey(entry.path), entry]));
    } catch (error) {
      this.statuses.clear();
      throw error;
    } finally {
      this.refreshing = false;
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
  private readonly patchDirectory: vscode.Uri;
  private readonly patchRoots: Map<string, string>;
  private patchItems: PatchTreeItem[] = [];
  private readonly migratedRepositories: Set<string>;
  private storedGroups: StoredGroup[];
  private assignments: Record<string, string>;
  private repositories: SvnRepository[] = [];
  private statuses = new Map<string, IndexedStatus>();

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly patchState: vscode.Memento,
    patchDirectory: vscode.Uri
  ) {
    this.patchDirectory = patchDirectory;
    this.patchRoots = new Map(Object.entries(
      sanitizePatchRoots(patchState.get<StoredPatchRoots>(PATCH_ROOTS_STORAGE_KEY))));
    this.sourceControl = vscode.scm.createSourceControl('svn', '更改');
    this.changes = this.sourceControl.createResourceGroup(DEFAULT_GROUP_ID, DEFAULT_GROUP_LABEL);
    this.resourceGroups.set(DEFAULT_GROUP_ID, this.changes);
    const stored = workspaceState.get<GlobalStoredGroupState>(GLOBAL_GROUP_STORAGE_KEY);
    this.storedGroups = sanitizeStoredGroups(stored?.groups);
    this.assignments = sanitizeAssignments(stored?.assignments);
    this.migratedRepositories = new Set(stored?.version === 2 ? stored.migratedRepositories : []);
    this.createStoredResourceGroups();
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
    return [...this.statuses.values()].map(value => value.entry);
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

  get groupLabels(): readonly string[] {
    return [DEFAULT_GROUP_LABEL, ...this.storedGroups.map(group => group.label)];
  }

  async setRepositories(repositories: readonly SvnRepository[]): Promise<void> {
    this.repositories = [...repositories]
      .sort((left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length);
    if (this.migrateRepositoryGroups()) {
      await this.persistGroups();
    }
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
    return group.id === DEFAULT_GROUP_ID
      ? DEFAULT_GROUP_LABEL
      : this.storedGroups.find(item => item.id === group.id)?.label ?? group.label;
  }

  groupTargets(group: vscode.SourceControlResourceGroup): string[] {
    return group.resourceStates.map(state => state.resourceUri.fsPath);
  }

  async createGroup(label: string, uris: readonly vscode.Uri[] = []): Promise<vscode.SourceControlResourceGroup> {
    const normalized = this.validatedGroupLabel(label);
    const stored = { id: this.availableGroupId(), label: normalized };
    this.storedGroups.push(stored);
    const group = this.sourceControl.createResourceGroup(stored.id, stored.label);
    this.resourceGroups.set(stored.id, group);
    this.assignResources(uris, group);
    this.updateResourceGroups();
    await this.persistGroups();
    return group;
  }

  async renameGroup(group: vscode.SourceControlResourceGroup, label: string): Promise<void> {
    const stored = this.storedGroups.find(item => item.id === group.id);
    if (!stored) {
      throw new Error('默认分组不能重命名。');
    }
    stored.label = this.validatedGroupLabel(label, group.id);
    group.label = stored.label;
    await this.persistGroups();
  }

  async deleteGroup(group: vscode.SourceControlResourceGroup): Promise<void> {
    const index = this.storedGroups.findIndex(item => item.id === group.id);
    if (index < 0) {
      throw new Error('默认分组不能删除。');
    }
    this.storedGroups.splice(index, 1);
    for (const [file, groupId] of Object.entries(this.assignments)) {
      if (groupId === group.id) {
        delete this.assignments[file];
      }
    }
    group.dispose();
    this.resourceGroups.delete(group.id);
    this.updateResourceGroups();
    await this.persistGroups();
  }

  async moveResources(uris: readonly vscode.Uri[], group: vscode.SourceControlResourceGroup): Promise<void> {
    if (this.resourceGroups.get(group.id) !== group) {
      throw new Error('目标分组不存在。');
    }
    this.assignResources(uris, group);
    this.updateResourceGroups();
    await this.persistGroups();
  }

  findGroupByLabel(label: string): vscode.SourceControlResourceGroup | undefined {
    if (label === DEFAULT_GROUP_LABEL) {
      return this.changes;
    }
    const stored = this.storedGroups.find(group => group.label === label);
    return stored ? this.resourceGroups.get(stored.id) : undefined;
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

  private migrateRepositoryGroups(): boolean {
    let changed = false;
    for (const repository of this.repositories) {
      const repositoryKey = pathKey(repository.rootUri.fsPath);
      if (this.migratedRepositories.has(repositoryKey)) {
        continue;
      }

      const legacy = this.workspaceState.get<StoredGroupState>(
        `${GROUP_STORAGE_PREFIX}${repository.rootUri.toString()}`);
      const idMapping = new Map<string, string>();
      for (const legacyGroup of sanitizeStoredGroups(legacy?.groups)) {
        let stored = this.storedGroups.find(group =>
          group.label.toLocaleLowerCase() === legacyGroup.label.toLocaleLowerCase());
        if (!stored) {
          const id = this.resourceGroups.has(legacyGroup.id)
            ? this.availableGroupId()
            : legacyGroup.id;
          stored = { id, label: legacyGroup.label };
          this.storedGroups.push(stored);
          this.resourceGroups.set(id, this.sourceControl.createResourceGroup(id, stored.label));
        }
        idMapping.set(legacyGroup.id, stored.id);
      }

      for (const [relativePath, legacyGroupId] of Object.entries(sanitizeAssignments(legacy?.assignments))) {
        const groupId = idMapping.get(legacyGroupId);
        if (!groupId) {
          continue;
        }
        const absolutePath = path.resolve(
          repository.rootUri.fsPath,
          relativePath.replace(/\//g, path.sep));
        this.assignments[pathKey(absolutePath)] = groupId;
      }

      this.migratedRepositories.add(repositoryKey);
      changed = true;
    }
    return changed;
  }

  private createStoredResourceGroups(): void {
    for (const stored of this.storedGroups) {
      this.resourceGroups.set(stored.id, this.sourceControl.createResourceGroup(stored.id, stored.label));
    }
  }

  private assignResources(uris: readonly vscode.Uri[], group: vscode.SourceControlResourceGroup): void {
    const selectedPaths = uris
      .map(uri => path.normalize(uri.fsPath))
      .filter(filePath => this.statuses.has(pathKey(filePath)));
    if (selectedPaths.length !== uris.length) {
      throw new Error('所选文件不属于当前 SVN 改动。');
    }
    const relatedPaths = this.statusEntries
      .filter(isVersionedChange)
      .map(entry => entry.path)
      .filter(filePath => selectedPaths.some(selected =>
        isSameOrParentPath(selected, filePath) || isSameOrParentPath(filePath, selected)));
    for (const filePath of relatedPaths) {
      const assignment = pathKey(filePath);
      if (group.id === DEFAULT_GROUP_ID) {
        delete this.assignments[assignment];
      } else {
        this.assignments[assignment] = group.id;
      }
    }
  }

  private updateResourceGroups(): void {
    const statesByGroup = new Map<string, vscode.SourceControlResourceState[]>();
    for (const id of this.resourceGroups.keys()) {
      statesByGroup.set(id, []);
    }
    const entries = this.statusEntries
      .filter(isVersionedChange)
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const entry of entries) {
      const assignedId = this.assignments[pathKey(entry.path)];
      const groupId = assignedId && this.resourceGroups.has(assignedId) ? assignedId : DEFAULT_GROUP_ID;
      statesByGroup.get(groupId)!.push(this.toResourceState(entry));
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
    const duplicate = normalized.toLocaleLowerCase() === DEFAULT_GROUP_LABEL.toLocaleLowerCase() ||
      this.storedGroups.some(group => group.id !== currentId &&
        group.label.toLocaleLowerCase() === normalized.toLocaleLowerCase());
    if (duplicate) {
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

  private persistGroups(): Thenable<void> {
    return this.workspaceState.update(GLOBAL_GROUP_STORAGE_KEY, {
      version: 2,
      groups: this.storedGroups,
      assignments: this.assignments,
      migratedRepositories: [...this.migratedRepositories]
    } satisfies GlobalStoredGroupState);
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
      contextValue: 'svn.changed',
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

function sanitizeStoredGroups(value: unknown): StoredGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>([DEFAULT_GROUP_LABEL.toLocaleLowerCase()]);
  const groups: StoredGroup[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const id = String((item as Partial<StoredGroup>).id ?? '');
    const label = String((item as Partial<StoredGroup>).label ?? '').trim();
    const labelKey = label.toLocaleLowerCase();
    if (!id.startsWith('custom-') || !label || seenIds.has(id) || seenLabels.has(labelKey)) {
      continue;
    }
    seenIds.add(id);
    seenLabels.add(labelKey);
    groups.push({ id, label });
  }
  return groups;
}

function sanitizeAssignments(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const assignments: Record<string, string> = {};
  for (const [filePath, groupId] of Object.entries(value)) {
    if (typeof groupId === 'string' && groupId.startsWith('custom-')) {
      assignments[filePath] = groupId;
    }
  }
  return assignments;
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
