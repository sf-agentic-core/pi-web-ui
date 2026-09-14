/**
 * 推送端点校验与订阅记录归一化单测（server/push/store.ts 的纯函数部分）。
 *
 * 这里的核心是 **SSRF**：端点是客户端给的、服务端稍后会去 POST 的 URL。
 * 规则要保守到能挡住「打内网 / 打云 metadata」，又不能保守到把自建推送网关
 * （ntfy、Nextcloud、Matrix）一刀切掉。
 */
import { describe, expect, it } from "vitest";
import {
	decidePushOutcome,
	isAllowedPushEndpoint,
	MAX_ENDPOINT_LENGTH,
	normalizePushSubscription,
	sanitizeUserAgent,
} from "../../server/push/store.js";

const P256DH = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x11)]).toString("base64url");
const AUTH = Buffer.alloc(16, 0x22).toString("base64url");

const validInput = {
	endpoint: "https://fcm.googleapis.com/wp/abc123",
	keys: { p256dh: P256DH, auth: AUTH },
};

describe("isAllowedPushEndpoint", () => {
	it("放行真实的推送服务", () => {
		expect(isAllowedPushEndpoint("https://fcm.googleapis.com/wp/abc")).toBe(true);
		expect(isAllowedPushEndpoint("https://up.push.mozilla.com/x/y?z=1")).toBe(true);
		expect(isAllowedPushEndpoint("https://web.push.apple.com/QQ")).toBe(true);
		expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
	});

	it("放行自建推送网关（带端口/子路径也要放行）", () => {
		expect(isAllowedPushEndpoint("https://push.example.com/a/b")).toBe(true);
		expect(isAllowedPushEndpoint("https://push.example.com:8443/sub")).toBe(true);
		expect(isAllowedPushEndpoint("https://ntfy.mydomain.dev/topic")).toBe(true);
	});

	it("只允许 https", () => {
		expect(isAllowedPushEndpoint("http://fcm.googleapis.com/wp/abc")).toBe(false);
		expect(isAllowedPushEndpoint("ftp://fcm.googleapis.com/x")).toBe(false);
		// 大小写混写也一样
		expect(isAllowedPushEndpoint("HtTp://fcm.googleapis.com/x")).toBe(false);
	});

	it("拒绝所有形式的 IP 字面量（含云 metadata 与十进制/十六进制变体）", () => {
		expect(isAllowedPushEndpoint("https://127.0.0.1/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://169.254.169.254/latest/meta-data")).toBe(false);
		expect(isAllowedPushEndpoint("https://10.0.0.5/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://[::1]/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://[fd00::1]/x")).toBe(false);
		// WHATWG URL 会把这两种写法归一成 127.0.0.1，归一后必须被挡住
		expect(isAllowedPushEndpoint("https://2130706433/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://0x7f.0.0.1/x")).toBe(false);
	});

	it("拒绝内网/保留主机名与单标签主机名", () => {
		expect(isAllowedPushEndpoint("https://localhost/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://push.localhost/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://push.local/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://metadata.google.internal/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://push.home.arpa/x")).toBe(false);
		// 单标签（无点）只在本地可解析
		expect(isAllowedPushEndpoint("https://pushserver/x")).toBe(false);
	});

	it("拒绝 URL 里带凭据", () => {
		expect(isAllowedPushEndpoint("https://user:pass@fcm.googleapis.com/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://user@fcm.googleapis.com/x")).toBe(false);
	});

	it("拒绝超长、空值和非字符串", () => {
		expect(isAllowedPushEndpoint(`https://fcm.googleapis.com/${"a".repeat(MAX_ENDPOINT_LENGTH)}`)).toBe(false);
		expect(isAllowedPushEndpoint("")).toBe(false);
		expect(isAllowedPushEndpoint(undefined)).toBe(false);
		expect(isAllowedPushEndpoint(42)).toBe(false);
		expect(isAllowedPushEndpoint("not a url")).toBe(false);
	});
});

describe("sanitizeUserAgent", () => {
	it("压成单行、去控制字符、截断", () => {
		expect(sanitizeUserAgent("Mozilla/5.0 (X11; Linux)\n\tChrome/142")).toBe("Mozilla/5.0 (X11; Linux) Chrome/142");
		expect(sanitizeUserAgent("a\u0000b")).toBe("a b");
		expect(sanitizeUserAgent("x".repeat(300)).length).toBe(120);
	});

	it("非字符串给空串", () => {
		expect(sanitizeUserAgent(undefined)).toBe("");
		expect(sanitizeUserAgent({})).toBe("");
	});
});

describe("normalizePushSubscription", () => {
	const context = { clientId: "client-1", userAgent: "Chrome/142", now: 1_700_000_000_000 };

	it("合法输入 → 完整记录", () => {
		const record = normalizePushSubscription(validInput, context);
		expect(record).toEqual({
			endpoint: "https://fcm.googleapis.com/wp/abc123",
			p256dh: P256DH,
			auth: AUTH,
			clientId: "client-1",
			label: "Chrome/142",
			createdAt: 1_700_000_000_000,
		});
	});

	it("端点不合法 → null（同一套 SSRF 规则）", () => {
		expect(normalizePushSubscription({ ...validInput, endpoint: "https://10.0.0.1/x" }, context)).toBeNull();
	});

	it("p256dh 必须是 65 字节且以 0x04 开头", () => {
		expect(
			normalizePushSubscription(
				{ ...validInput, keys: { p256dh: Buffer.alloc(64, 1).toString("base64url"), auth: AUTH } },
				context,
			),
		).toBeNull();
		expect(
			normalizePushSubscription(
				{
					...validInput,
					keys: { p256dh: Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 1)]).toString("base64url"), auth: AUTH },
				},
				context,
			),
		).toBeNull();
		// 长度对但内容不是 base64url：Buffer 解码器会静默跳过非法字符，必须自己挡
		expect(
			normalizePushSubscription({ ...validInput, keys: { p256dh: "!".repeat(88), auth: AUTH } }, context),
		).toBeNull();
	});

	it("auth 必须是 16 字节", () => {
		expect(
			normalizePushSubscription(
				{ ...validInput, keys: { p256dh: P256DH, auth: Buffer.alloc(15, 1).toString("base64url") } },
				context,
			),
		).toBeNull();
		expect(normalizePushSubscription({ ...validInput, keys: { p256dh: P256DH, auth: "" } }, context)).toBeNull();
	});

	it("缺 keys / 结构不对 → null", () => {
		expect(normalizePushSubscription({ endpoint: validInput.endpoint }, context)).toBeNull();
		expect(normalizePushSubscription({ ...validInput, keys: {} }, context)).toBeNull();
		expect(normalizePushSubscription(null, context)).toBeNull();
		expect(normalizePushSubscription("nope", context)).toBeNull();
	});

	it("没有 clientId 不收（它是设备身份，也是 unsubscribe 的键）", () => {
		expect(normalizePushSubscription(validInput, { ...context, clientId: "" })).toBeNull();
		expect(normalizePushSubscription(validInput, { ...context, clientId: undefined })).toBeNull();
	});
});

describe("decidePushOutcome", () => {
	it("2xx = 成功", () => {
		for (const status of [200, 201, 202, 204]) expect(decidePushOutcome(status)).toBe("ok");
	});

	it("404/410 = 订阅已失效，可以删（RFC 8030 §5.5）", () => {
		expect(decidePushOutcome(404)).toBe("prune");
		expect(decidePushOutcome(410)).toBe("prune");
	});

	it("429/5xx = 暂时性，保留条目", () => {
		for (const status of [429, 500, 502, 503]) expect(decidePushOutcome(status)).toBe("retry");
	});

	it("403 不删（通常是 VAPID 凭据不匹配，删掉等于每次轮换密钥都静默丢订阅）", () => {
		expect(decidePushOutcome(403)).toBe("error");
		expect(decidePushOutcome(400)).toBe("error");
		expect(decidePushOutcome(401)).toBe("error");
	});
});
