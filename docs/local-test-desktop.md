# 本地桌面测试版

在 `D:\ds\prts-terrarchive` 双击 `run-test-desktop.cmd`：编译当前莱茵界面、生成独立插件快照，通过真实 Host 检查后打开 Electron 测试版。全程不生成 ZIP。也可以在插件项目执行：

```powershell
npm run test:desktop
```

持续开发时执行：

```powershell
npm run test:desktop:watch
# 或
.\run-test-desktop.cmd -Watch
```

监听模式会合并连续修改，串行构建。新构建通过检查后，窗口左下角显示“新构建就绪”；在测试窗口按 **Ctrl+Shift+R**，正常结束当前 Host 并重新打开最新构建。新构建不会自动中断正在进行的 Agent 调查；请在方便的时候应用。**Ctrl+C** 停止监听，已经打开的测试窗口继续运行。

其他入口：

```powershell
.\run-test-desktop.cmd -BuildOnly  # 只构建，不打开或重启窗口
.\run-test-desktop.cmd -RunOnly    # 直接运行最近一次成功构建
```

## 构建与数据

输出位于发行版项目 `dist/PRTS-Terrarchive-Test/`：

- `builds/<时间与标识>/plugin/`：这一版的已发布插件文件快照，后续源码修改不会改变它。
- `builds/<时间与标识>/verification.json`：真实 Host、PRTS 预设、创建会话、UI 资源及莱茵资源哈希检查结果，不调用模型。
- `current.json`：只在构建与检查全部通过后切换；失败保留上一版。
- `userdata/`：各次测试构建共享的独立测试数据。首次默认莱茵皮肤，模型设置需要在测试版中配置一次；后续保留设置和会话。不要分享此目录，其中可能包含凭据。
- `launch.log`、`startup-error.log`：启动日志与启动异常。

这个入口复用本机发行版构建缓存中的 Electron、Node、已编译 Harness 和完整语料；按正式版依赖清单补全开发 profile，再加入当前插件快照。它是本机开发测试版，依赖 `.build/dsh-electron` 和 `.build/corpus`，不能把测试目录单独发给其他电脑运行。第一次需要先完成 `build-electron.ps1`，准备运行时；更新 Harness 固定版本也需要重建该缓存。

测试版使用官方开发 profile，插件管理的安装、卸载功能不开放；修改本地插件后重新构建即可。需要验证离线安装、完整分发或插件管理时，仍用正式发行版构建。

监听覆盖 UI、后端、资源、预设、skills、contracts 及发布配置。生成的莱茵产物不会触发下一次构建，避免无限重建。旧快照暂时保留；退出测试版及监听后可手动清理不需要的 `builds/` 子目录，保留 `current.json` 指向的目录以及 `userdata/`。
