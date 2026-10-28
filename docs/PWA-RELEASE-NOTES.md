Windows、iPad、Android 共用一个 PWA 游戏服务器。

- Windows 下载 ZIP 后解压，双击 `Start-PWA.cmd`；已内置 Node.js，首次准备游戏需要联网。
- 服务器直接订阅原作者的正式 Release，默认每 30 分钟检查一次；空闲时升级，启动失败时回退。
- iPad 和 Android 使用服务器的可信 HTTPS 地址添加到主屏幕。客户端不需要重打包，游戏更新不需要重新运行 Actions。
- `http://localhost:3000/subscriptions/` 显示版本和 GitHub RSS 订阅链接。
- 首次可能需要下载约 720 MB 素材；可以在 `launcher/config.json` 指定已有的 `public` 素材目录。
- 服务器需要保持运行；PWA 不能替代 Node.js 服务器离线开局。此 ZIP 不包含托管服务或公网 HTTPS 地址。

仅供个人非商业使用。代码及游戏素材的许可见包内 LICENSE、NOTICE.md 和 THIRD-PARTY-NOTICES.md。
