# PRTS Terrarchive Portable

面向普通用户的 PRTS Terrarchive Windows 桌面便携发行版构建器。成品内置自包含桌面程序、
Node.js、固定版本 DeepSeek Harness 和 `prts-terrarchive`，用户完整解压后只需双击
`PRTS Terrarchive.exe`，不需要安装 Node、pnpm、.NET 或执行命令。

> 独立社区项目，与深度求索、鹰角网络及其关联方不存在隶属、合作、授权或背书关系。

## 当前范围

- Windows 10/11 x64 ZIP
- 使用 DSH `0.1.3-alpha.1` 官方 tag（不额外固定 commit）
- 预装 PRTS 插件及「PRTS 模式」preset，并在首次启动时默认选用该模式
- 首次启动默认使用「PRTS Agent」皮肤；用户之后的模式与皮肤选择不会被升级覆盖
- 单实例桌面窗口和系统托盘菜单
- 关闭窗口缩到托盘，可显示窗口、重启服务、打开数据目录或彻底退出
- WebView2 数据、会话、凭据和设置位于 `userdata/`；随包语料位于 `corpus/`
- 只绑定 `127.0.0.1`，使用 DSH 自己生成的访问 token
- 使用 Windows Job Object 管理 Node/DSH 进程树，退出时不遗留后台进程
- 正式发行包在构建时由 PRTS.chat `current` 选定完整语料，逐分片校验后随 ZIP 放入 `corpus/`

除内置语料外，插件所需地图、皮肤模型和贴图随包提供。第一阶段不提供静默自动更新
或局域网开放。程序版本、DSH 版本和插件版本分别记录在 `release-manifest.json`，便于复现
和回滚。

## 用户使用

1. 从 Releases 下载 Windows ZIP 及对应 `.sha256`。
2. 校验 SHA-256 后完整解压。
3. 双击 `PRTS Terrarchive.exe`。
4. 在设置中配置模型；进入“插件 → PRTS 语料”确认内置资料已就绪或下载更新。
5. 新建会话；发行版默认使用“PRTS 模式”和“PRTS Agent”皮肤，也可以在界面中切换。

按 `F11` 可进入或退出覆盖任务栏的全屏模式，按 `Esc` 退出全屏；右上角方框按钮仍用于
普通最大化/还原，在全屏状态下点击它会退出全屏。

关闭主窗口只会缩到系统托盘；通过托盘菜单的“退出”可停止 Host 并彻底退出。不要公开分享
`userdata/`，其中可能包含明文模型凭据和私人会话。发行文件夹必须位于当前用户可写的位置，
不支持直接在压缩包中运行，也不建议放入 `Program Files`。

Host 启动失败或意外退出时，桌面会显示错误和重试入口。WebView2 初始化失败后可在
修复运行环境后重试；浏览器进程崩溃时会重建 WebView2 再加载页面。退出 Host 会同时
结束 Node 启动器；本地访问 token 在 Host、桌面和启动器调试日志中均隐藏。

## 发行结构

```text
PRTS-Terrarchive-Portable-windows-x64/
├─ PRTS Terrarchive.exe
├─ runtime/
│  ├─ node/
│  └─ dsh/
├─ app/
├─ corpus/releases/         # 构建时按 PRTS.chat current 选版并校验的固定语料
├─ templates/
│  ├─ profiles/web/
│  └─ .agent-presets/prts/
├─ userdata/                 # 首次启动创建，不进入源码或发行 ZIP
├─ LICENSES/
├─ 使用说明.txt
└─ release-manifest.json
```

启动时只同步发行版负责管理的 `prts-terrarchive` 包和 `prts` preset。已有的第三方 profile
dependency、bundle 和 `cordis.patch.yml` 会保留，用户会话目录不会被覆盖。

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

构建 DSH 还需要 Visual Studio 2022 Build Tools 的 **Desktop development with C++** workload，
包括 MSVC x64/x86 与 Windows 10/11 SDK。DSH 的 `fs-ext` 会在构建时编译 Windows
`LockFileEx` 原生绑定，因此该工具链不能通过跳过安装脚本替代；最终用户运行发行包不需要安装它。

在 PowerShell 中运行：

```powershell
cd D:\ds\prts-terrarchive-portable
.\build-local.ps1
```

脚本使用 [`versions.json`](versions.json) 选择 DSH 版本并固定 Node、pnpm 与桌面 SDK；每次构建
从 PRTS.chat `current` 解析当前公开语料 release，下载并逐分片校验，随后安装并构建 DSH、生成生产运行闭包、发布单文件桌面 EXE、
复制插件 `package.json#files` 白名单、执行 Windows PE 静态审计和真实 Host 冒烟测试，最后原子替换
ZIP 并生成 SHA-256。脚本不写死盘符或代理，也不会把 `userdata/`、`.build/` 或开发文档放进
发行 ZIP。若 `versions.json` 固定的插件版本低于 current 的 `minimum_agent_version`，构建会在下载
语料前直接失败，必须先固定一个兼容的插件提交。

已校验的语料缓存在 `.build/corpus/releases`，重复构建会复用未变化的文件；最新版本解析或文件校验失败时
构建会直接停止，不会产出一个悄悄缺少资料的 ZIP。

每次下载沿用同一次 PRTS.chat `current` 响应完成选版与校验。组装只收录选定 release
清单列出的资产，缓存中的历史版本和下载残留不会进入 ZIP；复制后的资产会再次校验。

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
授权范围。本发行版捆绑构建时由 PRTS.chat `current` 选版并逐分片校验的语料；随包提供的地图、皮肤模型和贴图继续遵循
`prts-terrarchive/GAME_ASSETS.md` 的独立边界声明。

内置语料对应的公开 ModelScope 镜像与来源声明位于
[`prts-agent-corpus-arknights`](https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-arknights)
与 [`prts-agent-corpus-endfield`](https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-endfield)。
它们不属于本仓库 MIT 授权范围，仍适用各数据集页面的来源声明与条款；发行 ZIP 内的
`LICENSES/NOTICE.txt` 会同时保留这一边界。
