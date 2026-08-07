import {XMLParser} from 'fast-xml-parser';
import {ChildProcess, execFile, spawn} from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface SvnStatusEntry {
  path: string;
  item: string;
  props: string;
  revision?: string;
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

export function runSvn(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
        svnExecutable(), args,
        {cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true},
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || stdout || error.message).trim();
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
  try {
    const output = await runSvn(
        ['info', '--show-item', 'wc-root', '--', targetPath],
        path.dirname(targetPath));
    const root = output.trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

export async function getSvnStatus(
    rootPath: string, targets: string[]): Promise<SvnStatusEntry[]> {
  const output = await runSvn(
      ['status', '--xml', '--ignore-externals', '--', ...targets], rootPath);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false
  });
  const document = parser.parse(output) as {
    status?: {
      target?: Array<{
        path?: string;
        entry?: Array<{
          path?: string;
          'wc-status'?: {item?: string; props?: string; revision?: string};
        }>;
      }>;
    };
  };

  const entries: SvnStatusEntry[] = [];
  for (const target of asArray(document.status?.target)) {
    for (const entry of asArray(target.entry)) {
      const status = entry['wc-status'];
      if (!entry.path || !status) {
        continue;
      }
      const item = status.item ?? 'none';
      const props = status.props ?? 'none';
      if (!isCommittable(item, props)) {
        continue;
      }
      entries.push({
        path: path.isAbsolute(entry.path) ? path.normalize(entry.path) :
                                            path.resolve(rootPath, entry.path),
        item,
        props,
        revision: status.revision
      });
    }
  }
  return entries;
}

function isCommittable(item: string, props: string): boolean {
  const excluded =
      new Set(['none', 'normal', 'unversioned', 'ignored', 'external']);
  return !excluded.has(item) || !excluded.has(props);
}

export async function getBaseContent(filePath: string): Promise<string> {
  return runSvn(['cat', '-r', 'BASE', '--', filePath], path.dirname(filePath));
}

export function launchTortoise(
    command: 'update'|'commit'|'revert'|'add', targets: string[],
    extraArgs: string[] = []): ChildProcess {
  if (process.platform !== 'win32') {
    throw new Error('TortoiseSVN 原生窗口仅支持 Windows。');
  }
  if (targets.length === 0) {
    throw new Error('没有可操作的文件或目录。');
  }

  const args =
      [`/command:${command}`, `/path:${targets.join('*')}`, ...extraArgs];
  return spawn(
      tortoiseExecutable(), args,
      {cwd: path.dirname(targets[0]), stdio: 'ignore', windowsHide: false});
}
