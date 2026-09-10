# PRTS Terrarchive Portable

面向普通用户的 PRTS Terrarchive Windows 桌面便携发行版构建器。成品内置桌面客户端、
Node.js、固定版本 DeepSeek Harness、`prts-terrarchive`、PRTS 预设和完整语料。
用户完整解压后双击 `PRTS Terrarchive.exe`，配置模型即可使用。

> 独立社区项目，与深度求索、鹰角网络及其关联方不存在隶属、合作、授权或背书关系。

## 官方 Electron 客户端便携版

新增构建入口使用 DeepSeek Harness 官方 Electron 源码作为桌面客户端，沿用本项目的插件、
预设和完整语料打包方式。原 WebView2 客户端及其构建脚本继续保留。

| 构建入口 | 桌面客户端 | DSH | 完整语料 |
| --- | --- | --- | --- |
| `build-electron.ps1` | 官方 Electron 源码，社区便携封装 | `0.1.5-alpha.1` | 随包提供 |
| `build-local.ps1` | 原 WinForms / WebView2 | `0.1.3-alpha.1` | 随包提供 |

Electron 版沿用旧便携版的无边框窗口设计：PRTS Agent 使用浅色半透明圆角控制栏，
Endfield AIC 使用黑底荧光黄切角控制栏，随皮肤选择即时切换。右上角应用菜单保留官方
插件管理入口，也可按 `Ctrl+,` 打开；顶部可拖动窗口，方框按钮最大化或还原，
`F11` 切换全屏，`Esc` 退出全屏。原生目录选择器、插件管理器和 Host 通信沿用官方实现。
便携封装把 Harness 会话、设置、凭据及 Electron 浏览器数据放在发行包根目录的 `userdata/`，首次默认
使用 PRTS 模式与 PRTS Agent 皮肤。既有用户的模式和皮肤选择会保留。
Windows 上关闭最后一个窗口会按官方客户端的行为退出应用。

语料仍从 PRTS.chat `current` 选择，逐文件校验后放入 `corpus/releases/`。发行包只包含
选定版本清单中的资产，不会带入构建缓存里的整套历史语料。安装插件不需要用户访问 npm；
首次启动会从包内文件准备本地运行环境。后续语料更新仍可在“插件 → PRTS 语料”中完成。

这是社区构建的便携 ZIP，不使用深度求索的桌面自动更新源，也不需要官方签名或上传凭据。
桌面程序更新通过下载新版完整 ZIP 完成；已有 `userdata/` 不应作为发行内容分享或覆盖。
新版根目录的 EXE 是小型原生启动器，Electron 主程序、DLL、语言包和离线安装材料统一放入
`client/`。这只整理文件位置，不会缩减 Electron 运行时或完整语料，压缩包总体积基本不变。
升级时先退出旧程序，将新版解压到新目录，再把原 `userdata/` 复制到新版根目录；若曾更新过
语料，也请保留原 `corpus/`。旧根目录的 `resources/`、DLL、pak 等程序文件不需要复制。
直接打开 `client/` 内的主程序也会使用根目录的语料和用户数据；请保持完整目录结构。
新入口生成独立的 Electron 成品目录；若构建输出中已有用户数据，构建器保留该目录，
另行生成新的 ZIP 和暂存目录。

### 在 Windows 构建 Electron 版

在现有工具目录布局下运行：

```powershell
cd D:\ds\prts-terrarchive-portable
.\build-electron.ps1
```

需要 Windows x64、Node.js 22.19+（或 24+）、Corepack、Git、Windows `tar.exe`，以及
Visual Studio 2022 Build Tools 17.1+ 的 Desktop development with C++ 工作负载和 Windows SDK。
Electron 构建不使用 .NET SDK 或 WebView2。内置运行时由官方准备流程下载并校验。
小启动器使用 MSVC 静态链接，不要求用户另装 .NET 或 VC++ 运行库。
[`versions.electron.json`](versions.electron.json) 固定 DSH 源码提交、Node、pnpm 和 Electron 版本。
本地插件源码必须包含新的 Electron 传输和预设注册支持。

```powershell
.\build-electron.ps1 -ToolsRoot D:\toolchains -PluginPath D:\src\prts-terrarchive
# 已完成一次构建后，复用准备好的官方运行时与安装材料：
.\build-electron.ps1 -SkipDshBuild
```

`-SkipDshBuild` 仍会重新编译小启动器并更新便携适配，因此也需要上述 C++ 构建工具。

构建器使用独立 `.build/dsh-electron` 源码副本，应用本项目维护的便携适配，运行官方
构建、打包和离线安装校验，加入本地 PRTS 包，再生成未签名的 Electron 应用目录。
组装后检查 Windows PE 架构、安装文件完整性和语料，并通过官方 Desktop Host 创建
空 PRTS 会话进行冒烟测试；测试不调用模型。验证失败不会生成正式 ZIP。
构建时还会在含中文和空格的临时目录运行真实启动器，检查工作目录和参数传递。
`-SkipSmoke` 只用于排查构建环境问题，正常发行应运行默认检查。

```text
dist/PRTS-Terrarchive-Electron-windows-x64/
├─ PRTS Terrarchive.exe       # 小型原生启动器
├─ client/
│  ├─ PRTS Terrarchive.exe    # Electron 主程序
│  ├─ *.dll、*.pak、locales/  # Electron 运行时文件
│  └─ resources/
│     ├─ app.asar            # 官方客户端及便携适配
│     ├─ runtime/            # 内置 Node.js 和 pnpm
│     └─ seed/               # 离线安装材料，包含 PRTS 插件
├─ corpus/releases/          # 完整、已校验的当前语料
├─ userdata/                 # 用户运行后创建，不进入 ZIP
├─ LICENSES/
├─ 使用说明.txt
└─ release-manifest.json
```

同时生成同名 `.zip` 和 `.zip.sha256`。完整 Windows 应用需在 Windows 上构建并验收；
Linux 上的脚本、安装合并和语料回归检查不能替代 Electron 实机测试。

## 原 WebView2 版的范围

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

## 原 WebView2 版用户使用

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

## 原 WebView2 版发行结构

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

## 原 WebView2 版本地构建与发布

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
