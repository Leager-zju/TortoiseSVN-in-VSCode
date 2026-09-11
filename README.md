# SVN Compass

面向 Windows 与 TortoiseSVN 的 VS Code 扩展，提供：

- 资源管理器、编辑器和“源代码管理”共用一套 `SVN操作` 右键子菜单：更新、提交、回退、日志、Diff、创建 Patch、创建 Code Review
- “源代码管理”右键菜单在 `SVN操作` 之前额外保留 `选择分组` 子菜单（新建分组 / 选择已有分组）
- 菜单随状态变化：有本地改动时显示回退/Diff/创建 Patch/创建 Code Review，未版本化时显示加入版本管理
- 资源管理器以 `?`、`A`、`M`、`D`、`R`、`C` 等徽标和 Git 风格颜色显示 SVN 文件状态
- 更新、提交和加入版本管理使用 TortoiseSVN 原生窗口
- 回退操作使用 VS Code 内置确认窗口，确认后直接放弃所选文件改动
- Diff 在 VS Code 内置对比编辑器中打开
- SVN 日志在 VS Code 页面中显示完整历史、作者、日期、提交信息及变更路径，并支持筛选、分页、查看修订与修订比较
- 在编辑器中选中一段内容后，可通过右键菜单查看逐行 SVN 历史、相关提交和本地未提交行
- 行号右键菜单提供 Blame：点击后为当前文件的每一行显示最后一次修改的作者与时间，再次点击即整篇隐藏；鼠标悬停任意行可查看版本号、完整时间、提交说明与变更路径
- “源代码管理”侧栏将多个 SVN 工作副本聚合为一个提供器，直接按默认分组或自定义分组显示可提交项，并支持树状/平铺列表切换且不改变文件分组
- 支持多根工作区及工作区中的多个 SVN 工作副本
- “冲突文件列表”视图集中显示所有冲突文件：左键打开 TortoiseSVN 冲突编辑窗口（TortoiseMerge 三方窗口，不可用时回落到 VS Code 编辑器），右键可标记为冲突已解决

## 环境要求

安装 TortoiseSVN，并确保 `svn.exe` 与 `TortoiseProc.exe` 可从 `PATH` 找到。也可在 VS Code 设置中配置 `svn.path` 和 `svn.tortoiseProc.path`。

## 开发与安装

```bash
npm install
npm run compile
npm run package
```

运行最后一条命令会在项目根目录生成 `.vsix`，随后可在 VS Code 的“扩展：从 VSIX 安装...”中安装。

开发时在 VS Code 打开本项目并按 `F5`。
