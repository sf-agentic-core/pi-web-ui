/**
 * pi-web-ui desktop shell (Electron, sidecar 模式).
 *
 * 设计：不碰 server/ 现有逻辑。主进程用 ELECTRON_RUN_AS_NODE 把
 * Electron 二进制当纯 Node 用，起一个 `dist/server/index.js` 子进程
 * （127.0.0.1 + 随机空闲口），等 /api/health 就绪后 BrowserWindow
 * 直接 load 该地址。前端继续走 appUrl("/ws") + location.host，
 * protocol.ts 零改动——和浏览器访问远端 server 是同一条路。
 *
 * 运行前先 `npm run build`（需要 dist/server + web/dist）。
 * 开发联调：PI_WEB_DESKTOP_URL=http://localhost:5173 可让窗口指到 vite。
 */
import { app, BrowserWindow, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** 开发：dist/desktop → dist/server；打包后：asar 关闭，app 目录即根布局（dist/server + web/dist + themes）。 */
function resolveServerEntry(): string {
	if (app.isPackaged) {
		return join(app.getAppPath(), "dist", "server", "index.js");
	}
	return join(here, "..", "server", "index.js");
}

function resolveWebDir(): string | null {
	// 打包后静态资源由 server 自己从 web/dist 提供（与 npm 包一致），此处仅 dev 兜底检查。
	const devWeb = join(here, "..", "..", "web", "dist", "index.html");
	if (!app.isPackaged && !existsSync(join(here, "..", "server", "index.js"))) {
		console.error("✖ 找不到 dist/server/index.js，请先跑 `npm run build`");
		process.exit(1);
	}
	return devWeb;
}

/** 取一个系统分配的空闲 TCP 口（桌面模式不用固定 8787，避免和网页版冲突）。 */
function pickFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			s.close(() => {
				if (addr && typeof addr === "object") resolve(addr.port);
				else reject(new Error("pickFreePort: bad address"));
			});
		});
	});
}

/** 该端口现在能不能绑（能绑 = 空闲）。 */
function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createServer();
		s.once("error", () => resolve(false));
		s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
	});
}

/**
 * 端口：默认随机空闲口。`PI_WEB_PORT` 显式指定时优先，但**已被占用就退回随机口**——
 * 从 pi-web-ui 自己的终端里跑 `desktop:dev` 会继承它的 `PI_WEB_PORT=8787`，
 * 硬用该值只会让 sidecar 一启动就 EADDRINUSE 崩掉（窗口转而连上那个网页版 server）。
 */
async function resolvePort(): Promise<number> {
	const want = Number(process.env.PI_WEB_PORT ?? 0);
	if (want > 0) {
		if (await isPortFree(want)) return want;
		console.warn(`[desktop] PI_WEB_PORT=${want} 已被占用，改用随机空闲口（不影响在跑的那个 server）`);
	}
	return pickFreePort();
}

/** /api/health 轮询：server 就绪后再建窗口，避免白屏。 */
async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const res = await fetch(`${url}/api/health`);
			if (res.ok) return;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > deadline) throw new Error(`server 未在 ${timeoutMs}ms 内就绪：${url}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

let serverProc: ChildProcess | null = null;
let mainWin: BrowserWindow | null = null;
let serverHealthy = false;

console.log("[desktop] main started, waiting for app ready…");

async function startServerSidecar(): Promise<string> {
	const override = process.env.PI_WEB_DESKTOP_URL;
	if (override) return override; // 指向 vite(:5173) 联调，前提是另起 dev:server
	const entry = resolveServerEntry();
	resolveWebDir();
	console.log(`[desktop] server entry: ${entry}`);
	const port = await resolvePort();
	const dataDir = process.env.PI_WEB_DATA_DIR ?? join(app.getPath("userData"), "data");
	const cwd = process.env.PI_WEB_CWD ?? homedir();
	console.log(`[desktop] spawning server on 127.0.0.1:${port} (data: ${dataDir})`);
	// ELECTRON_RUN_AS_NODE=1：让 Electron 二进制退化成纯 Node 跑 server，
	// 无需额外捆一个 node，也不用改 server/index.ts。
	serverProc = spawn(process.execPath, [entry, "--host", "127.0.0.1", "--port", String(port)], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_PORT: String(port),
			PI_WEB_CWD: cwd,
			PI_WEB_DATA_DIR: dataDir,
		},
		stdio: "inherit",
		windowsHide: true,
	});
	serverProc.on("error", (err) => {
		console.error(`[desktop] server spawn 失败：${err.message}`);
		if (!serverHealthy) app.quit();
	});
	serverProc.on("exit", (code, signal) => {
		console.error(`[desktop] server 提前退出（code=${code} signal=${signal}），请看上方 server 日志`);
		if (!serverHealthy) app.quit();
	});
	const url = `http://127.0.0.1:${port}`;
	await waitForHealth(url);
	serverHealthy = true;
	console.log(`[desktop] server 就绪：${url}`);
	return url;
}

async function createWindow(url: string): Promise<void> {
	mainWin = new BrowserWindow({
		width: 1280,
		height: 860,
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(here, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	console.log(`[desktop] opening window: ${url}`);
	try {
		await mainWin.loadURL(url);
	} catch (err) {
		console.error(`[desktop] loadURL 失败：${(err as Error).message}`);
	}
	// 外链（更新日志/插件主页等）丢给系统浏览器，别在应用窗口里导航走。
	mainWin.webContents.setWindowOpenHandler(({ url: u }) => {
		void shell.openExternal(u);
		return { action: "deny" };
	});
	mainWin.on("closed", () => {
		mainWin = null;
	});
}

// 单实例：第二个实例聚焦已有窗口（和网页版多标签页各走独立 clientId 不冲突）。
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWin) {
			if (mainWin.isMinimized()) mainWin.restore();
			mainWin.focus();
		}
	});
}

// ⚠️ 绝对不要在 ESM 主进程顶层 `await app.whenReady()`（Electron 44 实测死锁）：
// Electron 要等入口模块求值完成才发 ready 事件，顶层 await ready = 互相死等——
// 进程挂在 "waiting for app ready…"，窗口永远不开（改成 .then 回调里 await 即可）。
void app.whenReady().then(async () => {
	console.log("[desktop] app ready");
	try {
		const url = await startServerSidecar();
		await createWindow(url);
	} catch (err) {
		console.error("✖ 桌面版启动失败：", err);
		app.quit();
	}
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
	// macOS 点 dock 时窗口已关：server sidecar 还在，本骨架暂不重建窗口，退出重进即可。
	if (BrowserWindow.getAllWindows().length === 0) app.quit();
});
app.on("will-quit", () => {
	serverProc?.kill();
	serverProc = null;
});
