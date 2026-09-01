# PRTS Terrarchive Portable

面向普通用户的 PRTS Terrarchive Windows 桌面便携发行版构建器。成品内置自包含桌面程序、
Node.js、固定版本 DeepSeek Harness 和 `prts-terrarchive`，用户完整解压后只需双击
`PRTS Terrarchive.exe`，不需要安装 Node、pnpm、.NET 或执行命令。

> 独立社区项目，与深度求索、鹰角网络及其关联方不存在隶属、合作、授权或背书关系。

## 当前范围

- Windows 10/11 x64 ZIP
- 固定 DSH `0.1.2-alpha.1` 官方 tag 和 commit
- 预装 PRTS 插件及「PRTS 模式」preset
- 单实例桌面窗口和系统托盘菜单
- 关闭窗口缩到托盘，可显示窗口、重启服务、打开数据目录或彻底退出
- WebView2 数据、会话、凭据、设置和语料全部位于发行目录的 `userdata/`
- 只绑定 `127.0.0.1`，使用 DSH 自己生成的访问 token
- 使用 Windows Job Object 管理 Node/DSH 进程树，退出时不遗留后台进程
- 语料首次使用时从 ModelScope 下载，不包含在 GitHub 发行包中

除 ModelScope 语料外，插件所需地图、皮肤模型和贴图随包提供。第一阶段不提供静默自动更新
或局域网开放。程序版本、DSH 版本和插件版本分别记录在 `release-manifest.json`，便于复现
和回滚。

## 用户使用

1. 从 Releases 下载 Windows ZIP 及对应 `.sha256`。
2. 校验 SHA-256 后完整解压。
3. 双击 `PRTS Terrarchive.exe`。
4. 在设置中配置模型；进入“插件 → PRTS 语料”下载资料。
5. 新建会话，选择“PRTS 模式”。

关闭主窗口只会缩到系统托盘；通过托盘菜单的“退出”可停止 Host 并彻底退出。不要公开分享
`userdata/`，其中可能包含明文模型凭据和私人会话。发行文件夹必须位于当前用户可写的位置，
不支持直接在压缩包中运行，也不建议放入 `Program Files`。

## 发行结构

```text
PRTS-Terrarchive-Portable-windows-x64/
├─ PRTS Terrarchive.exe
├─ runtime/
│  ├─ node/
│  └─ dsh/
├─ app/
├─ templates/
│  ├─ profiles/web/
│  └─ .agent-presets/prts/
├─ userdata/                 # 首次启动创建，不进入源码或发行 ZIP
├─ LICENSES/
├─ 使用说明.txt
└─ release-manifest.json
```

启动时只同步发行版负责管理的 `prts-terrarchive` 包和 `prts` preset。已有的第三方 profile
dependency、bundle 和 `cordis.patch.yml` 会保留，语料与会话目录不会被覆盖。

## 本地构建与发布

当前正式成品在 Windows x64 开发机本地构建，不依赖 GitHub Actions。建议目录如下：

```text
D:\ds\
├─ .tools\
│  ├─ node\
│  ├─ git\cmd\       # 可选，系统 Git 也可以
│  └─ dotnet\        # 可选，系统 .NET 10 SDK 也可以
├─ prts-terrarchive\
└─ prts-terrarchive-portable\
```

在 PowerShell 中运行：

```powershell
cd D:\ds\prts-terrarchive-portable
.\build-local.ps1
```

脚本使用 [`versions.json`](versions.json) 固定 DSH、Node、pnpm 和桌面 SDK 版本；首次运行会
获取固定 commit 的 DSH，随后安装并构建官方源码、生成生产运行闭包、发布单文件桌面 EXE、
复制插件 npm `files` 白名单、执行 Windows PE 静态审计和真实 Host 冒烟测试，最后原子替换
ZIP 并生成 SHA-256。脚本不写死盘符或代理，也不会把 `userdata/`、`.build/` 或开发文档放进
发行 ZIP。

已有可用的 DSH 构建时，可以跳过耗时的官方源码重编：

```powershell
.\build-local.ps1 -SkipDshBuild
```

工具和插件不在默认相邻目录时可显式指定：

```powershell
.\build-local.ps1 -ToolsRoot D:\toolchains -PluginPath D:\src\prts-terrarchive
```

输出固定为：

```text
dist\PRTS-Terrarchive-Portable-windows-x64\
dist\PRTS-Terrarchive-Portable-windows-x64.zip
dist\PRTS-Terrarchive-Portable-windows-x64.zip.sha256
```

## 开发检查

```bash
npm run check
npm test
```

完整组装必须在 Windows x64 上完成，因为 DSH 包含平台相关依赖。Linux/macOS 只用于验证
启动器纯函数和构建脚本语法。名称带 `local-smoke` 的产物不是 Windows 发行包，不得复制到
Windows 使用。组装和审计脚本会校验内置 `node.exe`、桌面 EXE 与原生模块的 Windows PE
x64 文件头，防止错误平台运行时混入发行包。

## 许可边界

本仓库原创桌面程序、启动器和构建脚本采用 MIT License。发行包会收集 DeepSeek Harness 与
`prts-terrarchive` 的许可证和第三方声明。

《明日方舟》《明日方舟：终末地》的名称、图像、模型、贴图及其他游戏内容不属于 MIT
授权范围。本发行版不捆绑 ModelScope 语料；随包提供的地图、皮肤模型和贴图继续遵循
`prts-terrarchive/GAME_ASSETS.md` 的独立边界声明。
