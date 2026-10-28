Windows 完整游戏与 ConnectTool 联机整合包（启动器 1.2.0）。

- **已内置 ConnectTool v1.6.0 官方 Windows 程序及完整运行库**，不是只提供下载链接。打包时校验固定 SHA-256，并运行其 QML 启动检查。
- **已内置游戏完整包、素材及依赖**，修复换一台电脑只打开 ConnectTool、游戏仍停在首次 `Preparing` 下载的问题。无需首次运行再下载游戏或约 720 MB 素材。
- 构建时在全新临时运行目录阻断外网，验证实际游戏、数据、前端 JS 和图片均可加载；压缩完成后还会检查 ZIP 内确实包含游戏文件与素材。
- 双击 `Start-Online.cmd` 选择开服/加入，或直接使用 `Host-Game.cmd` / `Join-Game.cmd`。开服同时启动游戏服务器与 ConnectTool，加入端只启动 ConnectTool；连通后自动打开游戏窗口。
- 请先登录 Steam，并在 ConnectTool 窗口选择 TCP 转发，设置主机目标端口 `3000`、本地监听端口 `3001`，再创建/加入房间。房间操作不会由启动器代替执行。
- 单机或局域网也可以双击 `Start-PWA.cmd`。已内置 Node.js，游戏可直接离线启动；Steam 异地联机仍需要网络和 Steam 登录。
- 服务器直接订阅原作者的正式 Release，默认每 30 分钟检查一次；空闲时升级，启动失败时回退。
- iPad 和 Android 使用服务器的可信 HTTPS 地址添加到主屏幕。客户端不需要重打包，游戏更新不需要重新运行 Actions。
- `http://localhost:3000/subscriptions/` 显示版本和 GitHub RSS 订阅链接。
- 更新页也订阅 ConnectTool 的正式发布；本包固定内置 v1.6.0，额外订阅不会自动替换正在运行的联机程序。
- 手动安装的原版完整包也可放在整合包的 `game/` 或 `game/Stronghold-Protocol/` 中；缺少内置游戏时会自动识别，或用 `seedInstallation` 指定其他目录，不再先等待 GitHub 请求。
- 服务器需要保持运行；PWA 不能替代 Node.js 服务器离线开局。此 ZIP 不包含托管服务或公网 HTTPS 地址。

仅供个人非商业使用。代码及游戏素材的许可见包内 LICENSE、NOTICE.md 和 THIRD-PARTY-NOTICES.md。
