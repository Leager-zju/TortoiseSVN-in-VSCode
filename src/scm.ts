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

const DEFAULT_GROUP_ID = 'changes';
const DEFAULT_GROUP_LABEL = '默认分组';
const GROUP_STORAGE_PREFIX = 'svn.resourceGroups.';

export class SvnRepository implements vscode.Disposable, vscode.FileDecorationProvider {
  readonly sourceControl: vscode.SourceControl;
  readonly changes: vscode.SourceControlResourceGroup;
  private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationEmitter.event;
  private readonly decorationRegistration: vscode.Disposable;
  private readonly storageKey: string;
  private readonly resourceGroups = new Map<string, vscode.SourceControlResourceGroup>();
  private storedGroups: StoredGroup[];
  private assignments: Record<string, string>;
  private statuses = new Map<string, SvnStatusEntry>();
  private refreshing = false;

  constructor(
    readonly rootUri: vscode.Uri,
    readonly targets: string[],
    private readonly workspaceState: vscode.Memento
  ) {
    this.sourceControl = vscode.scm.createSourceControl('svn', `SVN: ${path.basename(rootUri.fsPath)}`, rootUri);
    this.changes = this.sourceControl.createResourceGroup(DEFAULT_GROUP_ID, DEFAULT_GROUP_LABEL);
    this.resourceGroups.set(DEFAULT_GROUP_ID, this.changes);
    this.storageKey = `${GROUP_STORAGE_PREFIX}${rootUri.toString()}`;
    const stored = workspaceState.get<StoredGroupState>(this.storageKey);
    this.storedGroups = sanitizeStoredGroups(stored?.groups);
    this.assignments = stored?.assignments && typeof stored.assignments === 'object'
      ? { ...stored.assignments }
      : {};
    this.createStoredResourceGroups();
    this.sourceControl.inputBox.placeholder = '提交消息（可选，将预填到 TortoiseSVN）';
    this.sourceControl.acceptInputCommand = {
      command: 'svn.commitScm',
      title: 'SVN 提交',
      arguments: [rootUri]
    };
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: uri => createVirtualDocumentUri('svn-base', uri)
    };
    this.decorationRegistration = vscode.window.registerFileDecorationProvider(this);
  }

  get statusEntries(): readonly SvnStatusEntry[] {
    return [...this.statuses.values()];
  }

  get groupLabels(): readonly string[] {
    return [DEFAULT_GROUP_LABEL, ...this.storedGroups.map(group => group.label)];
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
    const stored = { id: `custom-${createGroupId()}`, label: normalized };
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

  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const entries = await getSvnStatus(this.rootUri.fsPath, this.targets);
      const nextStatuses = new Map<string, SvnStatusEntry>();
      for (const entry of entries) {
        nextStatuses.set(pathKey(entry.path), entry);
      }
      const changedDecorations = changedStatusUris(this.statuses, nextStatuses);

      this.statuses = nextStatuses;
      this.updateResourceGroups();
      if (changedDecorations.length > 0) {
        this.decorationEmitter.fire(changedDecorations);
      }
    } finally {
      this.refreshing = false;
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const entry = this.statuses.get(pathKey(uri.fsPath));
    if (!entry) {
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
    this.decorationRegistration.dispose();
    this.decorationEmitter.dispose();
    this.sourceControl.dispose();
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
      throw new Error('所选差异文件不属于同一个 SVN 工作副本。');
    }
    const relatedPaths = [...this.statuses.values()]
      .filter(isVersionedChange)
      .map(entry => entry.path)
      .filter(filePath => selectedPaths.some(selected =>
        isSameOrParentPath(selected, filePath) || isSameOrParentPath(filePath, selected)));
    for (const filePath of relatedPaths) {
      const assignment = this.assignmentKey(filePath);
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
    const entries = [...this.statuses.values()]
      .filter(isVersionedChange)
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const entry of entries) {
      const assignedId = this.assignments[this.assignmentKey(entry.path)];
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

  private assignmentKey(filePath: string): string {
    const relative = path.relative(this.rootUri.fsPath, filePath).replace(/\\/g, '/');
    return process.platform === 'win32' ? relative.toLowerCase() : relative;
  }

  private persistGroups(): Thenable<void> {
    return this.workspaceState.update(this.storageKey, {
      groups: this.storedGroups,
      assignments: this.assignments
    } satisfies StoredGroupState);
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
  previous: Map<string, SvnStatusEntry>,
  current: Map<string, SvnStatusEntry>
): vscode.Uri[] {
  const changed: vscode.Uri[] = [];
  const keys = new Set([...previous.keys(), ...current.keys()]);
  for (const key of keys) {
    const before = previous.get(key);
    const after = current.get(key);
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
