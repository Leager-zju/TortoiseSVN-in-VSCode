const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { after, before, test } = require('node:test');
const esbuild = require('esbuild');

const project = path.resolve(__dirname, '..');
let temporary;
let repositoryUrl;
let fixtureNumber = 0;
let failCommand;
let pauseCommand;
let interceptCommand;
let interceptReadDirectory;
let interceptStat;
let configurationProvider;
const contexts = new Map();

class Uri {
  constructor(filePath) {
    this.fsPath = path.normalize(filePath);
    this.scheme = 'file';
  }
  static file(filePath) { return new Uri(filePath); }
  static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
  toString() { return pathToFileURL(this.fsPath).href; }
}

const vscode = {
  Uri,
  EventEmitter: class {
    event() {}
    fire() {}
    dispose() {}
  },
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0 },
  ThemeIcon: class {},
  ThemeColor: class {},
  RelativePattern: class {},
  languages: { registerHoverProvider: () => ({ dispose() {} }) },
  commands: {
    executeCommand: async (command, key, value) => {
      if (command === 'setContext') { contexts.set(key, value); }
    }
  },
  workspace: {
    workspaceFolders: [],
    findFiles: async () => [],
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    getConfiguration: (section, uri) => ({
      get: (key, fallback) => configurationProvider?.(section, key, uri)
        ?? (fallback === 'svn.exe' ? 'svn' : fallback)
    })
  },
  scm: {
    createSourceControl: () => ({
      inputBox: {},
      createResourceGroup: (id, label) => ({ id, label, resourceStates: [], dispose() { this.disposed = true; } }),
      dispose() {}
    })
  },
  window: {
    registerFileDecorationProvider: () => ({ dispose() {} }),
    createTreeView: () => ({ dispose() {} }),
    createTextEditorDecorationType: () => ({ dispose() {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} })
  }
};

const compiled = esbuild.buildSync({
  stdin: {
    contents: fs.readFileSync(path.join(project, 'src/extension.ts'), 'utf8')
      .replace('class RepositoryManager ', 'export class RepositoryManager ')
      + "\nexport * from './scm'; export * from './svn'; export * from './excludes'; export { findWorkingCopyAdminFiles };",
    resolveDir: path.join(project, 'src'),
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode']
}).outputFiles[0].text;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => {
  if (name === 'vscode') { return vscode; }
  if (name === 'node:fs/promises') {
    return {
      ...fs.promises,
      readdir(directory, options) {
        return interceptReadDirectory?.(directory, options) ?? fs.promises.readdir(directory, options);
      },
      stat(file) {
        return interceptStat?.(file) ?? fs.promises.stat(file);
      }
    };
  }
  if (name === 'node:child_process') {
    return {
      ...childProcess,
      execFile(executable, args, options, callback) {
        if (args[0] === 'status') {
          assert.equal(args.includes('--verbose'), false);
        }
        if (interceptCommand?.(args, options, callback)) {
          return;
        }
        if (failCommand?.(args, options)) {
          queueMicrotask(() => callback(new Error('simulated SVN failure'), '', 'simulated SVN failure'));
          return;
        }
        const pause = pauseCommand?.(args, options);
        if (pause) {
          void pause.then(() => childProcess.execFile(executable, args, options, callback));
          return;
        }
        return childProcess.execFile(executable, args, options, callback);
      }
    };
  }
  return require(name);
}, loaded, loaded.exports);
const { RepositoryManager, SvnSourceControl, SvnRepository, getSvnStatus, setSvnChangelist,
  isVersionedChange, WorkspaceExcludes, findWorkingCopyAdminFiles } = loaded.exports;

function svn(cwd, ...args) {
  return childProcess.execFileSync('svn', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function nativeGroup(cwd, file) {
  const { XMLParser } = require('fast-xml-parser');
  const document = new XMLParser().parse(svn(cwd, 'info', '--xml', '--', `${file}@`));
  return document.info.entry['wc-info'].changelist ?? '';
}

class State {
  constructor(initial = {}) { this.data = structuredClone(initial); this.accesses = []; }
  get(name) {
    assert.equal(name.startsWith('svn.resourceGroups.'), false);
    this.accesses.push(name);
    return structuredClone(this.data[name]);
  }
  async update(name, value) {
    assert.equal(name.startsWith('svn.resourceGroups.'), false);
    this.accesses.push(name);
    this.data[name] = structuredClone(value);
  }
}

async function fixture(state = new State(), scope = '.') {
  const root = path.join(temporary, `wc-${++fixtureNumber}`);
  svn(temporary, 'checkout', repositoryUrl, root, '--quiet');
  fs.appendFileSync(path.join(root, 'a.txt'), 'changed\n');
  const repository = new SvnRepository(Uri.file(root), [path.resolve(root, scope)]);
  await repository.refresh();
  const scm = new SvnSourceControl(state, Uri.file(path.join(temporary, 'patches')));
  await scm.setRepositories([repository]);
  return { root, repository, scm, state, uri: file => Uri.file(path.join(root, file)) };
}

function members(scm, label) {
  const group = scm.findGroupByLabel(label);
  return group ? Array.from(scm.groupTargets(group), file => path.basename(file)).sort() : [];
}

async function refresh(fixture) {
  await fixture.repository.refresh();
  fixture.scm.update();
}

function manager() {
  return new RepositoryManager({
    globalState: new State(),
    globalStorageUri: Uri.file(path.join(temporary, 'manager-storage')),
    subscriptions: []
  });
}

async function waitUntil(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) { throw new Error('SCM 状态未能及时发布'); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

before(() => {
  temporary = fs.mkdtempSync(path.join(project, '.svn-compass-test-'));
  const repo = path.join(temporary, 'repository');
  childProcess.execFileSync('svnadmin', ['create', repo], { windowsHide: true });
  repositoryUrl = pathToFileURL(repo).href;
  const seed = path.join(temporary, 'seed');
  svn(temporary, 'checkout', repositoryUrl, seed, '--quiet');
  for (const file of ['a.txt', 'clean.txt', 'name@x.txt', 'dir/nested.txt', 'other/out.txt']) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), 'initial\n');
  }
  svn(seed, 'add', '--force', '.', '--quiet');
  svn(seed, 'commit', '-m', 'test fixture', '--quiet');
});

after(() => {
  failCommand = undefined;
  pauseCommand = undefined;
  interceptCommand = undefined;
  if (temporary && process.env.SVN_TEST_KEEP_TEMP !== '1') {
    fs.rmSync(temporary, { recursive: true, force: true });
  } else if (temporary) {
    console.log(`保留 SVN 测试目录：${temporary}`);
  }
});

test('native changelist status remains visible in SCM and svn status', async () => {
  const f = await fixture();
  await setSvnChangelist(f.root, '中文 & 分组', [f.uri('a.txt').fsPath]);
  await refresh(f);
  assert.equal(f.scm.statusFor(f.uri('a.txt')).changelist, '中文 & 分组');
  assert.deepEqual(members(f.scm, '中文 & 分组'), ['a.txt']);
  assert.match(svn(f.root, 'status'), /--- Changelist '/);
  assert.equal(f.scm.statusEntries.some(entry => entry.path.endsWith('clean.txt')), false);
});

test('default group never creates a changelist and moving back only removes an association', async () => {
  const f = await fixture();
  assert.deepEqual(members(f.scm, '默认分组'), ['a.txt']);
  assert.equal(nativeGroup(f.root, 'a.txt'), '');
  let writes = 0;
  failCommand = args => {
    if (args[0] === 'changelist') { writes++; }
    return false;
  };
  try {
    await f.scm.moveResources([f.uri('a.txt')], f.scm.changes);
    assert.equal(writes, 0);
    const group = await f.scm.createGroup('自定义', [f.uri('a.txt')]);
    assert.equal(nativeGroup(f.root, 'a.txt'), '自定义');
    await f.scm.moveResources([f.uri('a.txt')], f.scm.changes);
    assert.equal(nativeGroup(f.root, 'a.txt'), '');
    assert.deepEqual(members(f.scm, '默认分组'), ['a.txt']);
    assert.equal(f.scm.resourceGroup(group), undefined);
    assert.equal(writes, 2);
  } finally {
    failCommand = undefined;
  }
});

test('failed status queries retain file markers and groups until the next successful refresh', async () => {
  const f = await fixture();
  await f.scm.createGroup('查询前分组', [f.uri('a.txt')]);
  const before = f.repository.statusEntries;
  failCommand = args => args[0] === 'status';
  try {
    await assert.rejects(f.repository.refresh(), /simulated/);
    f.scm.update();
    assert.equal(f.repository.ready, false);
    assert.deepEqual(f.repository.statusEntries, before);
    assert.deepEqual(members(f.scm, '查询前分组'), ['a.txt']);
    assert.equal(f.scm.provideFileDecoration(f.uri('a.txt')).badge, 'M');
  } finally {
    failCommand = undefined;
  }
  svn(f.root, 'changelist', '--remove', 'a.txt');
  await refresh(f);
  assert.equal(f.repository.ready, true);
  assert.deepEqual(members(f.scm, '默认分组'), ['a.txt']);
  assert.equal(f.scm.findGroupByLabel('查询前分组'), undefined);
});

test('create, move, rename and delete update native associations without changing file content', async () => {
  const f = await fixture();
  fs.appendFileSync(f.uri('name@x.txt').fsPath, 'modified\n');
  await refresh(f);
  const group = await f.scm.createGroup('-分组 @ 名称', [f.uri('a.txt'), f.uri('name@x.txt')]);
  assert.deepEqual(members(f.scm, group.label), ['a.txt', 'name@x.txt']);
  const next = await f.scm.createGroup('另一组', [f.uri('a.txt')]);
  await f.scm.moveResources([f.uri('name@x.txt')], next);
  assert.equal(f.scm.findGroupByLabel(group.label), undefined);
  await f.scm.renameGroup(next, '重命名');
  assert.deepEqual(members(f.scm, '重命名'), ['a.txt', 'name@x.txt']);
  await f.scm.moveResources([f.uri('name@x.txt')], f.scm.changes);
  assert.equal(nativeGroup(f.root, 'name@x.txt'), '');
  await f.scm.deleteGroup(f.scm.findGroupByLabel('重命名'));
  assert.equal(f.scm.findGroupByLabel('重命名'), undefined);
  assert.equal(nativeGroup(f.root, 'a.txt'), '');
  assert.equal(fs.readFileSync(f.uri('a.txt').fsPath, 'utf8'), 'initial\nchanged\n');
});

test('empty and directory-only creation do not invent native groups', async () => {
  const f = await fixture();
  await assert.rejects(f.scm.createGroup('空组', []), /不能创建空分组/);
  svn(f.root, 'propset', 'test-property', 'value', 'dir');
  await refresh(f);
  await assert.rejects(f.scm.createGroup('目录组', [f.uri('dir')]), /不能创建空分组/);
  assert.deepEqual(f.scm.groups.map(group => group.label), ['默认分组']);
  assert.equal(nativeGroup(f.root, 'dir/nested.txt'), '');
});

test('legacy storage is never read, restored, migrated or written', async () => {
  const legacy = {
    'svn.resourceGroups.global.v2': {
      version: 2,
      groups: [{ id: 'custom-legacy', label: '旧分组' }],
      assignments: { 'a.txt': 'custom-legacy' },
      migratedRepositories: []
    },
    'svn.resourceGroups.old-repository': { groups: [{ id: 'custom-old', label: '更旧分组' }] }
  };
  const f = await fixture(new State(legacy));
  await refresh(f);
  assert.deepEqual(f.scm.groups.map(group => group.label), ['默认分组']);
  assert.equal(nativeGroup(f.root, 'a.txt'), '');
  const created = await f.scm.createGroup('原生', [f.uri('a.txt')]);
  await f.scm.renameGroup(created, '原生重命名');
  await f.scm.deleteGroup(f.scm.findGroupByLabel('原生重命名'));
  assert.deepEqual(f.state.data, legacy);
  assert.deepEqual(f.state.accesses, ['svn.patches.roots.v1']);
  for (const file of ['scm.ts', 'extension.ts']) {
    const source = fs.readFileSync(path.join(project, 'src', file), 'utf8');
    assert.doesNotMatch(source, /workspaceState|StoredGroup|persistGroups|migrateLegacyAssignments|svn\.resourceGroups/);
  }
});

test('native groups survive a new SCM instance without any saved group state', async () => {
  const f = await fixture();
  await f.scm.createGroup('工作副本保存', [f.uri('a.txt')]);
  f.scm.dispose();
  const state = new State();
  const next = new SvnSourceControl(state, Uri.file(path.join(temporary, 'patches')));
  await next.setRepositories([f.repository]);
  assert.deepEqual(members(next, '工作副本保存'), ['a.txt']);
  assert.deepEqual(state.data, {});
});

test('unchanged native members keep a changelist selectable without appearing as changes', async () => {
  const f = await fixture();
  await setSvnChangelist(f.root, '未修改成员', [f.uri('clean.txt').fsPath]);
  await refresh(f);
  const group = f.scm.findGroupByLabel('未修改成员');
  assert.ok(group);
  assert.deepEqual(f.scm.groupTargets(group), []);
  assert.equal(f.scm.sourceControl.count, 1);
  await f.scm.moveResources([f.uri('a.txt')], group);
  svn(f.root, 'revert', 'a.txt');
  await refresh(f);
  assert.ok(f.scm.findGroupByLabel('未修改成员'));
  assert.deepEqual(members(f.scm, '未修改成员'), []);
  assert.equal(f.scm.sourceControl.count, 0);
  await f.scm.deleteGroup(f.scm.findGroupByLabel('未修改成员'));
  assert.equal(f.scm.findGroupByLabel('未修改成员'), undefined);
  assert.equal(nativeGroup(f.root, 'clean.txt'), '');
});

test('native names are case-sensitive and a default-label changelist remains distinct', async () => {
  const f = await fixture();
  fs.appendFileSync(f.uri('name@x.txt').fsPath, 'changed\n');
  await refresh(f);
  const upper = await f.scm.createGroup('Feature', [f.uri('a.txt')]);
  const lower = await f.scm.createGroup('feature', [f.uri('name@x.txt')]);
  assert.notEqual(upper, lower);
  await assert.rejects(f.scm.renameGroup(lower, 'Feature'), /已存在/);
  await f.scm.renameGroup(lower, '默认分组');
  const named = f.scm.findGroupByLabel('默认分组');
  assert.notEqual(named, f.scm.changes);
  assert.equal(f.scm.groups.filter(group => group.label === '默认分组').length, 2);
  await f.scm.moveResources([f.uri('a.txt')], named);
  assert.equal(nativeGroup(f.root, 'a.txt'), '默认分组');
  await f.scm.moveResources([f.uri('a.txt')], f.scm.changes);
  assert.equal(nativeGroup(f.root, 'a.txt'), '');
});

test('directory selection groups files only, including files deleted with their parent', async () => {
  const f = await fixture();
  svn(f.root, 'propset', 'test-property', 'value', 'dir');
  fs.appendFileSync(f.uri('dir/nested.txt').fsPath, 'changed\n');
  await refresh(f);
  const group = await f.scm.createGroup('目录选择', [f.uri('dir')]);
  assert.deepEqual(members(f.scm, group.label), ['nested.txt']);
  assert.ok(members(f.scm, '默认分组').includes('dir'));
  svn(f.root, 'delete', '--force', 'dir');
  await refresh(f);
  await f.scm.moveResources([f.uri('dir')], f.scm.changes);
  assert.equal(nativeGroup(f.root, 'dir/nested.txt'), '');
});

test('rename covers unchanged members and respects the workspace scope', async () => {
  const f = await fixture(new State(), 'dir');
  fs.appendFileSync(f.uri('dir/nested.txt').fsPath, 'changed\n');
  await refresh(f);
  await setSvnChangelist(f.root, '同名组', [f.uri('dir/nested.txt').fsPath, f.uri('other/out.txt').fsPath]);
  await refresh(f);
  await f.scm.renameGroup(f.scm.findGroupByLabel('同名组'), '新分组');
  assert.equal(nativeGroup(f.root, 'dir/nested.txt'), '新分组');
  assert.equal(nativeGroup(f.root, 'other/out.txt'), '同名组');
  await f.scm.deleteGroup(f.scm.findGroupByLabel('新分组'));
  assert.equal(nativeGroup(f.root, 'dir/nested.txt'), '');
  assert.equal(nativeGroup(f.root, 'other/out.txt'), '同名组');
});

test('external removal of the last member removes the group on refresh', async () => {
  const f = await fixture();
  await setSvnChangelist(f.root, '外部', [f.uri('a.txt').fsPath]);
  await refresh(f);
  const group = f.scm.findGroupByLabel('外部');
  assert.ok(group);
  svn(f.root, 'changelist', '--remove', 'a.txt');
  await refresh(f);
  assert.equal(f.scm.findGroupByLabel('外部'), undefined);
  assert.equal(group.disposed, true);
  assert.deepEqual(members(f.scm, '默认分组'), ['a.txt']);
});

test('partial multi-working-copy failure displays successful native associations only', async () => {
  const first = await fixture();
  const second = await fixture();
  await first.scm.setRepositories([first.repository, second.repository]);
  failCommand = (args, options) => args[0] === 'changelist' && options.cwd === second.root;
  try {
    await assert.rejects(first.scm.createGroup('部分完成', [first.uri('a.txt'), second.uri('a.txt')]), /simulated/);
  } finally {
    failCommand = undefined;
  }
  assert.equal(first.scm.statusFor(first.uri('a.txt')).changelist, '部分完成');
  assert.equal(first.scm.statusFor(second.uri('a.txt')).changelist, undefined);
  assert.deepEqual(members(first.scm, '部分完成'), ['a.txt']);
  assert.deepEqual(first.state.data, {});
});

test('failed native writes do not leave phantom groups and the queue recovers', async () => {
  const f = await fixture();
  failCommand = args => args[0] === 'changelist';
  try {
    await assert.rejects(f.scm.createGroup('失败组', [f.uri('a.txt')]), /simulated/);
    assert.equal(f.scm.findGroupByLabel('失败组'), undefined);
  } finally {
    failCommand = undefined;
  }
  await f.scm.createGroup('成功组', [f.uri('a.txt')]);
  assert.equal(nativeGroup(f.root, 'a.txt'), '成功组');
});

test('overlapping refresh requests retain changelists changed during a query', async () => {
  const f = await fixture();
  const pending = f.repository.refresh();
  await setSvnChangelist(f.root, '刷新期间', [f.uri('a.txt').fsPath]);
  await f.repository.refresh(true);
  await pending;
  f.scm.update();
  assert.deepEqual(members(f.scm, '刷新期间'), ['a.txt']);
});

test('native user operations are serialized and retain the last requested association', async () => {
  const f = await fixture();
  let release;
  let entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const paused = new Promise(resolve => { entered = resolve; });
  pauseCommand = args => {
    if (args[0] === 'changelist') {
      pauseCommand = undefined;
      entered();
      return barrier;
    }
  };
  const creation = f.scm.createGroup('第一组', [f.uri('a.txt')]);
  await paused;
  const removal = f.scm.moveResources([f.uri('a.txt')], f.scm.changes);
  release();
  await Promise.all([creation, removal]);
  assert.equal(nativeGroup(f.root, 'a.txt'), '');
  assert.equal(f.scm.findGroupByLabel('第一组'), undefined);
});

test('large status queries and changelist writes stay below Windows argument limits', async () => {
  const f = await fixture();
  const file = f.uri('a.txt').fsPath;
  const targets = Array.from({ length: Math.ceil(40000 / file.length) }, () => file);
  let queries = 0;
  let writes = 0;
  failCommand = args => {
    if (args[0] === 'status') { queries++; }
    if (args[0] === 'changelist') { writes++; }
    assert.ok(args.reduce((length, argument) => length + argument.length + 4, 0) < 32767);
    return false;
  };
  try {
    assert.ok((await getSvnStatus(f.root, targets)).length > 0);
    await setSvnChangelist(f.root, '大量文件', targets);
  } finally {
    failCommand = undefined;
  }
  assert.ok(queries > 1);
  assert.ok(writes > 1);
  assert.equal(nativeGroup(f.root, 'a.txt'), '大量文件');
});

test('Patch root persistence remains independent of native changelist operations', async () => {
  const f = await fixture();
  const patch = Uri.file(path.join(temporary, 'patches', 'example.patch'));
  await f.scm.rememberPatch(patch, f.root);
  await f.scm.createGroup('Patch相关改动', [f.uri('a.txt')]);
  assert.equal(f.scm.patchRoot(patch), f.root);
  assert.equal(f.state.data['svn.patches.roots.v1']['example.patch'], f.root);
  await f.scm.forgetPatch(patch);
  assert.deepEqual(f.state.data, { 'svn.patches.roots.v1': {} });
});

test('repeated automatic refreshes publish changes without extending the running query', async () => {
  const f = await fixture();
  const m = manager();
  m.repositories.set(f.root, f.repository);
  await m.sourceControl.setRepositories([f.repository]);
  let queries = 0;
  pauseCommand = args => {
    if (args[0] === 'status') {
      queries++;
      return new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const requests = [];
  const timer = setInterval(() => {
    if (f.repository.running) { requests.push(m.refreshAll()); }
  }, 10);
  try {
    await m.refreshAll();
    assert.equal(queries, 1);
    assert.deepEqual(members(m.sourceControl, '默认分组'), ['a.txt']);
  } finally {
    clearInterval(timer);
    pauseCommand = undefined;
    await Promise.all(requests);
    m.dispose();
  }
});

test('a slow secondary working copy does not block publication of a completed copy', async () => {
  const f = await fixture();
  const m = manager();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = { rootUri: Uri.file(path.join(temporary, 'slow')), statusEntries: [], refresh: () => gate };
  m.repositories.set(f.root, f.repository);
  m.repositories.set('slow', slow);
  await m.sourceControl.setRepositories([f.repository, slow]);
  f.repository.statuses = new Map();
  m.sourceControl.update();
  const running = m.refreshAll();
  try {
    await waitUntil(() => m.sourceControl.changes.resourceStates.length > 0);
    assert.deepEqual(members(m.sourceControl, '默认分组'), ['a.txt']);
  } finally {
    release();
    await running;
    m.dispose();
  }
});

test('root changes are published before nested working-copy discovery completes', async () => {
  const f = await fixture();
  const m = manager();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(f.root) }];
  interceptReadDirectory = (directory, options) => {
    if (directory === path.normalize(f.root) && options?.withFileTypes) {
      return gate.then(() => fs.promises.readdir(directory, options));
    }
  };
  let completed = false;
  const running = m.discoverRepositories().then(() => { completed = true; });
  try {
    await waitUntil(() => m.sourceControl.changes.resourceStates.length > 0);
    assert.equal(completed, false);
    assert.deepEqual(members(m.sourceControl, '默认分组'), ['a.txt']);
  } finally {
    release();
    await running;
    interceptReadDirectory = undefined;
    vscode.workspace.workspaceFolders = [];
    m.dispose();
  }
});

test('group operations only query member paths and leave unrelated changes intact', async () => {
  const f = await fixture();
  fs.appendFileSync(f.uri('name@x.txt').fsPath, 'unrelated\n');
  await refresh(f);
  const queries = [];
  failCommand = args => {
    if (args[0] === 'status') {
      const targets = args.slice(args.indexOf('--') + 1);
      queries.push(targets);
      assert.ok(targets.every(target => target === `${f.uri('a.txt').fsPath}@`));
    }
    return false;
  };
  try {
    const group = await f.scm.createGroup('局部分组', [f.uri('a.txt')]);
    await f.scm.renameGroup(group, '局部改名');
    await f.scm.moveResources([f.uri('a.txt')], f.scm.changes);
    assert.equal(queries.length, 3);
    assert.deepEqual(members(f.scm, '默认分组'), ['a.txt', 'name@x.txt']);
  } finally {
    failCommand = undefined;
  }
});

test('a stale whole-copy result cannot block or overwrite a new local group', async () => {
  const f = await fixture();
  const snapshot = svn(f.root, 'status', '--xml', '--ignore-externals', '--', `${f.root}@`);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  interceptCommand = (args, _, callback) => {
    if (args[0] === 'status' && args.at(-1) === `${f.root}@`) {
      interceptCommand = undefined;
      void gate.then(() => callback(null, snapshot, ''));
      return true;
    }
    return false;
  };
  const running = f.repository.refresh();
  try {
    const creation = f.scm.createGroup('不等全扫描', [f.uri('a.txt')]);
    await Promise.race([
      creation,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('分组仍在等待全扫描')), 5000);
        timer.unref();
      })
    ]);
    assert.deepEqual(members(f.scm, '不等全扫描'), ['a.txt']);
    release();
    await running;
    f.scm.update();
    assert.deepEqual(members(f.scm, '不等全扫描'), ['a.txt']);
    assert.equal(nativeGroup(f.root, 'a.txt'), '不等全扫描');
  } finally {
    release();
    interceptCommand = undefined;
    await running;
  }
});

test('newly added files default to no changelist but explicit grouping survives later saves', async () => {
  const f = await fixture();
  const existing = await f.scm.createGroup('已有分组', [f.uri('a.txt')]);
  fs.writeFileSync(f.uri('new.txt').fsPath, 'new file\n');
  svn(f.root, 'add', 'new.txt');
  await setSvnChangelist(f.root, '已有分组', [f.uri('new.txt').fsPath]);
  await refresh(f);
  assert.equal(f.scm.statusFor(f.uri('new.txt')).item, 'added');
  assert.equal(nativeGroup(f.root, 'new.txt'), '');
  assert.deepEqual(members(f.scm, '默认分组'), ['new.txt']);
  assert.deepEqual(members(f.scm, '已有分组'), ['a.txt']);
  await f.scm.moveResources([f.uri('new.txt')], existing);
  fs.appendFileSync(f.uri('new.txt').fsPath, 'saved again\n');
  await refresh(f);
  assert.equal(nativeGroup(f.root, 'new.txt'), '已有分组');
  assert.deepEqual(members(f.scm, '已有分组'), ['a.txt', 'new.txt']);
});

test('a fresh change to a clean former member returns to the default group', async () => {
  const f = await fixture();
  await setSvnChangelist(f.root, '旧关联', [f.uri('clean.txt').fsPath]);
  await refresh(f);
  fs.appendFileSync(f.uri('clean.txt').fsPath, 'fresh change\n');
  await refresh(f);
  assert.equal(nativeGroup(f.root, 'clean.txt'), '');
  assert.ok(members(f.scm, '默认分组').includes('clean.txt'));
  const group = await f.scm.createGroup('重新手动分组', [f.uri('clean.txt')]);
  fs.appendFileSync(f.uri('clean.txt').fsPath, 'more edits\n');
  await refresh(f);
  assert.deepEqual(members(f.scm, group.label), ['clean.txt']);
});

test('new changes in sibling files never inherit a grouped directory member', async () => {
  const f = await fixture();
  fs.appendFileSync(f.uri('dir/nested.txt').fsPath, 'grouped\n');
  await refresh(f);
  await f.scm.createGroup('目录里的组', [f.uri('dir/nested.txt')]);
  fs.writeFileSync(f.uri('dir/new.txt').fsPath, 'new sibling\n');
  svn(f.root, 'add', 'dir/new.txt');
  await refresh(f);
  assert.deepEqual(members(f.scm, '目录里的组'), ['nested.txt']);
  assert.ok(members(f.scm, '默认分组').includes('new.txt'));
  assert.equal(nativeGroup(f.root, 'dir/new.txt'), '');
});

test('existing native groups are preserved on the initial successful load', async () => {
  const f = await fixture();
  await setSvnChangelist(f.root, '启动前原生组', [f.uri('a.txt').fsPath]);
  const repository = new SvnRepository(Uri.file(f.root), [f.root]);
  await repository.refresh();
  await f.scm.setRepositories([repository]);
  assert.deepEqual(members(f.scm, '启动前原生组'), ['a.txt']);
  assert.equal(nativeGroup(f.root, 'a.txt'), '启动前原生组');
});

test('failed resetting of a fresh change keeps the old known state and retries', async () => {
  const f = await fixture();
  await setSvnChangelist(f.root, '旧关联', [f.uri('clean.txt').fsPath]);
  await refresh(f);
  fs.appendFileSync(f.uri('clean.txt').fsPath, 'fresh\n');
  failCommand = args => args[0] === 'changelist' && args.includes('--remove');
  try {
    await assert.rejects(f.repository.refresh(), /simulated/);
    assert.equal(f.repository.ready, false);
    assert.equal(nativeGroup(f.root, 'clean.txt'), '旧关联');
  } finally {
    failCommand = undefined;
  }
  await refresh(f);
  assert.equal(nativeGroup(f.root, 'clean.txt'), '');
  assert.ok(members(f.scm, '默认分组').includes('clean.txt'));
});

test('a clean member changed during rename returns to default rather than inheriting the new name', async () => {
  const f = await fixture();
  const group = await f.scm.createGroup('改名前', [f.uri('a.txt')]);
  await setSvnChangelist(f.root, '改名前', [f.uri('clean.txt').fsPath]);
  await refresh(f);
  fs.appendFileSync(f.uri('clean.txt').fsPath, 'new change before rename\n');
  await f.scm.renameGroup(group, '改名后');
  assert.equal(nativeGroup(f.root, 'a.txt'), '改名后');
  assert.equal(nativeGroup(f.root, 'clean.txt'), '');
  assert.deepEqual(members(f.scm, '改名后'), ['a.txt']);
  assert.ok(members(f.scm, '默认分组').includes('clean.txt'));
});

test('failed local correction does not silently skip a later move back to default', async () => {
  const f = await fixture();
  failCommand = args => args[0] === 'status';
  try {
    await assert.rejects(f.scm.createGroup('已写入但查询失败', [f.uri('a.txt')]), /simulated/);
    assert.equal(f.repository.ready, false);
    assert.equal(nativeGroup(f.root, 'a.txt'), '已写入但查询失败');
    assert.deepEqual(members(f.scm, '默认分组'), ['a.txt']);
  } finally {
    failCommand = undefined;
  }
  await f.scm.moveResources([f.uri('a.txt')], f.scm.changes);
  assert.equal(nativeGroup(f.root, 'a.txt'), '');
  await refresh(f);
  assert.equal(f.repository.ready, true);
});

test('partial changes inside a failed command are reconciled using member paths', async () => {
  const f = await fixture();
  fs.appendFileSync(f.uri('name@x.txt').fsPath, 'second file\n');
  await refresh(f);
  interceptCommand = (args, _, callback) => {
    if (args[0] === 'changelist') {
      interceptCommand = undefined;
      svn(f.root, 'changelist', '部分写入', '--', `${f.uri('a.txt').fsPath}@`);
      queueMicrotask(() => callback(new Error('partial failure'), '', 'partial failure'));
      return true;
    }
    return false;
  };
  try {
    await assert.rejects(f.scm.createGroup('部分写入', [f.uri('a.txt'), f.uri('name@x.txt')]), /partial failure/);
    assert.deepEqual(members(f.scm, '部分写入'), ['a.txt']);
    assert.ok(members(f.scm, '默认分组').includes('name@x.txt'));
  } finally {
    interceptCommand = undefined;
  }
});

test('workspace exclusion globs, false values, ancestors and Windows casing match correctly', async () => {
  const f = await fixture();
  configurationProvider = (section, key) => key === 'exclude'
    ? section === 'files' ? { 'dir': true, '**/*.tmp': true, '**/{cache,build}/**': true,
      '**/enabled/**': true, '**/kept/**': false } : { '**/enabled/**': false, '**/other/**': true }
    : undefined;
  try {
    const rules = new WorkspaceExcludes([f.root]);
    assert.equal(await rules.isExcluded(f.uri('dir/nested.txt').fsPath), true);
    assert.equal(await rules.isExcluded(f.uri('nested/a.tmp').fsPath), true);
    assert.equal(await rules.isExcluded(f.uri('cache/sub/file.txt').fsPath), true);
    assert.equal(await rules.isExcluded(f.uri('build').fsPath), true);
    assert.equal(await rules.isExcluded(f.uri('kept/file.txt').fsPath), false);
    assert.equal(await rules.isExcluded(f.uri('enabled/file.txt').fsPath), false);
    assert.equal(await rules.isExcluded(f.uri('other/out.txt').fsPath), true);
    assert.equal(await rules.isExcluded(f.root), false);
    assert.equal(await rules.isExcluded(f.uri('.svn/wc.db').fsPath), true);
    if (process.platform === 'win32') {
      assert.equal(await rules.isExcluded(f.uri('DIR/nested.txt').fsPath.toUpperCase()), true);
      assert.equal(await rules.isExcluded(f.uri('a.txt').fsPath.toUpperCase()), false);
    }
  } finally {
    configurationProvider = undefined;
  }
});

test('conditional sibling exclusion uses the basename and caches directory reads', async () => {
  const f = await fixture();
  fs.writeFileSync(f.uri('paired.js').fsPath, 'generated');
  fs.writeFileSync(f.uri('paired.ts').fsPath, 'source');
  fs.writeFileSync(f.uri('standalone.js').fsPath, 'source');
  configurationProvider = (section, key) => section === 'files' && key === 'exclude'
    ? { '**/*.js': { when: '$(basename).ts' } } : undefined;
  let reads = 0;
  interceptReadDirectory = directory => {
    if (path.normalize(directory) === path.normalize(f.root)) { reads++; }
  };
  try {
    const rules = new WorkspaceExcludes([f.root]);
    assert.equal(await rules.isExcluded(f.uri('paired.js').fsPath), true);
    assert.equal(await rules.isExcluded(f.uri('standalone.js').fsPath), false);
    assert.equal(reads, 1);
  } finally {
    configurationProvider = undefined;
    interceptReadDirectory = undefined;
  }
});

test('multi-root rules are relative to the most specific explicitly opened folder', async () => {
  const f = await fixture();
  const g = await fixture();
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(f.root) }, { uri: Uri.file(g.root) },
    { uri: f.uri('dir') }];
  configurationProvider = (section, key, uri) => section === 'files' && key === 'exclude'
    ? uri.fsPath === f.root ? { 'dir': true, 'other': true }
      : uri.fsPath === g.root ? { 'a.txt': true } : {} : undefined;
  try {
    const rules = new WorkspaceExcludes();
    assert.equal(await rules.isExcluded(f.uri('other/out.txt').fsPath), true);
    assert.equal(await rules.isExcluded(f.uri('a.txt').fsPath), false);
    assert.equal(await rules.isExcluded(g.uri('a.txt').fsPath), true);
    assert.equal(await rules.isExcluded(g.uri('other/out.txt').fsPath), false);
    assert.equal(await rules.isExcluded(f.uri('dir/nested.txt').fsPath), false);
  } finally {
    configurationProvider = undefined;
    vscode.workspace.workspaceFolders = [];
  }
});

test('excluded versioned changes, normal members and unversioned paths are not published', async () => {
  const f = await fixture();
  fs.appendFileSync(f.uri('dir/nested.txt').fsPath, 'hidden modification\n');
  svn(f.root, 'propset', 'test-property', 'value', 'dir');
  fs.writeFileSync(f.uri('dir/added.txt').fsPath, 'hidden addition\n');
  svn(f.root, 'add', 'dir/added.txt');
  fs.writeFileSync(f.uri('dir/untracked.txt').fsPath, 'untracked');
  svn(f.root, 'delete', 'other/out.txt');
  await refresh(f);
  const group = await f.scm.createGroup('可见及隐藏', [f.uri('a.txt'), f.uri('dir/nested.txt')]);
  await setSvnChangelist(f.root, group.label, [f.uri('clean.txt').fsPath]);
  await refresh(f);
  configurationProvider = (section, key) => section === 'files' && key === 'exclude'
    ? { '**/dir/**': true, '**/other/**': true, 'clean.txt': true } : undefined;
  try {
    await refresh(f);
    assert.deepEqual(members(f.scm, group.label), ['a.txt']);
    assert.equal(f.scm.sourceControl.count, 1);
    for (const file of ['dir', 'dir/nested.txt', 'dir/added.txt', 'dir/untracked.txt', 'other/out.txt', 'clean.txt']) {
      assert.equal(f.scm.statusFor(f.uri(file)), undefined);
      assert.equal(f.scm.provideFileDecoration(f.uri(file)), undefined);
    }
    assert.equal(nativeGroup(f.root, 'dir/nested.txt'), group.label);
    await f.scm.renameGroup(group, '只改可见');
    assert.equal(nativeGroup(f.root, 'dir/nested.txt'), '可见及隐藏');
    assert.equal(nativeGroup(f.root, 'clean.txt'), '可见及隐藏');
    await f.scm.deleteGroup(f.scm.findGroupByLabel('只改可见'));
    assert.equal(nativeGroup(f.root, 'a.txt'), '');
    assert.equal(nativeGroup(f.root, 'dir/nested.txt'), '可见及隐藏');
  } finally {
    configurationProvider = undefined;
  }
});

test('hidden fresh changes retain native association when exclusions are removed', async () => {
  const f = await fixture();
  await setSvnChangelist(f.root, '隐藏组', [f.uri('clean.txt').fsPath]);
  await refresh(f);
  configurationProvider = (section, key) => section === 'search' && key === 'exclude'
    ? { 'clean.txt': true } : undefined;
  try {
    fs.appendFileSync(f.uri('clean.txt').fsPath, 'new but hidden\n');
    await refresh(f);
    assert.equal(f.scm.statusFor(f.uri('clean.txt')), undefined);
    assert.equal(nativeGroup(f.root, 'clean.txt'), '隐藏组');
    configurationProvider = undefined;
    await f.repository.refreshExcludes();
    f.scm.update();
    assert.deepEqual(members(f.scm, '隐藏组'), ['clean.txt']);
    await refresh(f);
    assert.equal(nativeGroup(f.root, 'clean.txt'), '隐藏组');
  } finally {
    configurationProvider = undefined;
  }
});

test('local writes recheck exclusions and do not touch newly hidden targets', async () => {
  const f = await fixture();
  const group = await f.scm.createGroup('不应改变', [f.uri('a.txt')]);
  configurationProvider = (section, key) => section === 'files' && key === 'exclude'
    ? { 'a.txt': true } : undefined;
  try {
    await f.scm.moveResources([f.uri('a.txt')], f.scm.changes);
    assert.equal(nativeGroup(f.root, 'a.txt'), group.label);
    assert.equal(f.scm.statusFor(f.uri('a.txt')), undefined);
    assert.equal(f.scm.findGroupByLabel(group.label), undefined);
  } finally {
    configurationProvider = undefined;
  }
});

test('native discovery prunes excluded subtrees but still identifies visible .svn roots', async () => {
  const f = await fixture();
  const hiddenRoot = f.uri('other/hidden-wc').fsPath;
  const visibleRoot = f.uri('visible-wc').fsPath;
  svn(f.root, 'checkout', repositoryUrl, hiddenRoot, '--quiet');
  svn(f.root, 'checkout', repositoryUrl, visibleRoot, '--quiet');
  configurationProvider = (section, key) => key === 'exclude'
    ? section === 'files' ? { '**/.svn': true, '**/other/**': true } : { '**/dir/**': true }
    : undefined;
  const reads = [];
  interceptReadDirectory = (directory, options) => {
    if (options?.withFileTypes) { reads.push(path.normalize(directory)); }
  };
  try {
    const scan = await findWorkingCopyAdminFiles(f.root, () => undefined);
    assert.equal(scan.errors, 0);
    assert.ok(scan.adminFiles.includes(path.join(f.root, '.svn', 'wc.db')));
    assert.ok(scan.adminFiles.includes(path.join(visibleRoot, '.svn', 'wc.db')));
    assert.equal(scan.adminFiles.includes(path.join(hiddenRoot, '.svn', 'wc.db')), false);
    assert.ok(reads.every(directory => path.relative(f.root, directory).split(path.sep)
      .every(segment => !['other', 'dir', '.svn'].includes(segment))));
    assert.equal(scan.scannedDirectories, reads.length);
  } finally {
    configurationProvider = undefined;
    interceptReadDirectory = undefined;
  }
});

test('discovery performs one status query per root and never uses an unfiltered second search', async () => {
  const f = await fixture();
  const m = manager();
  const previous = vscode.workspace.findFiles;
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(f.root) }];
  vscode.workspace.findFiles = () => { throw new Error('duplicate discovery search'); };
  let queries = 0;
  failCommand = args => {
    if (args[0] === 'status') { queries++; }
    return false;
  };
  try {
    await m.discoverRepositories();
    assert.equal(queries, 1);
    assert.deepEqual(members(m.sourceControl, '默认分组'), ['a.txt']);
  } finally {
    failCommand = undefined;
    vscode.workspace.findFiles = previous;
    vscode.workspace.workspaceFolders = [];
    m.dispose();
  }
});

test('configuration reprojection clears SCM contexts and restores native grouping without mutations', async () => {
  const f = await fixture();
  const m = manager();
  await f.scm.createGroup('可恢复组', [f.uri('a.txt')]);
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(f.root) }];
  try {
    await m.discoverRepositories();
    assert.deepEqual(members(m.sourceControl, '可恢复组'), ['a.txt']);
    configurationProvider = (section, key) => section === 'files' && key === 'exclude'
      ? { 'a.txt': true } : undefined;
    await m.refreshExcludes();
    assert.equal(m.sourceControl.sourceControl.count, 0);
    assert.equal(m.sourceControl.provideFileDecoration(f.uri('a.txt')), undefined);
    assert.deepEqual(contexts.get('svn.changedResourcePaths'), []);
    assert.equal(nativeGroup(f.root, 'a.txt'), '可恢复组');
    configurationProvider = undefined;
    await m.refreshExcludes();
    assert.deepEqual(members(m.sourceControl, '可恢复组'), ['a.txt']);
    assert.equal(nativeGroup(f.root, 'a.txt'), '可恢复组');
  } finally {
    configurationProvider = undefined;
    vscode.workspace.workspaceFolders = [];
    m.dispose();
  }
});

test('working-copy root above the opened folder uses folder-relative exclusions', async () => {
  const f = await fixture();
  fs.appendFileSync(f.uri('dir/nested.txt').fsPath, 'change inside opened subfolder\n');
  vscode.workspace.workspaceFolders = [{ uri: f.uri('dir') }];
  configurationProvider = (section, key) => section === 'files' && key === 'exclude'
    ? { 'nested.txt': true } : undefined;
  try {
    const repository = new SvnRepository(Uri.file(f.root), [f.uri('dir').fsPath]);
    await repository.refresh();
    assert.equal(repository.statusEntries.length, 0);
    configurationProvider = undefined;
    await repository.refreshExcludes();
    assert.equal(repository.statusEntries.length, 1);
    assert.equal(repository.statusEntries[0].path, f.uri('dir/nested.txt').fsPath);
  } finally {
    configurationProvider = undefined;
    vscode.workspace.workspaceFolders = [];
  }
});

test('rules changed while conditional matching waits are rechecked before writing', async () => {
  const f = await fixture();
  const group = await f.scm.createGroup('异步排除保护', [f.uri('a.txt')]);
  let unconditional = false;
  configurationProvider = (section, key) => section === 'files' && key === 'exclude'
    ? { 'a.txt': unconditional ? true : { when: 'missing-sibling.txt' } } : undefined;
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  interceptReadDirectory = (directory, options) => {
    if (path.normalize(directory) === path.normalize(f.root) && options === undefined) {
      entered();
      return gate.then(() => fs.promises.readdir(directory));
    }
  };
  const moving = f.scm.moveResources([f.uri('a.txt')], f.scm.changes);
  try {
    await started;
    unconditional = true;
    release();
    await moving;
    assert.equal(nativeGroup(f.root, 'a.txt'), group.label);
    assert.equal(f.scm.statusFor(f.uri('a.txt')), undefined);
  } finally {
    release();
    await moving;
    configurationProvider = undefined;
    interceptReadDirectory = undefined;
  }
});

test('configuration changes during status queries force a new load after projection', async () => {
  const f = await fixture();
  const m = manager();
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(f.root) }];
  await m.discoverRepositories();
  const repository = [...m.repositories.values()][0];
  const snapshot = svn(f.root, 'status', '--xml', '--ignore-externals', '--', `${f.root}@`);
  fs.appendFileSync(f.uri('name@x.txt').fsPath, 'change after snapshot\n');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  interceptCommand = (args, _, callback) => {
    if (args[0] === 'status') {
      interceptCommand = undefined;
      void gate.then(() => callback(null, snapshot, ''));
      return true;
    }
    return false;
  };
  const loading = repository.refresh();
  configurationProvider = (section, key) => section === 'files' && key === 'exclude'
    ? { 'a.txt': true } : undefined;
  const updating = m.refreshExcludes();
  try {
    await waitUntil(() => m.sourceControl.sourceControl.count === 0);
    release();
    await updating;
    await loading;
    assert.deepEqual(members(m.sourceControl, '默认分组'), ['name@x.txt']);
  } finally {
    release();
    await Promise.all([loading, updating]);
    interceptCommand = undefined;
    configurationProvider = undefined;
    vscode.workspace.workspaceFolders = [];
    m.dispose();
  }
});

test('an unreadable nested wc database does not remove an already discovered repository', async () => {
  const f = await fixture();
  const m = manager();
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(temporary) }];
  const nestedKey = process.platform === 'win32' ? f.root.toLowerCase() : f.root;
  m.repositories.set(nestedKey, f.repository);
  await m.sourceControl.setRepositories([f.repository]);
  interceptStat = file => {
    if (path.normalize(file) === path.join(f.root, '.svn', 'wc.db')) {
      const error = Object.assign(new Error('access denied'), { code: 'EACCES' });
      return Promise.reject(error);
    }
  };
  const excludedDirectories = Object.fromEntries(fs.readdirSync(temporary)
    .filter(name => name !== path.basename(f.root)).map(name => [name, true]));
  configurationProvider = (section, key) => section === 'files' && key === 'exclude'
    ? excludedDirectories : undefined;
  try {
    const scan = await findWorkingCopyAdminFiles(f.root, () => undefined);
    assert.equal(scan.errors, 1);
    await m.discoverRepositories();
    assert.equal(m.repositories.get(nestedKey), f.repository);
    assert.deepEqual(members(m.sourceControl, '默认分组'), ['a.txt']);
  } finally {
    interceptStat = undefined;
    configurationProvider = undefined;
    vscode.workspace.workspaceFolders = [];
    m.dispose();
  }
});

test('actual working-copy changes reach SCM resource states and decorations', {
  skip: !process.env.SVN_TEST_TARGET
}, async () => {
  const target = process.env.SVN_TEST_TARGET;
  const m = manager();
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(target) }];
  try {
    await m.discoverRepositories();
    const expected = m.sourceControl.statusEntries.filter(isVersionedChange);
    assert.ok(expected.length > 0);
    const displayed = m.sourceControl.groups.flatMap(group => group.resourceStates);
    assert.equal(displayed.length, expected.length);
    for (const entry of expected) {
      assert.ok(displayed.some(state => state.resourceUri.fsPath === entry.path));
      assert.ok(m.sourceControl.provideFileDecoration(Uri.file(entry.path)));
    }
    console.log(JSON.stringify({ target, repositories: m.repositories.size, displayed: displayed.length,
      defaultGroup: m.sourceControl.changes.resourceStates.length,
      customGroups: m.sourceControl.groups.length - 1 }));
  } finally {
    vscode.workspace.workspaceFolders = [];
    m.dispose();
  }
});
