<div align="center">

<img src="resources/icon.png" width="112" alt="SVN Compass" />

# SVN Compass

**在 VS Code 里完成日常 SVN 工作 —— 状态、分组、Diff、日志、Blame、合并，一站搞定。**

面向 Windows 与 TortoiseSVN，原生命令驱动，界面与 Git 体验保持一致。

![version](https://img.shields.io/badge/version-0.3.11-blue)
![vscode](https://img.shields.io/badge/VS%20Code-%E2%89%A51.96-007ACC?logo=visualstudiocode)
![platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows)
![license](https://img.shields.io/badge/license-MIT-green)

[功能一览](#-功能一览) · [快速开始](#-快速开始) · [配置项](#️-配置项) · [常见问题](#-常见问题) · [开发](#️-开发)

</div>

---

## ✨ 功能一览

### 🗂️ 源代码管理侧栏

- **多工作副本聚合**：多根工作区、工作区内的多个（含嵌套）SVN 工作副本统一显示在一个提供器中。
- **原生 changelist 分组**：按“默认分组 / 自定义分组”展示可提交项，分组即 SVN 原生 changelist，与 TortoiseSVN 互通；支持新建、重命名、删除分组，以及按分组提交、回退、创建 Patch / Code Review。
- **树状 / 平铺切换**：切换视图不会改变文件所属分组。
- **遵守排除规则**：`files.exclude` 与 `search.exclude` 中被排除的路径不会出现在侧栏，也不会被分组操作触及。

### 📜 文件日志

跟随当前编辑器，在源代码管理侧栏展示该文件的 SVN 提交时间线。

| 能力 | 说明 |
|---|---|
| 提交时间线 | 自绘时间线串联所有提交，点击提交即可展开 / 收起本次提交的全部变更文件（带 `A` `M` `D` `R` 徽标） |
| 查看更改 | 点击文件打开单文件 Diff；“查看此提交的更改”在多文件 Diff 编辑器中展示整次提交 |
| 状态标记 | 标出 **最新**（仓库中最近一次提交）、**当前**（工作副本所在提交）以及尚未更新到本地的提交 |
| 版本操作 | 右键提交：更新到此版本、回退到此版本、回退该版本的修改（均为 `svn update` / `svn merge` 原生命令） |
| 合并到目标分支 | 选择其他分支的目录，一次 `svn merge -c REV` 合并整次提交；先预演并列出冲突，自动定位嵌套工作副本 |
| 其他 | 与工作副本比较、打开历史版本文件、复制修订号 / 提交信息、分页加载 |

### 🔍 Diff、日志与 Blame

- **Diff**：在 VS Code 内置对比编辑器中打开，支持在 Diff 中回退单个差异块。
- **SVN 日志**：独立页面展示完整历史、作者、日期、提交信息及变更路径，支持筛选、分页、查看修订、修订间比较，以及与工作副本当前版本比较。
- **选中内容历史**：在编辑器中选中一段代码，右键查看逐行 SVN 历史、相关提交与本地未提交行。
- **Blame**：行号右键开启，逐行显示最后修改的作者与时间，再次点击整篇隐藏；悬停查看修订号、完整时间、提交说明与变更路径。

### 🧩 右键菜单与文件状态

- 资源管理器、编辑器、源代码管理共用一套 **`SVN操作`** 子菜单：更新、提交、回退、日志、Diff、创建 Patch、应用 Patch 文本、创建 Code Review。
- 菜单项随文件状态变化：有本地改动时显示回退 / Diff / 创建 Patch，未版本化时显示“加入版本管理”。
- 资源管理器以 `?` `A` `M` `D` `R` `C` 徽标和 Git 风格颜色标识 SVN 状态。

### 🧰 Patch 与冲突

- **Patch 视图**：集中管理创建的 Patch，一键应用或删除；也可直接粘贴 Patch 文本应用。
- **冲突文件列表**：集中列出所有冲突文件，左键打开 TortoiseMerge 三方合并窗口（不可用时回退到 VS Code 编辑器），右键标记为已解决。

### 🐢 与 TortoiseSVN 协作

| 操作 | 实现方式 |
|---|---|
| 更新、提交、加入版本管理、创建 Code Review | TortoiseSVN 原生窗口 |
| 回退 | VS Code 确认窗口，确认后直接放弃所选改动 |
| 日志、Diff、Blame、分组、合并等 | `svn.exe` 命令行，结果在 VS Code 内展示 |

---

## 🚀 快速开始

1. 安装 [TortoiseSVN](https://tortoisesvn.net/)，安装时勾选 **command line client tools**。
2. 确保 `svn.exe` 与 `TortoiseProc.exe` 可从 `PATH` 找到（或在设置中指定路径，见下文）。
3. 在 VS Code 中执行 **扩展：从 VSIX 安装…**，选择 `svn-compass-<版本>.vsix`。
4. 打开包含 SVN 工作副本的文件夹，并将工作区设为**受信任**，扩展即自动启用。

> [!NOTE]
> 扩展会调用本机 `svn.exe` 与 `TortoiseProc.exe`，因此仅在受信任工作区中运行。TortoiseSVN 原生窗口相关功能仅支持 Windows。

---

## ⚙️ 配置项

| 设置 | 默认值 | 说明 |
|---|---|---|
| `svn.path` | `svn.exe` | `svn.exe` 路径，默认从 `PATH` 查找 |
| `svn.tortoiseProc.path` | `TortoiseProc.exe` | `TortoiseProc.exe` 路径，默认从 `PATH` 查找 |
| `svn.autoRefresh` | `true` | 自动刷新资源管理器与源代码管理侧栏中的 SVN 状态 |
| `svn.refreshInterval` | `3000` | 自动刷新间隔（毫秒），最小 `1000` |

---

## ❓ 常见问题

<details>
<summary><b>报错 “No view is registered with id …” 或视图 / 菜单没有更新</b></summary>

用相同版本号的 `.vsix` 覆盖安装后，正在运行的窗口可能仍沿用旧的扩展声明。安装后执行 **开发人员：重新加载窗口**；仍无效时完全关闭 VS Code 再打开。发布新功能时建议提升版本号。

</details>

<details>
<summary><b>合并时提示 “Cannot merge into mixed-revision working copy”</b></summary>

目标工作副本中混有多个修订版本，SVN 要求先更新。使用“合并到目标分支”时，扩展会询问是否先对目标目录执行 `svn update` 再继续。

</details>

<details>
<summary><b>“合并到目标分支”应该选哪个目录？</b></summary>

选择与源目录结构相同的分支目录即可，例如源文件位于 `G:\trunk\…`，就选择 `G:\V120`。扩展会按目录结构和仓库路径自动定位到对应的（嵌套）工作副本；若结构不一致会直接报错，不会合并到错误位置。选择更深的子目录则只合并该目录下的改动。

</details>

<details>
<summary><b>某些文件没有出现在源代码管理侧栏</b></summary>

检查它们是否命中了 `files.exclude` 或 `search.exclude`，被排除的路径不会显示。

</details>

---

## 🛠️ 开发

```bash
npm install          # 安装依赖
npm run compile      # 类型检查并构建到 dist/
npm test             # 运行测试
npm run package      # 打包生成 .vsix
```

在 VS Code 中打开本项目并按 <kbd>F5</kbd> 即可启动扩展开发宿主进行调试。

<details>
<summary>目录结构</summary>

```text
src/
├─ extension.ts            入口：命令注册、工作副本发现、自动刷新
├─ scm.ts                  源代码管理提供器与 changelist 分组
├─ svn.ts                  svn.exe / TortoiseProc.exe 调用与输出解析
├─ fileHistoryView.ts      文件日志视图
├─ logView.ts              SVN 日志页面
├─ selectionHistoryView.ts 选中内容历史
├─ blame.ts                行级 Blame
├─ conflictView.ts         冲突文件列表
├─ patchText.ts            Patch 文本应用
└─ excludes.ts             files.exclude / search.exclude 匹配
```

</details>

---

<div align="center">

[MIT License](LICENSE) · [问题反馈](https://github.com/Leager-zju/TortoiseSVN-in-VSCode/issues)

</div>
