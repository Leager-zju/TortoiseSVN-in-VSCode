# SVNHelper

面向 Windows 与 TortoiseSVN 的 VS Code 扩展，提供：

- 资源管理器和编辑器文件右键菜单：SVN 更新、提交、回退、Diff、加入版本管理
- 资源管理器以 `A`、`M`、`D`、`R`、`C` 等徽标和 Git 风格颜色显示 SVN 文件状态
- 更新、提交、回退和加入版本管理使用 TortoiseSVN 原生窗口
- Diff 在 VS Code 内置对比编辑器中打开
- “源代码管理”侧栏显示当前工作区内 SVN 工作副本的可提交项
- 支持多根工作区及工作区中的多个 SVN 工作副本

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
