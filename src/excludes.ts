import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const picomatch: (pattern: string, options: { dot: boolean; nocase: boolean; nonegate: boolean }) =>
  (value: string) => boolean = require('picomatch');

type ExcludeValue = boolean | { when?: string };
type Rule = { matches: (value: string) => boolean; when?: string };
type Scope = { root: string; rules: Rule[] };

export class WorkspaceExcludes {
  private readonly scopes: Scope[];
  private readonly configurationKey: string;
  private readonly siblings = new Map<string, Promise<Set<string>>>();
  private readonly results = new Map<string, Promise<boolean>>();

  constructor(private readonly fallbackRoots: readonly string[] = []) {
    const configurations = this.readConfigurations();
    this.configurationKey = JSON.stringify(configurations);
    this.scopes = configurations.map(({ root, values }) => {
      const rules: Rule[] = [];
      for (const [pattern, value] of Object.entries(values)) {
        if (value !== true && (!value || typeof value !== 'object' || typeof value.when !== 'string')) {
          continue;
        }
        rules.push({
          matches: picomatch(pattern.replace(/\\/g, '/'), {
            dot: true, nocase: process.platform === 'win32', nonegate: true
          }),
          when: value === true ? undefined : value.when
        });
      }
      return { root: path.resolve(root), rules };
    }).sort((left, right) => right.root.length - left.root.length);
  }

  seedDirectory(directory: string, names: readonly string[]): void {
    this.siblings.set(path.resolve(directory), Promise.resolve(new Set(names)));
  }

  isExcluded(filePath: string): Promise<boolean> {
    const absolute = path.resolve(filePath);
    let result = this.results.get(absolute);
    if (!result) {
      result = this.match(absolute);
      this.results.set(absolute, result);
    }
    return result;
  }

  async excludedPaths(paths: readonly string[]): Promise<Set<string>> {
    const excluded = new Set<string>();
    for (let offset = 0; offset < paths.length; offset += 64) {
      const batch = paths.slice(offset, offset + 64);
      const matches = await Promise.all(batch.map(file => this.isExcluded(file)));
      batch.forEach((file, index) => {
        if (matches[index]) {
          excluded.add(file);
        }
      });
    }
    if (JSON.stringify(this.readConfigurations()) !== this.configurationKey) {
      return new WorkspaceExcludes(this.fallbackRoots).excludedPaths(paths);
    }
    return excluded;
  }

  private readConfigurations(): Array<{ root: string; values: Record<string, ExcludeValue> }> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.length > 0 ? folders.map(folder => folder.uri.fsPath) : [...this.fallbackRoots];
    return [...new Set(roots)].map(root => {
      const uri = vscode.Uri.file(root);
      return {
        root,
        values: {
          ...vscode.workspace.getConfiguration('files', uri).get<Record<string, ExcludeValue>>('exclude', {}),
          ...vscode.workspace.getConfiguration('search', uri).get<Record<string, ExcludeValue>>('exclude', {})
        }
      };
    });
  }

  private async match(absolute: string): Promise<boolean> {
    const scope = this.scopes.find(item => isInside(item.root, absolute));
    if (!scope) {
      return false;
    }
    let current = absolute;
    while (path.relative(scope.root, current) !== '') {
      if (path.basename(current).toLowerCase() === '.svn') {
        return true;
      }
      const relative = path.relative(scope.root, current).split(path.sep).join('/');
      for (const rule of scope.rules) {
        if (!rule.matches(relative)) {
          continue;
        }
        if (rule.when === undefined) {
          return true;
        }
        const sibling = rule.when.replace(/\$\(basename\)/g, path.parse(current).name);
        const names = await this.directoryNames(path.dirname(current));
        if (names.has(sibling) || process.platform === 'win32' &&
            [...names].some(name => name.toLowerCase() === sibling.toLowerCase())) {
          return true;
        }
      }
      current = path.dirname(current);
    }
    return false;
  }

  private directoryNames(directory: string): Promise<Set<string>> {
    let names = this.siblings.get(directory);
    if (!names) {
      names = fs.readdir(directory).then(entries => new Set(entries)).catch(error => {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          return new Set<string>();
        }
        throw error;
      });
      this.siblings.set(directory, names);
    }
    return names;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
