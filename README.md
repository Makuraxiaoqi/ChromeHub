# ChromeHub 多开管家

一个跨平台桌面工具（Windows x64 / Linux x64），用来批量管理互相隔离的 Chromium 浏览器实例。

每个浏览器都有独立的用户数据目录，Cookie、登录状态和本地存储互不干扰；新建时可以套用「预设」，一次性装好指定的扩展和用户脚本；页面支持后台常驻，让依赖页面的采集脚本持续运行，同时提供多档内存优化模式。

> 面向场景：多账号运营、店铺后台并行、需要常驻页面跑脚本的数据采集等。

## 功能

- **多开隔离**：每个浏览器独立 `user-data-dir`，Cookie / 登录态 / LocalStorage 完全隔离，重启后保留。
- **扩展预设**：支持导入 CRX2 / CRX3、ZIP 和已解压的扩展文件夹，新建浏览器时按预设自动安装。
- **脚本预设**：内置用户脚本引擎，直接导入 `.user.js`，支持 `@match` / `@include` / `@exclude` / `@run-at`，无需安装 Tampermonkey。
- **启动配置**：预设可保存启动页、窗口模式（显示 / 隐藏后台）、内存模式和扩展、脚本组合。
- **后台常驻**：隐藏窗口运行；最后一个页面被关闭时会自动重建启动页，保证脚本不中断。
- **内存优化**：`均衡 / 省内存 / 极限` 多档策略，关闭后台节流、Memory Saver 与标签丢弃，在常驻前提下尽量压低占用。
- **下载**：默认保存到系统下载目录，保留原始文件名，重名自动编号；可选择每个浏览器独立目录或自定义目录，也可开启每次询问保存位置。
- **运行监控**：查看各实例进程状态、页面数、JS 堆和 DOM 节点数，可一键停止全部浏览器。
- **托盘常驻**：关闭主窗口不退出，浏览器继续在后台运行。

## 环境要求

- Windows 10 / 11（x64）或主流 Linux 发行版（x64，需 glibc）
- [Node.js](https://nodejs.org/) 20 或更高版本（开发时使用 24.x）
- Git（仅源码方式需要）
- 首次运行需联网下载 Chromium，约 200–215 MB

Linux 运行 Chromium 还需要常见的图形与多媒体库，缺少时启动浏览器会报缺库错误。Debian / Ubuntu 可先安装：

```bash
sudo apt-get update
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2 libpango-1.0-0 libcairo2 libx11-xcb1 libxss1
```

其他发行版可参考 Playwright 的依赖列表，或在源码目录执行 `npx playwright install-deps chromium`。

## 快速开始

### 方式一：打包版

在仓库的 **Releases** 页面下载对应平台的压缩包（若暂未提供，请使用下面的源码方式）。

**Windows**：下载 `ChromeHub-win32-x64.zip`，解压后运行文件夹内的 `ChromeHub.exe`。

**Linux**：下载 `ChromeHub-linux-x64.tar.gz`：

```bash
tar -xzf ChromeHub-linux-x64.tar.gz
cd ChromeHub-linux-x64
./ChromeHub
```

注意：

- 必须保留**整个文件夹**再运行，不能只把可执行文件单独拖出来。
- Windows 版未做代码签名，SmartScreen 可能提示「已保护你的电脑」，选择「更多信息 → 仍要运行」即可。
- Linux 包已保留可执行权限；若使用 zip 解压导致权限丢失，执行 `chmod +x ChromeHub chrome-sandbox chrome_crashpad_handler`。
- 首次启动请到「设置 → 浏览器内核」下载 Chromium。

### 方式二：源码运行

Windows PowerShell / Linux Bash 通用：

```bash
git clone https://github.com/Makuraxiaoqi/ChromeHub.git
cd ChromeHub
npm install
npm start
```

国内网络安装慢时可以先切换镜像。

Windows PowerShell：

```powershell
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

Linux：

```bash
npm config set registry https://registry.npmmirror.com
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

`npm install` 只安装 Electron 等依赖，Chromium 内核在应用内「设置」页下载，也可以手动执行：

```bash
npm run install-browser
```

调试模式（打开开发者工具）：

```bash
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

### 关于下载

- 默认保存到系统下载目录（Windows 通常是 `下载`，Linux 通常是 `~/Downloads`），文件名与网站提供的一致，不再出现无扩展名的乱码临时文件。
- 同名文件不会覆盖，自动追加 ` (1)`、` (2)`。
- 「设置 → 下载」可以改为每个浏览器独立目录（`profiles/<实例ID>/Downloads`）或自定义目录，位置留空时回退到系统下载目录。
- 勾选「每次下载询问保存位置」后，行为与普通浏览器一致，会弹出保存对话框。
- 下载过程先写入实例目录下的 `.downloads-tmp`，完成后转存并清理，不会污染用户数据目录。

### 用户脚本支持范围

支持常用的元数据与 API：

- 元数据：`@name`、`@namespace`、`@version`、`@description`、`@match`、`@include`、`@exclude`、`@run-at`、`@grant`、`@noframes`
- API：`GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues`、`GM_addStyle`、`GM_addElement`、`GM_openInTab`、`GM_notification`、`GM_info`、`GM_log` 等

暂不支持 `@require` 与 `@resource` 远程资源加载，需要依赖库时请把代码直接写进脚本。

## 打包

```bash
npm run pack:win     # Windows x64 → dist/ChromeHub-win32-x64/ChromeHub.exe
npm run pack:linux   # Linux x64   → dist/ChromeHub-linux-x64/ChromeHub
```

`npm run pack` 等同于 `pack:win`。打包脚本会优先复用本机 Electron 缓存，缓存缺失时从 npmmirror 下载，避免直连 GitHub。`dist/` 与 `node_modules/` 不会提交到仓库。

在 Windows 上也可以交叉打出 Linux 包，但 Linux 包建议在 Linux 或 CI 中构建并做一次启动验证。制作 Linux 分发压缩包时需保留可执行权限：

```bash
tar -czf ChromeHub-linux-x64.tar.gz -C dist ChromeHub-linux-x64
```

## Linux 说明

- Chromium 内核会自动下载 Chrome for Testing 的 `chrome-linux64` 版本，安装到 `~/.cache/ms-playwright/`，与 Windows 逻辑一致。
- 若提示 `The SUID sandbox helper binary was found, but is not configured correctly`，说明系统未启用非特权用户命名空间。推荐修复沙箱：

  ```bash
  sudo chown root:root chrome-sandbox
  sudo chmod 4755 chrome-sandbox
  ```

  容器或无法使用 root 的环境可临时用 `./ChromeHub --no-sandbox` 启动（会降低安全性）。
- 以 root 身份运行时，程序会给内部 Chromium 自动追加 `--no-sandbox`，否则 Chromium 无法启动。
- 托盘依赖桌面环境的 StatusNotifier / AppIndicator 支持。GNOME 默认不显示托盘图标，需要安装 AppIndicator 扩展；没有托盘时，关闭主窗口会退出程序并停止所有浏览器。
- 隐藏模式使用 Chromium 的新版 headless，扩展和用户脚本仍会加载；若某个扩展依赖完整图形栈，请改用「显示」窗口模式。

## 测试

```powershell
npm test          # 核心能力：CRX 导入、脚本注入、Cookie 持久化、多实例隔离、常驻、指标
npm run test:ui   # Electron 界面冒烟测试
npm run test:e2e  # 端到端：新建浏览器、扩展 / 脚本选择、预设套用、重启恢复
```

测试会使用临时目录和独立配置，不会影响日常正在使用的实例数据。Linux 无桌面环境时，UI / E2E 测试请用 `xvfb-run -a npm run test:ui` 运行。

## 数据目录

| 内容 | Windows | Linux |
| --- | --- | --- |
| 配置、实例数据、导入的扩展 | `%APPDATA%\ChromeHub 多开管家\` | `~/.config/ChromeHub 多开管家/` |
| Chromium 内核 | `%LOCALAPPDATA%\ms-playwright\chromium-<revision>\` | `~/.cache/ms-playwright/chromium-<revision>/` |
| 打包产物 | `dist\ChromeHub-win32-x64\` | `dist/ChromeHub-linux-x64/` |

卸载或迁移时，备份对应的配置目录即可保留全部实例的登录状态。

## 已知限制

- 仅提供 Windows x64 与 Linux x64 构建，不支持 Windows 7/8 和 32 位系统。
- Linux 版依赖目标发行版的 Chromium 系统库，库版本差异可能需要额外安装依赖。
- Chromium 158 已不再支持 Manifest V2，MV2 扩展可能无法加载，建议使用 MV3 版本。
- 首版不包含代理配置。
- Windows 程序未签名，分发时可能触发 SmartScreen 提示。
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
