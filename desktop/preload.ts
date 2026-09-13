/**
 * desktop preload — 只暴露最小只读信息。业务全部走 HTTP/WS，
 * 不走 IPC，避免和 web/ 现有协议分叉。
 */
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("piDesktop", {
	isDesktop: true as const,
	versions: {
		electron: process.versions.electron,
		chrome: process.versions.chrome,
		node: process.versions.node,
	} as const,
});
