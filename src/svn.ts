import {XMLParser} from 'fast-xml-parser';
import {ChildProcess, execFile, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface SvnStatusEntry {
  path: string;
  item: string;
  props: string;
  revision?: string;
  changelist?: string;
}

export interface SvnLogChangedPath {
  path: string;
  action: string;
  kind?: string;
  textModified?: string;
  propsModified?: string;
  copyFromPath?: string;
  copyFromRevision?: string;
}

export interface SvnLogEntry {
  revision: number;
  author: string;
  date: string;
  message: string;
  changedPaths: SvnLogChangedPath[];
}

export interface SvnLogPage {
  entries: SvnLogEntry[];
  hasMore: boolean;
  nextRevision?: number;
}

export interface SvnTargetInfo {
  url: string;
  repositoryRoot: string;
  relativeUrl: string;
  kind: 'file' | 'dir';
  revision?: string;
}

export interface SvnBlameLine {
  lineNumber: number;
  revision?: number;
  author: string;
  date: string;
}

function asArray<T>(value: T|T[]|undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function svnExecutable(): string {
  return vscode.workspace.getConfiguration('svn').get<string>(
      'path', 'svn.exe');
}

function tortoiseExecutable(): string {
  return vscode.workspace.getConfiguration('svn').get<string>(
      'tortoiseProc.path', 'TortoiseProc.exe');
}

export function runSvn(args: string[], cwd?: string, maxBuffer = 20 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
        svnExecutable(), args,
        {cwd, encoding: 'utf8', maxBuffer, windowsHide: true},
        (error, stdout, stderr) => {
          if (error) {
            const detail = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? error.message
              : String(stderr || stdout || error.message).trim();
            reject(new Error(
                detail ||
                `svn 命令执行失败（退出码 ${error.code ?? '未知'}）`));
            return;
          }
          resolve(String(stdout));
        });
  });
}

export async function findWorkingCopyRoot(targetPath: string):
    Promise<string|undefined> {
  const output = await runSvn(
      ['info', '--show-item', 'wc-root', '--', withPegEscape(targetPath)],
      path.dirname(targetPath));
  const root = output.trim();
  return root || undefined;
}

export async function getSvnStatus(
    rootPath: string, targets: string[]): Promise<SvnStatusEntry[]> {
  const batches = targetBatches(targets);
  if (batches.length > 1) {
    const entries: SvnStatusEntry[] = [];
    for (const batch of batches) {
      entries.push(...await getSvnStatus(rootPath, batch));
    }
    return entries;
  }
  const output = await runSvn(
      ['status', '--xml', '--ignore-externals', '--', ...targets.map(withPegEscape)], rootPath);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false
  });
  type XmlStatusEntry = {
    path?: string;
    'wc-status'?: {item?: string; props?: string; revision?: string};
  };
  type XmlChangelist = {name?: string; entry?: XmlStatusEntry | XmlStatusEntry[]};
  const document = parser.parse(output) as {
    status?: {
      target?: Array<{
        path?: string;
        entry?: XmlStatusEntry | XmlStatusEntry[];
        changelist?: XmlChangelist | XmlChangelist[];
      }>;
      changelist?: XmlChangelist | XmlChangelist[];
    };
  };

  const entries: SvnStatusEntry[] = [];
  const collect = (items: XmlStatusEntry | XmlStatusEntry[] | undefined, changelist?: string): void => {
    for (const entry of asArray(items)) {
      const status = entry['wc-status'];
      if (!entry.path || !status) {
        continue;
      }
      const item = status.item ?? 'none';
      const props = status.props ?? 'none';
      const filePath = path.isAbsolute(entry.path) ? path.normalize(entry.path) :
                                                     path.resolve(rootPath, entry.path);
      if (isSvnAdminPath(filePath) || !changelist && !shouldExposeStatus(item, props)) {
        continue;
      }
      entries.push({
        path: filePath,
        item,
        props,
        revision: status.revision,
        changelist
      });
    }
  };
  // 属于 changelist 的条目不在 <target> 下，而是按 <changelist name="…"> 分块单独输出。
  const collectChangelists = (lists: XmlChangelist | XmlChangelist[] | undefined): void => {
    for (const list of asArray(lists)) {
      const name = list.name === undefined ? '' : String(list.name);
      collect(list.entry, name || undefined);
    }
  };
  for (const target of asArray(document.status?.target)) {
    collect(target.entry);
    collectChangelists(target.changelist);
  }
  collectChangelists(document.status?.changelist);
  return entries;
}

export async function getSvnNodeKind(cwd: string, targetPath: string): Promise<'file' | 'dir'> {
  const output = await runSvn(['info', '--show-item', 'kind', '--', withPegEscape(targetPath)], cwd);
  const kind = output.trim();
  if (kind !== 'file' && kind !== 'dir') {
    throw new Error(`无法确定 SVN 资源类型：${targetPath}`);
  }
  return kind;
}

export async function setSvnChangelist(
    cwd: string, changelist: string | undefined, targets: readonly string[]): Promise<void> {
  for (const batch of targetBatches(targets)) {
    const args = changelist === undefined
      ? ['changelist', '--remove', '--', ...batch.map(withPegEscape)]
      : ['changelist', '--', changelist, ...batch.map(withPegEscape)];
    await runSvn(args, cwd);
  }
}

/**
 * 把 scopes 下所有属于 from 的文件改挂到 to；to 为 undefined 时解除它们的 changelist。
 */
export async function reassignSvnChangelist(
    cwd: string, from: string, to: string | undefined, scopes: readonly string[]): Promise<void> {
  for (const batch of targetBatches(scopes)) {
    const filter = ['changelist', '--changelist', from, '--depth', 'infinity'];
    const args = to === undefined
      ? [...filter, '--remove', '--', ...batch.map(withPegEscape)]
      : [...filter, '--', to, ...batch.map(withPegEscape)];
    await runSvn(args, cwd);
  }
}

const MAX_TARGET_ARGUMENT_LENGTH = 24000;

function targetBatches(targets: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const target of targets) {
    const size = target.length + 4;
    if (current.length > 0 && length + size > MAX_TARGET_ARGUMENT_LENGTH) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(target);
    length += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function isSvnAdminPath(filePath: string): boolean {
  return filePath.split(/[\\/]+/).some(segment => segment.toLocaleLowerCase() === '.svn');
}

function shouldExposeStatus(item: string, props: string): boolean {
  if (item === 'ignored' || item === 'external') {
    return false;
  }
  return item === 'unversioned' || !['none', 'normal'].includes(item) || !['none', 'normal'].includes(props);
}

export async function getSvnTargetInfo(targetPath: string): Promise<SvnTargetInfo> {
  const output = await runSvn(['info', '--xml', '--', withPegEscape(targetPath)], path.dirname(targetPath));
  const document = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false
  }).parse(output) as {
    info?: {
      entry?: {
        kind?: string;
        revision?: string;
        url?: string;
        'relative-url'?: string;
        repository?: { root?: string };
      };
    };
  };
  const entry = document.info?.entry;
  if (!entry?.url || !entry.repository?.root) {
    throw new Error('无法读取该资源的 SVN 仓库信息。');
  }
  return {
    url: entry.url,
    repositoryRoot: entry.repository.root,
    relativeUrl: entry['relative-url'] ?? '',
    kind: entry.kind === 'dir' ? 'dir' : 'file',
    revision: entry.revision
  };
}

export async function getSvnLog(
  targetPath: string,
  startRevision?: number,
  pageSize = 100
): Promise<SvnLogPage> {
  const args = [
    'log',
    '--xml',
    '--verbose',
    '--limit',
    String(pageSize + 1),
    '-r',
    startRevision === undefined ? 'HEAD:1' : `${startRevision}:1`,
    '--',
    withPegEscape(targetPath)
  ];
  const output = await runSvn(args, path.dirname(targetPath));
  const parsed = parseSvnLogEntries(output);
  const hasMore = parsed.length > pageSize;
  const entries = parsed.slice(0, pageSize);
  const lastRevision = entries.at(-1)?.revision;
  return {
    entries,
    hasMore,
    nextRevision: hasMore && lastRevision && lastRevision > 1 ? lastRevision - 1 : undefined
  };
}

export async function getSvnRevisionLog(
  targetPath: string,
  revision: number
): Promise<SvnLogEntry | undefined> {
  if (!Number.isInteger(revision) || revision <= 0) {
    return undefined;
  }
  const output = await runSvn(
    [
      'log',
      '--xml',
      '--verbose',
      '--limit',
      '1',
      '-r',
      `${revision}:${revision}`,
      '--',
      withPegEscape(targetPath)
    ],
    path.dirname(targetPath)
  );
  return parseSvnLogEntries(output)[0];
}

function parseSvnLogEntries(output: string): SvnLogEntry[] {
  const document = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false
  }).parse(output) as {
    log?: {
      logentry?: Array<{
        revision?: string;
        author?: string;
        date?: string;
        msg?: string;
        paths?: {
          path?: Array<string | {
            '#text'?: string;
            action?: string;
            kind?: string;
            'text-mods'?: string;
            'prop-mods'?: string;
            'copyfrom-path'?: string;
            'copyfrom-rev'?: string;
          }>;
        };
      }>;
    };
  };

  return asArray(document.log?.logentry).map(entry => ({
    revision: Number(entry.revision ?? 0),
    author: String(entry.author ?? ''),
    date: String(entry.date ?? ''),
    message: String(entry.msg ?? ''),
    changedPaths: asArray(entry.paths?.path).map(changedPath => {
      if (typeof changedPath === 'string') {
        return { path: changedPath, action: '?' };
      }
      return {
        path: changedPath['#text'] ?? '',
        action: changedPath.action ?? '?',
        kind: changedPath.kind,
        textModified: changedPath['text-mods'],
        propsModified: changedPath['prop-mods'],
        copyFromPath: changedPath['copyfrom-path'],
        copyFromRevision: changedPath['copyfrom-rev']
      };
    })
  })).filter(entry => Number.isFinite(entry.revision) && entry.revision > 0);
}

export async function getSvnBlame(filePath: string): Promise<SvnBlameLine[]> {
  const output = await runSvn(
    ['blame', '--xml', '--force', '--', withPegEscape(filePath)],
    path.dirname(filePath),
    100 * 1024 * 1024
  );
  const document = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false
  }).parse(output) as {
    blame?: {
      target?: {
        entry?: Array<{
          'line-number'?: string;
          commit?: {
            revision?: string;
            author?: string;
            date?: string;
          };
        }>;
      };
    };
  };

  return asArray(document.blame?.target?.entry).map(entry => {
    const revision = Number(entry.commit?.revision);
    return {
      lineNumber: Number(entry['line-number'] ?? 0),
      revision: Number.isFinite(revision) && revision > 0 ? revision : undefined,
      author: String(entry.commit?.author ?? ''),
      date: String(entry.commit?.date ?? '')
    };
  }).filter(entry => Number.isInteger(entry.lineNumber) && entry.lineNumber > 0);
}

export async function getRevisionContent(
  target: string,
  revision: number,
  pegRevision?: number
): Promise<string> {
  const cwd = /^[a-z][a-z\d+.-]*:\/\//i.test(target) ? undefined : path.dirname(target);
  const pegTarget = pegRevision === undefined ? withPegEscape(target) : `${target}@${pegRevision}`;
  return runSvn(['cat', '-r', String(revision), '--', pegTarget], cwd);
}

export async function getRevisionDiff(filePath: string, revision: number): Promise<string> {
  return runSvn(['diff', '-c', String(revision), '--', withPegEscape(filePath)], path.dirname(filePath));
}

/** svn update -r REV：把工作副本中的单个文件更新到指定修订。 */
export async function updateSvnToRevision(filePath: string, revision: number): Promise<string> {
  return runSvn(
    ['update', '-r', String(revision), '--non-interactive', '--accept', 'postpone', '--', withPegEscape(filePath)],
    path.dirname(filePath));
}

/**
 * svn merge 反向合并：
 * - 指定 changeRevision 时为 `-c -REV`，撤销该次提交对文件的修改；
 * - 否则为 `-r FROM:TO`（FROM > TO），撤销 TO 之后到 FROM 为止的全部修改，使内容回到 TO。
 * source 为带 peg 修订的仓库 URL，结果作为本地修改留在工作副本中，需用户自行提交。
 */
export async function reverseMergeSvn(
  filePath: string,
  sourceUrl: string,
  pegRevision: number,
  range: { change: number } | { from: number; to: number }
): Promise<string> {
  const revisionArgs = 'change' in range
    ? ['-c', `-${range.change}`]
    : ['-r', `${range.from}:${range.to}`];
  // merge 的目标 WCPATH 不解析 peg 修订，既不能追加 “@”，也无法直接接受含 “@” 的路径。
  // 这种情况下以所在目录为合并目标（同名文件），语义等价。
  const name = path.basename(filePath);
  const target = name.includes('@') ? '.' : filePath;
  if (target === '.' && decodeURIComponent(sourceUrl.split('/').pop() ?? '') !== name) {
    throw new Error('文件名包含 “@” 且与仓库中的路径不一致，无法安全执行合并，请先提交或还原重命名后再试。');
  }
  return runSvn(
    ['merge', ...revisionArgs, '--non-interactive', '--accept', 'postpone', '--',
      `${sourceUrl}@${pegRevision}`, target],
    path.dirname(filePath));
}

function withPegEscape(targetPath: string): string {
  return `${targetPath}@`;
}

export async function getBaseContent(filePath: string): Promise<string> {
  return runSvn(['cat', '-r', 'BASE', '--', withPegEscape(filePath)], path.dirname(filePath));
}



export async function revertSvnTargets(targets: string[]): Promise<void> {
  if (targets.length === 0) {
    return;
  }
  const cwd = path.dirname(targets[0]);
  await runSvn(['revert', '--', ...targets.map(withPegEscape)], cwd);
}

export type SvnResolveAccept =
    'working'|'base'|'mine-conflict'|'theirs-conflict'|'mine-full'|'theirs-full';

export async function resolveSvnTargets(
    targets: string[], accept: SvnResolveAccept = 'working'): Promise<void> {
  if (targets.length === 0) {
    return;
  }
  const cwd = path.dirname(targets[0]);
  await runSvn(['resolve', '--accept', accept, '--', ...targets.map(withPegEscape)], cwd);
}

export async function createSvnPatch(
  targets: string[],
  patchPath: string,
  cwd: string
): Promise<void> {
  if (targets.length === 0) {
    throw new Error('没有可创建 Patch 的文件。');
  }
  const relativeTargets = targets.map(target =>
    (path.relative(cwd, target) || '.').split(path.sep).join('/'));
  const content = await runSvn(['diff', '--', ...relativeTargets], cwd);
  await fs.writeFile(patchPath, content, 'utf8');
}

export async function applySvnPatch(patchPath: string, cwd: string, strip = 0): Promise<string> {
  return runSvn(strip > 0 ? ['patch', '--strip', String(strip), patchPath] : ['patch', patchPath], cwd);
}

export function launchTortoise(
  command: 'update'|'commit'|'add'|'gfcreatecr'|'conflicteditor', targets: string[]): ChildProcess {
  if (process.platform !== 'win32') {
    throw new Error('TortoiseSVN 原生窗口仅支持 Windows。');
  }
  if (targets.length === 0) {
    throw new Error('没有可操作的文件或目录。');
  }

  const args = [`/command:${command}`, `/path:${targets.join('*')}`];
  return spawn(
      tortoiseExecutable(), args,
      {cwd: path.dirname(targets[0]), stdio: 'ignore', windowsHide: false});
}
