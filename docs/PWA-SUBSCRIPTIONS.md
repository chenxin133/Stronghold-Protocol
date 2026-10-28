# Windows、iPad、Android 共用 PWA（无需反复打包）

本 fork 的部署入口是 `launcher/`。游戏沿用原项目已有的 PWA 清单、图标、横屏和客户端版本刷新机制，玩法未修改。

## 使用方式

1. 从本 fork 的 Releases 下载 `Stronghold-PWA-Server-<版本>-Windows-x64.zip`，解压到路径较短的位置。
2. Windows 双击包内 `Start-PWA.cmd`。内置 Node.js，不需要 Git、npm、Android Studio 或 Apple 开发者账号。首次启动要联网下载原作者的精简包及缺少的素材，之后可以在无 GitHub 网络时启动已安装的版本。
3. 电脑打开 `http://localhost:3000/`。控制台同时列出局域网地址，同 Wi-Fi 下的 iPad/Android 可用浏览器访问该地址；首次运行时如有 Windows 防火墙提示，按自己的网络范围允许访问。
4. 给服务器配置**固定、可信的 HTTPS 地址**后，三端都使用它安装 PWA：Windows Edge/Chrome 的安装按钮；iPad Safari 的分享 → 添加到主屏幕；Android Chrome 的安装应用/添加到主屏幕。不同浏览器和 Android 系统提供的安装形式可能不同。
5. 打开同一地址的 `/subscriptions/` 查看当前/最新版本、更新状态及各仓库 RSS/Atom 链接。页面不提供远程修改服务器配置的接口。

服务器必须保持运行。PWA 缓存素材并不等于可以在 iPad/Android 上离线启动 Node.js 服务器。
不要在三端安装不同的地址，也不要随意更换协议、域名或端口：本地进度和素材缓存按浏览器来源保存；iPad 主屏幕应用还可能有独立存储。正式安装后尽量保持地址固定。

## 不用 Actions 更新游戏

启动器把**游戏更新**和**启动器打包**分开：

- 游戏源默认是 `https://github.com/sganggs/Stronghold-Protocol`，跟随正式 Release，而不是开发分支的每次提交。
- 首次下载 `Stronghold-Protocol-v…-lite.zip`，检查附件长度以及 GitHub 提供的 SHA-256（有摘要时必须匹配），在独立版本目录内准备运行环境。素材和用户安装的插件保存在版本目录之外。
- 每次启动及运行期间每 30 分钟检查一次；运行期间发现新版，等待 `/healthz` 明确报告 `matches: 0` 后准备新版。切换前再次确认没有运行中的对局；健康检查失败时不自动重启。空房间可能因重启而需要重新创建。
- 新版进程启动失败时恢复前一个进程和版本指针；下载/解压/准备失败保留当前游戏。旧版本目录保留在 `launcher/.runtime/versions/`，不会自动删除。
- 原项目的 build guard 会让已打开的客户端在合适的时机重新加载。通常无需重装 PWA。若设备一直停留在旧画面，可关闭应用再打开。
- **更新游戏不触发本 fork 的 Actions**。只有启动器代码或内置 Node.js 需要换版时，才再次构建启动器。

代码自更新意味着你信任 `source` 所指仓库发布的程序。额外的 `subscriptions` 只展示更新，不会下载安装任意仓库的程序。
GitHub 临时无法连接或触发 API 限额时，继续运行已安装版本，下个周期重试。第一次安装尚无可用版本时，必须先恢复网络。可选的 `GITHUB_TOKEN` 环境变量只用于 GitHub API 请求；不要把令牌写入仓库或发给其他人。

## 订阅配置

编辑 `launcher/config.json` 后重启启动器：

```json
{
  "source": "https://github.com/sganggs/Stronghold-Protocol",
  "port": 3000,
  "host": "0.0.0.0",
  "checkIntervalMinutes": 30,
  "assetPublicDirectory": "",
  "subscriptions": [
    { "url": "https://github.com/sganggs/Stronghold-Protocol", "kind": "releases" },
    { "url": "https://github.com/chenxin133/Stronghold-Protocol", "kind": "commits" }
  ]
}
```

- `source` 是唯一会被执行的游戏源；新源必须发布兼容本游戏目录结构的 `Stronghold-Protocol-v…-lite.zip`。本 fork 的 `pwa-launcher-v…` 是启动器版本，不是游戏源。
- `subscriptions` 最多 10 个 HTTPS GitHub 仓库链接，支持 `releases`（最新正式发布）或 `commits`（默认分支最新提交）。也可以粘贴仓库的 release/commit 页面链接，启动器会取其中的仓库。
- `assetPublicDirectory` 可指向已经下载好素材的游戏 `public` 目录，例如 `D:/Stronghold-Protocol/public`。相对路径以配置文件所在目录为基准；留空则在 `.runtime/shared/public` 下载并复用素材。可选本地提取素材的清单仅在游戏版本一致时导入。
- 可选的 `seedInstallation` 可指向已有整合包目录。若其版本与订阅 Release 一致，先按该安装的 `MANIFEST.json` 核对每个程序文件再复制，节省首次精简包下载；不一致或校验失败则正常下载。安装来源会记录为本地清单校验，不冒充 ZIP 摘要校验。
- `host` 默认局域网可访问的 `0.0.0.0`。若服务器只接受本机反向代理，请用 `127.0.0.1`。
- 自定义配置可以保存在被 git 忽略的 `launcher/config.local.json`，以 `Start-PWA.cmd --config config.local.json` 启动。
- 保留整个 `launcher/.runtime` 可保留已安装版本、素材及插件。不要将这个目录提交到 GitHub。游戏客户端进度仍在各设备浏览器内。

RSS 阅读器也能直接订阅：

- 原项目发布：`https://github.com/sganggs/Stronghold-Protocol/releases.atom`
- 本 fork 提交：`https://github.com/chenxin133/Stronghold-Protocol/commits/master.atom`

## HTTPS 与部署

GitHub 负责存放 fork 和下载启动包，**GitHub Pages 无法运行此游戏的 Node.js/WebSocket 服务器**。
启动包不包含云托管或自动公开这台电脑。局域网 HTTP 可先试玩；在移动设备上完整使用安装、Service Worker 和素材缓存，请使用可信 HTTPS。

有域名和云服务器时，可以把 Node.js 服务放在反向代理后。例如已经安装 Caddy 并正确配置域名解析时：

```caddyfile
game.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Caddy 需要能够完成该域名的证书验证，且三端都能访问这个地址。也可以使用自己已经配置好的 HTTPS 隧道；请保持地址固定。不要绕过浏览器证书警告。

安装依据：[PWA 可安装性与 HTTPS 要求](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)。
反向代理依据：[Caddy HTTPS](https://caddyserver.com/docs/automatic-https)、[WebSocket 转发](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

## Windows 通过 ConnectTool / Steam 联机

使用已有的 ConnectTool 时，游戏仍运行在主机 Windows 上，Steam 负责电脑之间的连接或中继，并非替你托管游戏。

1. 房主先启动游戏，确认 `http://localhost:3000/healthz` 返回 `ok: true`。
2. 两台 Windows 都运行并登录 Steam，再打开 ConnectTool。选择 **TCP 转发**；房主将 **主机目标端口** 设置为 `3000`，房间 ID 留空，创建一个非公开房间。
3. 为避免与房主自己的 3000 端口冲突，可把 ConnectTool 的 **本地监听端口** 设置为 `3001`。
4. 将 ConnectTool 房间 ID 发给参与者。参与者在自己的 ConnectTool 输入房间 ID，选择 TCP 转发，本地监听端口同样设为 `3001`，然后加入。
5. 参与者在自己的浏览器打开 `http://localhost:3001/`，再用游戏内的四位同盟密钥加入对局。**ConnectTool 房间 ID 与游戏同盟密钥是两件事。** 参与者可以从 Edge/Chrome 将这个 localhost 入口安装为应用。

TCP 转发同时承载本游戏的 HTTP 与 WebSocket；无需 TUN 虚拟网卡，也不需要为此修改全局路由。实际直连/中继质量取决于两端网络；只有第二台电脑加入并加载游戏后，才能确认跨网链路已通。首次加载素材流量较大，可使用游戏原有的导入素材包功能。

截至本次核查，ConnectTool 官方列出 Windows/Linux/macOS，Android 仍在待开发列表中，没有可直接供 iPad 使用的客户端。其官方说明还提示 Steam 账号使用风险；请自行决定使用哪个账号。[ConnectTool 官方说明](https://github.com/moeleak/connecttool-qt)。

## 从源码启动与首次打包

需要 Node.js 22+；在仓库根目录执行：

```powershell
npm ci --prefix launcher
node launcher/server.mjs
```

首次通过 GitHub 制作便携包：Actions → **Build PWA server launcher** → Run workflow。工作流测试启动器、下载并校验固定版本的官方 Node.js，发布启动 ZIP 和 `.sha256` 校验文件到 `pwa-launcher-v<版本>`。该工作流只有手动触发，没有游戏更新定时构建。

本地验证/打包：

```powershell
npm test --prefix launcher
node launcher/package.mjs
```

源代码、第三方依赖及游戏素材遵循原项目的 LICENSE、NOTICE.md 和 THIRD-PARTY-NOTICES.md；仅供个人非商业使用。
