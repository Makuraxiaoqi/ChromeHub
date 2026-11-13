# ChromeHub 多开管家

一个 Windows 桌面工具，用来批量管理互相隔离的 Chromium 浏览器实例。

每个浏览器都有独立的用户数据目录，Cookie、登录状态和本地存储互不干扰；新建时可以套用「预设」，一次性装好指定的扩展和用户脚本；页面支持后台常驻，让依赖页面的采集脚本持续运行，同时提供多档内存优化模式。

> 面向场景：多账号运营、店铺后台并行、需要常驻页面跑脚本的数据采集等。

## 功能

- **多开隔离**：每个浏览器独立 `user-data-dir`，Cookie / 登录态 / LocalStorage 完全隔离，重启后保留。
- **扩展预设**：支持导入 CRX2 / CRX3、ZIP 和已解压的扩展文件夹，新建浏览器时按预设自动安装。
- **脚本预设**：内置用户脚本引擎，直接导入 `.user.js`，支持 `@match` / `@include` / `@exclude` / `@run-at`，无需安装 Tampermonkey。
- **启动配置**：预设可保存启动页、窗口模式（显示 / 隐藏后台）、内存模式和扩展、脚本组合。
- **后台常驻**：隐藏窗口运行；最后一个页面被关闭时会自动重建启动页，保证脚本不中断。
- **内存优化**：`均衡 / 省内存 / 极限` 多档策略，关闭后台节流、Memory Saver 与标签丢弃，在常驻前提下尽量压低占用。
- **运行监控**：查看各实例进程状态、页面数、JS 堆和 DOM 节点数，可一键停止全部浏览器。
- **托盘常驻**：关闭主窗口不退出，浏览器继续在后台运行。

## 环境要求

- Windows 10 / 11（x64）
- [Node.js](https://nodejs.org/) 20 或更高版本（开发时使用 24.x）
- Git（仅源码方式需要）
- 首次运行需联网下载 Chromium，约 215 MB

## 快速开始

### 方式一：打包版

在仓库的 **Releases** 页面下载 `ChromeHub-win32-x64.zip`（若暂未提供，请使用下面的源码方式），解压后运行文件夹内的 `ChromeHub.exe`。

注意：

- 必须解压**整个文件夹**再运行，不能只把 exe 拖出来。
- 程序未做代码签名，Windows SmartScreen 可能提示「已保护你的电脑」，选择「更多信息 → 仍要运行」即可。
- 首次启动请到「设置 → 浏览器内核」下载 Chromium。

### 方式二：源码运行

```powershell
git clone https://github.com/Makuraxiaoqi/ChromeHub.git
cd ChromeHub
npm install
npm start
```

国内网络安装慢时可以先切换镜像：

```powershell
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

`npm install` 只安装 Electron 等依赖，Chromium 内核在应用内「设置」页下载，也可以手动执行：

```powershell
npm run install-browser
```

调试模式（打开开发者工具）：

```powershell
npm run dev
```

## 使用流程

1. **安装内核**：打开「设置」→ 下载 Chromium。下载完成后会显示版本与路径。
2. **准备扩展**：「扩展库」→ 导入 `.crx` / `.zip` / 扩展文件夹。导入后会解析 manifest，显示名称、版本和 MV2/MV3。
3. **准备脚本**：「脚本库」→ 导入 `.user.js`，可查看匹配规则并启用 / 停用。
4. **创建预设**（可选）：「预设」→ 新建，勾选要预装的扩展与脚本，设置启动页、窗口模式和内存模式。
5. **新建浏览器**：「浏览器」→ 新建，选择预设或手动勾选扩展 / 脚本，设置名称、启动页和窗口模式。
6. **启动**：点击「启动」。隐藏模式下浏览器在后台运行，可在列表中查看状态和资源占用。
7. **停止**：单个停止，或使用顶部「全部停止」。停止不会删除 Cookie，下次启动继续使用。

### 关于常驻与内存

- 「隐藏」窗口模式适合长期挂脚本：窗口不可见，但页面正常渲染，脚本持续执行。
- `省内存` / `极限` 会关闭 GPU、站点隔离等非必要能力，适合页面多、机器内存紧张的场景；如果扩展或脚本依赖某些特性，请退回 `均衡`。
- 程序不会主动丢弃标签页或冻结后台页面，因为这会导致脚本停摆。

### 用户脚本支持范围

支持常用的元数据与 API：

- 元数据：`@name`、`@namespace`、`@version`、`@description`、`@match`、`@include`、`@exclude`、`@run-at`、`@grant`、`@noframes`
- API：`GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues`、`GM_addStyle`、`GM_addElement`、`GM_openInTab`、`GM_notification`、`GM_info`、`GM_log` 等

暂不支持 `@require` 与 `@resource` 远程资源加载，需要依赖库时请把代码直接写进脚本。

## 打包

```powershell
npm run pack
```

输出目录：`dist\ChromeHub-win32-x64\`，可执行文件为 `ChromeHub.exe`。

打包脚本会优先复用本机 Electron 缓存，缓存缺失时从 npmmirror 下载，避免直连 GitHub。`dist/` 与 `node_modules/` 不会提交到仓库。

## 测试

```powershell
npm test          # 核心能力：CRX 导入、脚本注入、Cookie 持久化、多实例隔离、常驻、指标
npm run test:ui   # Electron 界面冒烟测试
npm run test:e2e  # 端到端：新建浏览器、扩展 / 脚本选择、预设套用、重启恢复
```

测试会使用临时目录和独立配置，不会影响日常正在使用的实例数据。

## 数据目录

| 内容 | 位置 |
| --- | --- |
| 配置、实例数据、导入的扩展 | `%APPDATA%\ChromeHub 多开管家\` |
| Chromium 内核 | `%LOCALAPPDATA%\ms-playwright\chromium-<revision>\` |
| 打包产物 | `dist\ChromeHub-win32-x64\` |

卸载或迁移时，备份 `%APPDATA%\ChromeHub 多开管家\` 即可保留全部实例的登录状态。

## 已知限制

- 仅支持 Windows x64。
- Chromium 158 已不再支持 Manifest V2，MV2 扩展可能无法加载，建议使用 MV3 版本。
- 首版不包含代理配置。
- 程序未签名，分发时可能触发 SmartScreen 提示。
- 用户脚本引擎只实现常用 GM API，并非完整兼容 Tampermonkey。

## 项目结构

```
main.js            Electron 主进程、IPC、托盘与窗口
preload.js         安全桥接（contextBridge）
lib/chromium.js    Chromium 下载与版本管理
lib/runtime.js     实例启动、页面常驻、崩溃恢复、指标采集
lib/extensions.js  CRX2 / CRX3 / ZIP / 文件夹导入
lib/scripts.js     用户脚本解析与注入
lib/flags.js       启动参数与内存模式
lib/store.js       配置与实例元数据持久化
src/               渲染层界面（原生 HTML / CSS / JS）
dev/               测试与打包脚本
```

## 许可证

MIT，详见 `package.json`。
