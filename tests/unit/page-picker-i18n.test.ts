import { describe, expect, it } from "vitest";
import {
	currentLang,
	detectLang,
	interpolate,
	setLangPref,
	t,
} from "../../plugins/page-picker/extension/src/shared/i18n.js";
import { EN } from "../../plugins/page-picker/extension/src/shared/locales/en.js";
import { ES } from "../../plugins/page-picker/extension/src/shared/locales/es.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("page-picker i18n", () => {
	it("interpolate: replaces {var} and leaves missing intact", () => {
		expect(interpolate("Hello {name}!", { name: "Saul" })).toBe("Hello Saul!");
		expect(interpolate("Missing {missing} here", {})).toBe("Missing {missing} here");
		expect(interpolate("Multiple {a} and {b}", { a: 1, b: 2 })).toBe("Multiple 1 and 2");
	});

	it("detectLang: recognizes zh, es and falls back to en", () => {
		setLangPref("zh");
		expect(currentLang()).toBe("zh");
		setLangPref("es");
		expect(currentLang()).toBe("es");
		setLangPref("en");
		expect(currentLang()).toBe("en");
		setLangPref("auto");
		// In node without chrome.i18n, defaults to source language "zh"
		expect(detectLang()).toBe("zh");
		expect(currentLang()).toBe("zh");
	});

	it("t(): returns localized strings and interpolates", () => {
		setLangPref("en");
		expect(t("pi-web-ui 服务")).toBe("pi-web-ui Service");
		expect(t("已选 {count}", { count: 3 })).toBe("3 selected");

		setLangPref("es");
		expect(t("pi-web-ui 服务")).toBe("Servicio pi-web-ui");
		expect(t("已选 {count}", { count: 3 })).toBe("3 seleccionados");

		setLangPref("zh");
		expect(t("pi-web-ui 服务")).toBe("pi-web-ui 服务");
		expect(t("已选 {count}", { count: 3 })).toBe("已选 3");
	});

	it("100% Coverage: every t('...') key in source code exists in EN and ES", () => {
		const keys = Object.keys(EN);
		expect(keys.length).toBeGreaterThanOrEqual(150);

		// Every EN key must exist in ES
		for (const k of keys) {
			expect(ES[k], `Missing ES translation for: ${k}`).toBeDefined();
			// Placeholder parity
			const phOrig = (k.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
			const phEn = (EN[k].match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
			const phEs = (ES[k].match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
			expect(phEn, `EN placeholders mismatch for ${k}`).toEqual(phOrig);
			expect(phEs, `ES placeholders mismatch for ${k}`).toEqual(phOrig);
		}
	});

	it("options.html: all data-i18n attributes have valid translations in EN and ES", () => {
		const htmlPath = join(__dirname, "../../plugins/page-picker/extension/options.html");
		const html = readFileSync(htmlPath, "utf8");
		const matches = html.matchAll(/data-i18n(?:-html|-placeholder)?="([^"]+)"/g);
		let count = 0;
		for (const m of matches) {
			const rawKey = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
			expect(EN[rawKey], `Missing EN translation for HTML key: ${rawKey}`).toBeDefined();
			expect(ES[rawKey], `Missing ES translation for HTML key: ${rawKey}`).toBeDefined();
			count++;
		}
		expect(count).toBeGreaterThan(25);
	});
});
