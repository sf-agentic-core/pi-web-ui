/**
 * RFC 8291 / RFC 8292 单测：Web Push 加密与 VAPID 授权（server/push/ece.ts）。
 *
 * 这个文件是整个功能的**硬门禁**：它把 RFC 8291 §5 的官方示例逐字节复现
 * （salt、key schedule 全部中间值、密文、86 字节头部）。任何改动只要偏了
 * 一位，这里立刻红 —— 而一旦偏了，真实后果是「push 静默不发」，在生产环境
 * 里几乎排不出来。
 *
 * 之所以自己实现而不用 web-push：见 ece.ts 顶部注释（依赖 + 官方向量）。
 */
import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildVapidAuthorization,
	encryptPushMessage,
	isConsistentKeyPair,
	P256_PUBLIC_KEY_BYTES,
	PUSH_MAX_PLAINTEXT_BYTES,
	PUSH_RECORD_SIZE,
	vapidAudience,
	VAPID_DEFAULT_TTL_SECONDS,
	type PushKeyPair,
} from "../../server/push/ece.js";

const b64 = (s: string): Buffer => Buffer.from(s.replace(/\s/g, ""), "base64url");

/** RFC 8291 §5 —— 官方示例的全部输入与中间值。 */
const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
	prkKey: "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k",
	ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
	cek: "oIhVW04MRdy2XN9CiKLxTg",
	nonce: "4h_95klXJ5E_qnoN",
	ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
	body:
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const rfcKeyPair: PushKeyPair = { privateKey: b64(RFC.asPrivate), publicKey: b64(RFC.asPublic) };

/** 用于独立校验签名：把裸公钥还原成 KeyObject。 */
function publicKeyObject(keyPair: PushKeyPair) {
	return createPublicKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x: keyPair.publicKey.subarray(1, 33).toString("base64url"),
			y: keyPair.publicKey.subarray(33, 65).toString("base64url"),
		},
		format: "jwk",
	});
}

describe("encryptPushMessage —— RFC 8291 §5 官方向量", () => {
	const body = encryptPushMessage({
		plaintext: Buffer.from(RFC.plaintext, "utf8"),
		uaPublicKey: b64(RFC.uaPublic),
		authSecret: b64(RFC.authSecret),
		keyPair: rfcKeyPair,
		salt: b64(RFC.salt),
	});

	it("整条消息体逐字节等于 RFC（86 字节头 + 单条记录）", () => {
		expect(body.toString("base64url")).toBe(RFC.body.replace(/\s/g, ""));
	});

	it("头部 = salt(16) || rs=4096(4) || keyid_len=65(1) || as_public(65)", () => {
		const header = body.subarray(0, 86);
		expect(header.length).toBe(86);
		expect(header.subarray(0, 16)).toEqual(b64(RFC.salt));
		expect(header.readUInt32BE(16)).toBe(PUSH_RECORD_SIZE);
		expect(header[20]).toBe(P256_PUBLIC_KEY_BYTES);
		expect(header.subarray(21, 86)).toEqual(b64(RFC.asPublic));
	});

	it("密文（含 GCM tag）等于 RFC 的 58 字节", () => {
		// 明文 41 + 0x02 padding 1 + GCM tag 16 = 58。
		// RFC 的 `Content-Length: 145` 那一行与它自己的中间值对不上（86 头 +
		// 41/42/16 只能是 144）：这里按解码后的字节断言，尺寸链条自洽即可。
		expect(body.subarray(86).length).toBe(58);
		expect(body.length).toBe(144);
		expect(body.subarray(86).toString("base64url")).toBe(RFC.ciphertext);
	});

	it("同一条消息重复加密结果一致（salt 注入时是纯函数）", () => {
		const again = encryptPushMessage({
			plaintext: Buffer.from(RFC.plaintext, "utf8"),
			uaPublicKey: b64(RFC.uaPublic),
			authSecret: b64(RFC.authSecret),
			keyPair: rfcKeyPair,
			salt: b64(RFC.salt),
		});
		expect(again.equals(body)).toBe(true);
	});

	it("不注入 salt 时每次都用新随机值（同一明文的密文不同）", () => {
		const options = {
			plaintext: Buffer.from("ping", "utf8"),
			uaPublicKey: b64(RFC.uaPublic),
			authSecret: b64(RFC.authSecret),
			keyPair: rfcKeyPair,
		};
		const a = encryptPushMessage(options);
		const b = encryptPushMessage(options);
		expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
	});
});

describe("encryptPushMessage —— 输入校验", () => {
	const base = {
		plaintext: Buffer.from("x", "utf8"),
		uaPublicKey: b64(RFC.uaPublic),
		authSecret: b64(RFC.authSecret),
		keyPair: rfcKeyPair,
	};

	it("明文超过 3993 字节直接拒绝（RFC 8291 §4 上限）", () => {
		expect(() => encryptPushMessage({ ...base, plaintext: Buffer.alloc(PUSH_MAX_PLAINTEXT_BYTES) })).not.toThrow();
		expect(() => encryptPushMessage({ ...base, plaintext: Buffer.alloc(PUSH_MAX_PLAINTEXT_BYTES + 1) })).toThrow(
			/too large/,
		);
	});

	it("用户代理公钥必须是 65 字节且以 0x04 开头", () => {
		expect(() => encryptPushMessage({ ...base, uaPublicKey: Buffer.alloc(64) })).toThrow(/user agent public key/);
		expect(() =>
			encryptPushMessage({ ...base, uaPublicKey: Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64)]) }),
		).toThrow(/user agent public key/);
	});

	it("auth secret 必须是 16 字节", () => {
		expect(() => encryptPushMessage({ ...base, authSecret: Buffer.alloc(15) })).toThrow(/auth secret/);
	});

	it("密钥对自身不自洽时拒绝（否则客户端根本解不开）", () => {
		const broken: PushKeyPair = { privateKey: b64(RFC.asPrivate), publicKey: b64(RFC.uaPublic) };
		expect(() => encryptPushMessage({ ...base, keyPair: broken })).toThrow(/inconsistent/);
		expect(isConsistentKeyPair(broken)).toBe(false);
		expect(isConsistentKeyPair(rfcKeyPair)).toBe(true);
	});

	it("不在曲线上的公钥被 node 的 ECDH 拒绝（RFC 8291 §7 要求的校验）", () => {
		const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x01)]);
		expect(() => encryptPushMessage({ ...base, uaPublicKey: offCurve })).toThrow();
	});
});

describe("buildVapidAuthorization —— RFC 8292", () => {
	const expires = 1_700_000_000;
	const header = buildVapidAuthorization("https://fcm.googleapis.com/wp/abc123", rfcKeyPair, {
		subject: "https://pi-web-ui.invalid",
		nowSeconds: expires - VAPID_DEFAULT_TTL_SECONDS,
	});

	const parse = () => {
		const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
		if (!match) throw new Error(`unexpected header: ${header}`);
		const [headerPart, payloadPart, signaturePart] = (match[1] ?? "").split(".");
		return {
			k: match[2] ?? "",
			signingInput: Buffer.from(`${headerPart}.${payloadPart}`, "utf8"),
			signature: b64(signaturePart ?? ""),
			jwtHeader: JSON.parse(b64(headerPart ?? "").toString("utf8")) as Record<string, unknown>,
			claims: JSON.parse(b64(payloadPart ?? "").toString("utf8")) as Record<string, unknown>,
		};
	};

	it("格式为 `vapid t=<jwt>, k=<公钥>`", () => {
		expect(header.startsWith("vapid t=")).toBe(true);
		expect(parse().k).toBe(RFC.asPublic.replace(/\s/g, ""));
	});

	it("JWT 头是 ES256/JWT", () => {
		expect(parse().jwtHeader).toEqual({ typ: "JWT", alg: "ES256" });
	});

	it("aud 必须是推送端点的 origin（push service 会校验）", () => {
		expect(parse().claims.aud).toBe("https://fcm.googleapis.com");
		expect(vapidAudience("https://up.push.mozilla.com/x/y?z=1")).toBe("https://up.push.mozilla.com");
		// 子路径部署/端口都要保留
		expect(vapidAudience("https://example.com:8443/push/a")).toBe("https://example.com:8443");
	});

	it("exp 使用注入的时钟，sub 原样带上", () => {
		expect(parse().claims.exp).toBe(expires);
		expect(parse().claims.sub).toBe("https://pi-web-ui.invalid");
	});

	it("签名是 64 字节裸 R||S，且能用 k 参数独立验签", () => {
		const { signingInput, signature } = parse();
		expect(signature.length).toBe(64);
		expect(
			verify("sha256", signingInput, { key: publicKeyObject(rfcKeyPair), dsaEncoding: "ieee-p1363" }, signature),
		).toBe(true);
	});

	it("拒绝超过 24 小时的 TTL（部分 push service 会直接拒）", () => {
		expect(() =>
			buildVapidAuthorization("https://fcm.googleapis.com/wp/a", rfcKeyPair, {
				subject: "x",
				ttlSeconds: 24 * 3600 + 1,
			}),
		).toThrow(/ttl/);
		expect(() =>
			buildVapidAuthorization("https://fcm.googleapis.com/wp/a", rfcKeyPair, { subject: "x", ttlSeconds: 0 }),
		).toThrow(/ttl/);
	});

	it("keyid 与 VAPID k 是同一把公钥（规范要求同一密钥对两用）", () => {
		const body = encryptPushMessage({
			plaintext: Buffer.from("ping", "utf8"),
			uaPublicKey: b64(RFC.uaPublic),
			authSecret: b64(RFC.authSecret),
			keyPair: rfcKeyPair,
		});
		expect(body.subarray(21, 86).toString("base64url")).toBe(parse().k);
	});
});
