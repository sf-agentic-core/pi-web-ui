# 桌面版（Electron sidecar）

网页版零改动。桌面壳只是“本地 server + 本地窗口”的组合：

```
Electron 主进程 (desktop/main.ts)
  └─ spawn(ELECTRON_RUN_AS_NODE) → node dist/server/index.js --host 127.0.0.1 --port <随机>
  └─ BrowserWindow → http://127.0.0.1:<随机>/
```

前端继续走 `appUrl("/ws")` + `location.host`（见 `web/src/use-chat.ts`），
和浏览器连远端 server 同一条路，`server/protocol.ts` 不动。

## 跑起来

```bash
npm ci                   # 拉 electron + electron-builder（devDeps）
npm run build            # 先产出 dist/server + web/dist（桌面壳直接复用）
npm run desktop:dev      # Electron 指到本地 sidecar（http://127.0.0.1:<随机>）
# 联调前端：另开 npm run dev:server(:8788) + vite(:5173)，再
PI_WEB_DESKTOP_URL=http://localhost:5173 npm run desktop:dev
npm run desktop:dist     # 本地打包（产物在 release/，已 gitignore）
```

## 约定

- 端口：随机空闲口，不抢 `8787`，可与网页版/全局安装并存。`PI_WEB_PORT` 显式指定时优先，
  但**已占用就退回随机口**（从 pi-web-ui 自己的终端里跑 `desktop:dev` 会继承它的 `PI_WEB_PORT=8787`）。
- 图标：复用网页版的 `web/public/icons/icon-1024.png`，electron-builder 自己转 `.ico`/`.icns`，
  换图标只改这一处（网页版 PWA 图标同步变）。
- 数据：`PI_WEB_DATA_DIR` 默认 `<userData>/data`，和 `~/.pi-web` 隔离；
  `PI_WEB_CWD` 默认用户主目录，可用同名 env 覆盖。
- 单实例锁：`requestSingleInstanceLock()`。
- 安全：`contextIsolation + sandbox`，renderer 无 node，外链走系统浏览器。
- **ESM 主进程禁止顶层 `await app.whenReady()`**：Electron 要等入口模块求值完成才发 ready
  事件，顶层 await 它 = 互相死等——进程卡在 `waiting for app ready…`、窗口永远不开。
  在模块求值结束后（`app.whenReady().then(...)` 回调里）await 才是安全的，其它顶层 await 无影响。
- 与网页版共存：端口（随机口）、数据目录（`<userData>/data`）、控制 socket（按端口命名）、单实例锁都隔开，
  唯一共享的是 `~/.pi/agent`（`agentDir`：pi 配置、认证、**会话记录**）——好处是桌面版不用重新配置，
  代价是**别在两边同时操作同一个对话**（两个 server 写同一份 transcript）。想彻底隔离就给桌面版设
  `PI_CODING_AGENT_DIR`（`server/agent-service.ts` 读这个 env）。
- `electron-builder.yml` 里 `npmRebuild: false`：node-pty 1.1.0 是 N-API 预编译，
  在 `ELECTRON_RUN_AS_NODE` 下能直接 `require`，不需要按 Electron ABI 重编（否则打包强依赖本机 Visual Studio）。

## 发布（当前无证书）

CI 负责出包并挂到 GitHub Release：`.github/workflows/desktop-release.yml`
在 tag 推送后并行跑三个 job（都是 `npm run build` + `build:desktop` + `electron-builder`）：

| job               | runner           | 目标               | 产物                                 |
| ----------------- | ---------------- | ------------------ | ------------------------------------ |
| windows-installer | `windows-latest` | `--win`（NSIS）    | `*.exe` + `.blockmap` + `latest.yml` |
| macos-installer   | `macos-latest`   | `--mac`（dmg）     | `*.dmg` + `latest-mac.yml`           |
| linux-installer   | `ubuntu-latest`  | `--linux AppImage` | `*.AppImage` + `latest-linux.yml`    |

三者都把产物附到该 tag 的 Release（`--clobber`，可重推 tag 重跑）——
**签名必须发生在这个 workflow 里**，SignPath 只签 CI 产物，本地 `npm run desktop:dist` 永远签不上。
手动空跑（只出 workflow artifact、不动 Release 资产）：Actions → Desktop installer → Run workflow。

现在三平台产物都**未签名**：Windows 首启有 SmartScreen「未知发布者」提示；
macOS 的 Gatekeeper 更硬，首次要右键 → 打开；Linux AppImage 无签名概念。功能都不受影响。

## 签名

本地打包时 electron-builder 认环境变量，给了就自动签（不改配置）：

```bash
# Windows（.pfx；CSC_LINK 也接受 base64 串或 https URL）
CSC_LINK=/abs/path/cert.pfx CSC_KEY_PASSWORD=xxx npm run desktop:dist

# macOS（.p12）+ 公证，需 Apple 账号三件套（后两项用 App 专用密码）
CSC_LINK=/abs/path/cert.p12 CSC_KEY_PASSWORD=xxx \
APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=xxxx APPLE_TEAM_ID=XXXXXXXXXX \
  npm run desktop:dist
```

[SignPath Foundation](https://signpath.org)（免费给 OSS）：**证书签发给 Foundation 本身**，
所以 Windows 上显示的发布者是 “SignPath Foundation”，不是本项目作者；条款、Code of Conduct、
首页「Code signing policy」段（见仓库 README）与 MFA 都是硬要求。获批后按
`desktop-release.yml` 里那段 TODO 注释接线（参数以他们给的文档为准），届时会有签名版本。

其它来源：商业 CA（OV/EV）、Azure Trusted Signing（按量付费）。
**自签名证书不解决问题**——SmartScreen 判的是「可追溯到受信任根的发布者」，自签一样会拦。
macOS 的 Gatekeeper/公证 SignPath 帮不上，只能走 Apple Developer ID。

## 下一步（不在本骨架里）

1. `server/index.ts` 拆 `startServer(opts)` → 主进程可 in-process 内嵌，
   省掉 sidecar 进程（大改，需另起 PR，先保证冒烟全过）。
2. `node-pty` 换 `@lydell/node-pty` + `electron-rebuild`，删 `patch-node-pty.ts`。
3. 自动更新（electron-updater）替代 `server install` 开机自启。
