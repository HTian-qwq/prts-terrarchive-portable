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

## 构建与发布

版本和上游 commit 统一固定在 [`versions.json`](versions.json)。GitHub Actions 会：

1. checkout 指定的官方 DSH tag，并核对精确 commit；
2. 使用固定 Node/pnpm 安装锁文件并运行官方构建；
3. 通过官方 `dsh-python-runtime-closure` 和 frozen lockfile 生成 hoisted 的独立运行闭包，
   再从同一固定 commit 补齐其声明但部署根漏装的 workspace peer；
4. 下载 Node 官方 Windows ZIP并核对 Node 官方 SHA-256；
5. 使用 .NET 10 LTS 构建自包含 Win-x64 桌面 EXE；
6. 复制 npm `files` 白名单内的 PRTS 插件文件，并调用插件的 `--preset-only` 生成 preset；
7. 在 Windows runner 上启动成品 Host，检查设置路由和客户端 bundle；
8. 静态检查桌面 EXE、Node 与所有原生模块均为 Windows x64 PE；
9. 生成 ZIP、SHA-256，并在 tag 构建时创建 GitHub Release。

手动运行 workflow 时可以选择 `prts-terrarchive` ref；正式 tag 应先把
[`versions.json`](versions.json) 中的版本全部固定，再创建同版本 tag。

## 开发检查

```bash
npm run check
npm test
```

完整组装必须在 Windows runner 上完成，因为 DSH 包含平台相关依赖。Linux/macOS 本地开发
主要验证启动器纯函数和构建脚本语法。名称带 `local-smoke` 的本地产物不是 Windows
发行包，不得复制到 Windows 使用；可供测试的 ZIP 必须来自 Windows GitHub Actions，且
文件名为 `PRTS-Terrarchive-Portable-windows-x64.zip`。组装和冒烟脚本都会校验内置
`node.exe` 的 Windows PE x64 文件头，防止错误平台的运行时混入发行包。

## 许可边界

本仓库原创桌面程序、启动器和构建脚本采用 MIT License。发行包会收集 DeepSeek Harness 与
`prts-terrarchive` 的许可证和第三方声明。

《明日方舟》《明日方舟：终末地》的名称、图像、模型、贴图及其他游戏内容不属于 MIT
授权范围。本发行版不捆绑 ModelScope 语料；随包提供的地图、皮肤模型和贴图继续遵循
`prts-terrarchive/GAME_ASSETS.md` 的独立边界声明。
