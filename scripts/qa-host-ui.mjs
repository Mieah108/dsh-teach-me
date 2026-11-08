#!/usr/bin/env node
import { hostPrimitiveAssets } from './host-ui-primitives.mjs';
/**
 * Host UI bench：把 client.js 的三个宿主承载面（设置页 / 选课侧栏 / 课堂侧栏）用真 React、
 * 真宿主样式表、真浏览器渲染出来，按 状态 × 明暗 × 宽度 截图。
 *
 * 用法：
 *   node scripts/qa-host-ui.mjs --out artifacts/host-ui/before
 *   node scripts/qa-host-ui.mjs --out artifacts/host-ui/after --only settings,courses --theme dark
 *   node scripts/qa-host-ui.mjs --only classroom --widths 1440,390
 *
 * 关键约束（改之前先读完）：
 *   1. client.js 每轮从磁盘重读，再走宿主的 window.__ModuleLoader__ 协议交给真 React；
 *      本脚本不 import client.js，也不缓存它。
 *   2. 宿主样式表从已安装的 dsh-client-ui-theme 里抽，抽取失败就抛错，不悄悄退回浏览器默认样式。
 *   3. 页面壳只模拟宿主语境（地面、720px 设置列、430/340/300px 侧栏面板、整屏高），
 *      不给新设计预埋任何样式；AFTER 轮次用同一个脚本、同一个壳。
 *   4. 任何 pageerror / console.error 都判失败，退出码非 0。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { DEFAULT_WIDTHS, SURFACES } from "../test/fixtures/host-ui/fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURES = path.join(ROOT, "test/fixtures/host-ui");
const CLIENT_PATH = path.join(ROOT, "client.js");

/**
 * 全局 `node_modules`：从当前 node 可执行文件推出来（`<prefix>/bin/node` → `<prefix>/lib/node_modules`），
 * 不写死任何人的家目录。装了之后不在这里的机器，用两个环境变量覆盖。
 */
const GLOBAL_MODULES = path.resolve(path.dirname(process.execPath), "..", "lib/node_modules");

/** 真宿主主题包：CSS 以字符串常量内嵌在这个 client.js 里，运行时抽出来。 */
const THEME_CLIENT_PATH = process.env.TEACH_HOST_THEME_CLIENT
	|| path.join(GLOBAL_MODULES, "@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js");

/** Playwright 由全局 @playwright/cli 提供（Chromium 已装在本机浏览器缓存里）。 */
const PLAYWRIGHT_PATH = process.env.TEACH_PLAYWRIGHT_MODULE
	|| path.join(GLOBAL_MODULES, "@playwright/cli") + "/";

/** 截图视口高度固定 1000：和之前那批 1440x1000 的图一致，纵向对比不用重新对齐。 */
const VIEWPORT_HEIGHT = 1000;
const DEVICE_SCALE_FACTOR = 2;

/** 抽取结果的硬护栏：这两个串不在，说明抽的不是宿主主题样式表。 */
const THEME_MARKERS = ["--dsw-static-neutral-bluish-00:#fff", "body[data-ds-dark-theme]"];

/**
 * 令牌断言期望值（来自宿主 design-platform 令牌，见 theme 包 sha 打印）。
 * 宿主主题升级导致这里失配时，脚本会失败并打印实测值 —— 这是故意的：
 * 与其画出「看起来还行但其实是浏览器默认样式」的图，不如报错。
 */
const EXPECTED_TOKENS = {
	light: { bodyBg: "rgb(255, 255, 255)", label: "rgb(15, 17, 21)", borderPrefix: "rgba(0, 0, 0" },
	dark: { bodyBg: "rgb(21, 21, 23)", label: "rgb(249, 250, 251)", borderPrefix: "rgba(255, 255, 255" }
};

// ---------------------------------------------------------------- CLI

function usage() {
	return [
		"用法: node scripts/qa-host-ui.mjs [--out <dir>] [--only settings|welcome|courses|classroom[,..]]",
		"                                  [--theme light|dark|both] [--widths 1440,768,390]",
		"",
		"  --out     输出目录，默认 artifacts/host-ui/current（AFTER 轮次传 artifacts/host-ui/after）",
		"  --only    只跑某些面，逗号分隔，默认三个面都跑",
		"  --theme   只跑明或暗，默认两种都跑",
		"  --widths  视口宽度，逗号分隔，默认 1440,768,390（侧栏面板宽 430/340/300）",
		"  --client  渲染另一份 client.js（默认仓库根目录那份；例如 `git show HEAD:client.js > /tmp/head-client.js`）"
	].join("\n");
}

function parseArgs(argv) {
	const options = {
		out: "artifacts/host-ui/current",
		client: null,
		only: Object.keys(SURFACES),
		themes: ["light", "dark"],
		widths: [...DEFAULT_WIDTHS]
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const readValue = (name) => {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) throw new Error(name + " 需要一个值");
			index += 1;
			return value;
		};
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--out") {
			options.out = readValue("--out");
		} else if (arg === "--client") {
			options.client = readValue("--client");
		} else if (arg === "--only") {
			const only = readValue("--only").split(",").map((item) => item.trim()).filter(Boolean);
			const unknown = only.filter((item) => SURFACES[item] === undefined);
			if (unknown.length > 0) throw new Error("--only 不认识：" + unknown.join(", ") + "（可选 " + Object.keys(SURFACES).join("/") + "）");
			options.only = only;
		} else if (arg === "--theme") {
			const theme = readValue("--theme");
			if (theme !== "both" && theme !== "light" && theme !== "dark") throw new Error("--theme 只收 light / dark / both");
			options.themes = theme === "both" ? ["light", "dark"] : [theme];
		} else if (arg === "--widths") {
			const widths = readValue("--widths").split(",").map((item) => Number(item.trim()));
			if (widths.length === 0 || widths.some((width) => !Number.isInteger(width) || width < 240 || width > 4096)) {
				throw new Error("--widths 只收 240–4096 的整数，逗号分隔");
			}
			options.widths = widths;
		} else {
			throw new Error("不认识的参数：" + arg + "\n\n" + usage());
		}
	}
	return options;
}

// ---------------------------------------------------------------- 宿主样式表抽取

/**
 * 从主题包的 client.js 里把所有 CSS 字符串抽出来。
 * 这个包把 CSS 以字符串常量内嵌（`var base_css_default = "..."`）：先把字面量还原成真字符串，
 * 再筛出含 CSS 令牌与花括号的那些（CSS Module 的类名映射表会被这一步排除）。
 */
function extractHostCss(source) {
	// 这个主题包把每份 CSS 打成 `var/const <name> = "<css>"` 的字符串常量（CSS Module 也是）。
	// 只认「行首赋值 + 引号字面量」，不自由扫引号：包里注释含撇号与 \0 转义，自由扫会串行。
	const assignmentPattern = /(?:^|\n)[ \t]*(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*("(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`)/g;
	const parts = [];
	const seen = new Set();
	let match;
	while ((match = assignmentPattern.exec(source)) !== null) {
		const literal = match[2];
		let css;
		try {
			css = literal[0] === "`" ? literal.slice(1, -1) : JSON.parse(literal);
		} catch {
			continue;
		}
		const trimmed = css.trim();
		// CSS 一定以选择器 / at-rule 开头；类名映射对象是 `{ "field": "xxx" }`，在这里被排除。
		if (!trimmed.includes("{") || !/^(?:body|html|:root|\[|@|\.|#)/.test(trimmed)) continue;
		if (!/--(?:dsw|dsh)-/.test(trimmed)) continue;
		if (seen.has(css)) continue;
		seen.add(css);
		parts.push({ name: match[1], css });
	}
	if (parts.length === 0) throw new Error("宿主主题包里没抽到任何 CSS：" + THEME_CLIENT_PATH);
	const css = parts.map((part) => part.css).join("\n");
	for (const marker of THEME_MARKERS) {
		if (!css.includes(marker)) throw new Error("抽到的宿主 CSS 缺少标记 " + marker + "（主题包结构变了？）");
	}
	return { css, parts: parts.length, names: parts.map((part) => part.name) };
}

// ---------------------------------------------------------------- 静态文件服务

function serve(routes) {
    const hostAssets = hostPrimitiveAssets();
	const server = http.createServer((request, response) => {
        if (hostAssets(request, response)) return;
		const pathname = new URL(request.url, "http://127.0.0.1").pathname;
		const route = routes.get(pathname);
		if (route === undefined) {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
			response.end("not found: " + pathname);
			return;
		}
		response.writeHead(200, { "content-type": route.type, "cache-control": "no-store" });
		response.end(route.body);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
	});
}

// ---------------------------------------------------------------- 等待与截图

const harnessHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>DSH host surface bench</title>
<link id="host-theme" rel="stylesheet" href="/host-theme.css">
<link id="harness-shell" rel="stylesheet" href="/harness.css">
</head>
<body>
<script type="module" src="/bundle.js"></script>
</body>
</html>
`;

const hasPendingRpc = (state) => state.rpc !== undefined && Object.values(state.rpc).some((value) => value === "pending");

/**
 * 挂载：承载面是 #qa-root 的第一个子元素。不认具体类名，设计改版换类名也不影响。
 * 先等「挂上了」或「harness 自己炸了」二者之一，炸了就立刻抛，不白等到超时。
 */
async function waitForMount(page) {
	await page.waitForFunction(() => document.documentElement.dataset.qaMounted !== undefined || document.documentElement.dataset.qaFailed !== undefined, null, { timeout: 15000 });
	const failure = await page.evaluate(() => document.documentElement.dataset.qaFailed || "");
	if (failure !== "") throw new Error("harness 启动失败：" + failure);
	await page.waitForSelector("#qa-root > *", { timeout: 15000 });
}

/** 页面里任何 pageerror / console.error 都算失败：报错要带上面/状态/主题/宽度，定位一眼。 */
function failOnPageErrors(pageErrors, before, label) {
	if (pageErrors.length <= before) return;
	const fresh = pageErrors.slice(before);
	throw new Error("页面报错（" + label + "）：\n  - " + fresh.map((item) => item.kind + ": " + item.message).join("\n  - "));
}

/**
 * 状态自带的等待条件：结构选择器 / 元素个数 / iframe / fixture 数据里的文字 / 文案 key。
 * textKey 会先在页面里用 window.__qa.t(key) 解析成当前那句话，避免把文案原文写进 fixture。
 */
async function waitForStateMarks(page, state) {
	const waitFor = state.waitFor || {};
	try {
		if (waitFor.selector !== undefined) await page.waitForSelector(waitFor.selector, { timeout: 15000 });
		if (waitFor.count !== undefined) {
			await page.waitForFunction(
				([selector, count]) => document.querySelectorAll(selector).length >= count,
				[waitFor.selector, waitFor.count],
				{ timeout: 15000 }
			);
		}
		if (waitFor.frame !== undefined) await waitForLoadedFrame(page, waitFor.frame);
		let text = waitFor.text;
		if (waitFor.textKey !== undefined) text = await resolveTextKey(page, waitFor.textKey);
		if (text !== undefined) {
			await page.waitForFunction((needle) => document.body.innerText.includes(needle), text, { timeout: 15000 });
		}
	} catch (error) {
		const seen = await page.evaluate(() => ({
			text: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
			failed: document.documentElement.dataset.qaFailed || "",
			mounted: document.documentElement.dataset.qaMounted || ""
		})).catch(() => ({ text: "(页面已关闭)", failed: "", mounted: "" }));
		throw new Error("等待状态失败：" + JSON.stringify(state.waitFor) + "\n  已渲染文本：" + seen.text
			+ "\n  qaFailed=" + seen.failed + " qaMounted=" + seen.mounted
			+ "\n  原始错误：" + (error && error.message ? error.message : error));
	}
}

/**
 * 等 fixture 的 RPC 真正落地：接口被调用过 + 在飞的请求都回来了（"pending" 档除外）。
 * 只看 DOM 文字不够 —— 接口还没回来时页面长得也「稳定」，截出来的就是错的状态。
 */
async function waitForRpcSettled(page, state, minimumCalls) {
	if (state.rpc === undefined) return;
	const minimum = minimumCalls === undefined ? 1 : minimumCalls;
	await page.waitForFunction((value) => window.__qa && window.__qa.rpc.calls >= value, minimum, { timeout: 15000 });
	if (hasPendingRpc(state)) return;
	await page.waitForFunction(() => window.__qa.rpc.inFlight === 0, null, { timeout: 15000 });
}

/**
 * DOM 静默：连续两次取样（间隔 80ms）的 #qa-root 子树没变化才算稳定。
 * 这是「等稳定」，不是盲等 —— 超过 10s 还在变说明渲染有问题，直接报错。
 */
async function waitQuiet(page) {
	const deadline = Date.now() + 10000;
	let previous = "";
	while (Date.now() < deadline) {
		const signature = await page.evaluate(() => {
			const root = document.getElementById("qa-root");
			const text = root === null ? "" : root.textContent || "";
			let hash = 0;
			for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
			return (root === null ? -1 : root.childElementCount) + ":" + text.length + ":" + hash;
		});
		if (signature === previous) return;
		previous = signature;
		await page.waitForTimeout(80);
	}
	throw new Error("渲染 10s 内没有稳定下来（DOM 一直在变）");
}

/**
 * 等待条件里写的是文案 key 而不是原文：改版会改措辞、不会改 copy 的 key。
 * 解析不出来（key 被删了）就直接失败，别退化成「等一段永远不出现的文字」。
 */
async function resolveTextKey(page, key) {
	const text = await page.evaluate((copyKey) => (typeof window.__qa.t === "function" ? window.__qa.t(copyKey) : copyKey), key);
	if (typeof text !== "string" || text === "" || text === key) {
		throw new Error("文案表里解析不出 key：" + key + "（得到 " + JSON.stringify(text) + "）");
	}
	return text;
}

/** 交互：按文案 key 找到按钮去点（改版改措辞、不改 key）。 */
async function runInteraction(page, state) {
	if (state.interaction === undefined) return 0;
	const callsBefore = await page.evaluate(() => window.__qa.rpc.calls);
	if (state.interaction.scroll === "courses") {
		await page.locator(".tsm-scroll").evaluate((node) => { node.scrollTop = 260; });
		await page.waitForTimeout(80);
		const geometry = await page.evaluate(() => {
			const scroller = document.querySelector(".tsm-scroll");
			const bar = document.querySelector(".tsm-topbar");
			if (scroller === null || bar === null) return null;
			return { scrollTop: scroller.scrollTop, barTop: bar.getBoundingClientRect().top, scrollerTop: scroller.getBoundingClientRect().top };
		});
		if (geometry === null) throw new Error("选课滚动检查缺 .tsm-scroll / .tsm-topbar");
		if (geometry.scrollTop <= 0) throw new Error("选课列表没有可滚动内容，无法验证吸顶");
		if (Math.abs(geometry.barTop - geometry.scrollerTop) > 1) throw new Error("选课顶栏没有吸顶：barTop=" + geometry.barTop + " scrollerTop=" + geometry.scrollerTop);
		return callsBefore;
	}
	if (state.interaction.scroll === "classroom") {
		const frame = await waitForLoadedFrame(page, "lesson-stub.html");
		await frame.waitForFunction(() => (document.querySelector("[data-teach-host-inset]")?.getBoundingClientRect().height || 0) > 0);
		await frame.evaluate(() => scrollTo(0, Math.min(document.documentElement.scrollHeight - innerHeight, 420)));
		await page.waitForTimeout(120);
		const header = await page.evaluate(() => {
			const bar = document.querySelector(".tsm-classbar");
			return bar === null ? 0 : bar.getBoundingClientRect().height;
		});
		const frameInfo = await frame.evaluate(() => {
			const spacer = document.querySelector("[data-teach-host-inset]");
			return { inset: spacer === null ? 0 : parseFloat(getComputedStyle(spacer).height), scrollY: window.scrollY };
		});
		if (header <= 0) throw new Error("课堂顶栏没有渲染高度");
		if (Math.abs(frameInfo.inset - Math.ceil(header)) > 1) throw new Error("课堂顶部空白与顶栏不等高：inset=" + frameInfo.inset + " header=" + header);
		if (frameInfo.scrollY <= 0) throw new Error("课堂课程页没有滚动，无法验证内容经过顶栏");
		// 覆盖层不能让 iframe 缩回 replaced element 的 300px 固有宽度：它必须铺满面板减两侧 12px。
		const frameWidth = await page.evaluate(() => {
			const frame = document.querySelector(".tsm-frame");
			const pane = document.querySelector(".qa-sidebar-pane");
			return frame === null || pane === null ? null : { frame: frame.getBoundingClientRect().width, pane: pane.getBoundingClientRect().width };
		});
		if (frameWidth === null) throw new Error("课堂缺 iframe 或侧栏面板");
		if (Math.abs(frameWidth.frame - (frameWidth.pane - 24)) > 1) throw new Error("课堂 iframe 没有铺满面板：frame=" + frameWidth.frame + " pane=" + frameWidth.pane);
		return callsBefore;
	}
	const label = await resolveTextKey(page, state.interaction.textKey);
	await page.getByRole("button", { name: label, exact: true }).click();
	return callsBefore;
}

/**
 * iframe 是 sandbox 隔离的：只看 URL 认领那一帧，再在帧里确认课程页真的画完了。
 * 轮询而不是取第一次匹配：课堂「刷新」会整页重挂 iframe，旧帧会在列表里短暂残留。
 */
async function waitForLoadedFrame(page, needle) {
	const deadline = Date.now() + 15000;
	let lastError = "";
	while (Date.now() < deadline) {
		const frames = page.frames().filter((candidate) => candidate !== page.mainFrame() && candidate.url().includes(needle));
		for (const frame of frames) {
			try {
				const painted = await frame.evaluate(() => document.readyState === "complete" && document.querySelector("h1") !== null);
				if (painted) return frame;
			} catch (error) {
				lastError = String(error && error.message ? error.message : error);
			}
		}
		await page.waitForTimeout(25);
	}
	throw new Error("等不到画完的 iframe：" + needle + (lastError === "" ? "" : "（最后一次错误：" + lastError + "）"));
}

/** 稳定一拍：两帧 rAF + 300ms，再等字体就绪。等的是「没有新东西要画」，不是盲等。 */
async function settle(page) {
	await page.evaluate(() => new Promise((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300)));
	}));
	await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => undefined) : undefined));
}

async function probeTokens(page) {
	const probe = await page.evaluate(() => {
		const surface = document.querySelector("#qa-root > *");
		if (surface === null) return { missing: true };
		const rootStyle = getComputedStyle(document.documentElement);
		const surfaceStyle = getComputedStyle(surface);
		// 只看令牌派生的值：正文色、边框色、字体栈。字号/字重属于设计，不进断言。
		const nodes = [surface, ...surface.querySelectorAll("*")];
		const colors = nodes.map((node) => getComputedStyle(node).color);
		const textNode = surface.querySelector("label, h1, h2, h3, p, span") || surface;
		const textStyle = getComputedStyle(textNode);
		const borderColors = [];
		for (const node of nodes) {
			const style = getComputedStyle(node);
			if (style.borderTopWidth === "0px" || style.borderTopStyle === "none") continue;
			if (!borderColors.includes(style.borderTopColor)) borderColors.push(style.borderTopColor);
		}
		let hostMarker = false;
		const hostSheet = document.getElementById("host-theme");
		try {
			hostMarker = [...hostSheet.sheet.cssRules].some((rule) => rule.cssText.includes("--dsw-static-neutral-bluish-00"));
		} catch {
			hostMarker = false;
		}
		const rootElement = document.getElementById("qa-root");
		const container = rootElement === null ? null : rootElement.parentElement;
		const rect = (element) => {
			if (element === null) return null;
			const box = element.getBoundingClientRect();
			return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
		};
		return {
			missing: false,
			layout: { container: rect(container), surface: rect(surface), viewport: { width: innerWidth, height: innerHeight } },
			bodyBg: getComputedStyle(document.body).backgroundColor,
			textColor: textStyle.color,
			textSize: textStyle.fontSize,
			surfaceFont: surfaceStyle.fontFamily,
			colors,
			borderColors,
			contentFontSize: rootStyle.getPropertyValue("--dsh-content-font-size").trim(),
			fallbackTokens: window.__qa.fallbackTokens,
			hostMarker,
			darkAttribute: document.body.hasAttribute("data-ds-dark-theme")
		};
	});
	if (probe.missing) throw new Error("令牌探针找不到承载面（fixture 或渲染失败）");
	return probe;
}

function assertTokens(theme, probe, cssBytes, cssParts) {
	const expected = EXPECTED_TOKENS[theme];
	const failures = [];
	const check = (name, actual, expectedValue) => {
		if (actual !== expectedValue) failures.push(name + " 期望 " + expectedValue + "，实测 " + actual);
	};
	if (!probe.hostMarker) failures.push("页面里没有宿主样式表的令牌标记（host-theme.css 没生效）");
	check("body 背景（--dsw-alias-bg-base）", probe.bodyBg, expected.bodyBg);
	// label-primary 令牌必须真的派生到某个元素上：不是浏览器默认黑，也不是兜底色。
	const hasTokenColor = probe.colors.includes(expected.label);
	if (!hasTokenColor) {
		failures.push("承载面里没有任何元素用 --dsw-alias-label-primary（期望 " + expected.label + "；首个元素实测 " + probe.textColor + "）");
	}
	if (!probe.surfaceFont.includes("PingFang SC")) failures.push("承载面字体不是宿主文本栈（实测 " + probe.surfaceFont + "）");
	if (/^(?:Times(?: New Roman)?|serif)$/i.test(probe.surfaceFont.trim())) {
		failures.push("承载面字体掉回了浏览器默认 serif（实测 " + probe.surfaceFont + "）");
	}
	if (probe.contentFontSize !== "14px") failures.push("--dsh-content-font-size 应为 14px，实测 " + (probe.contentFontSize || "(空)"));
	const borderColors = Array.isArray(probe.borderColors) ? probe.borderColors : [];
	if (borderColors.length > 0 && !borderColors.some((color) => color.startsWith(expected.borderPrefix))) {
		failures.push("所有带边框元素的边框色都不是宿主 border 令牌（期望以 " + expected.borderPrefix + " 开头，实测 " + borderColors.join(" / ") + "）");
	}
	if (theme === "dark" && probe.darkAttribute !== true) failures.push("暗色主题下 body 没有 data-ds-dark-theme");
	if (theme === "light" && probe.darkAttribute !== false) failures.push("亮色主题下 body 不应有 data-ds-dark-theme");
	const fallbacks = probe.fallbackTokens.length === 0 ? "(none)" : probe.fallbackTokens.join(",");
	const line = [
		`[tokens ${theme}] host-theme.css=${cssBytes}B/${cssParts}段`,
		`body=${probe.bodyBg}`,
		`text=${probe.textColor}`,
		`label-primary=${hasTokenColor ? "yes" : "NO"}`,
		`border=${borderColors[0] || "(none)"}`,
		`surface-font=${probe.surfaceFont}`,
		`text-size=${probe.textSize}`,
		`content-font-size=${probe.contentFontSize}`,
		`fallback=${fallbacks}`
	].join(" ");
	if (failures.length > 0) {
		console.error(line);
		throw new Error("令牌断言失败（" + theme + "）：\n  - " + failures.join("\n  - "));
	}
	console.log(line);
	return { theme, bodyBg: probe.bodyBg, textColor: probe.textColor, borderColors, surfaceFont: probe.surfaceFont, textSize: probe.textSize, contentFontSize: probe.contentFontSize, fallbackTokens: probe.fallbackTokens, layout: probe.layout, hostCssBytes: cssBytes, hostCssParts: cssParts, ok: true };
}

function pngSize(buffer) {
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function sha256(text) {
	return crypto.createHash("sha256").update(text).digest("hex");
}

function cleanOutput(outDir) {
	let removed = 0;
	if (!fs.existsSync(outDir)) return removed;
	for (const surface of Object.keys(SURFACES)) {
		const directory = path.join(outDir, surface);
		if (!fs.existsSync(directory)) continue;
		for (const name of fs.readdirSync(directory)) {
			if (name.endsWith(".png")) {
				fs.unlinkSync(path.join(directory, name));
				removed += 1;
			}
		}
		try {
			fs.rmdirSync(directory);
		} catch {
			// 目录里还有别的文件（不是 bench 写的）就留着，不替用户删。
		}
	}
	const manifestPath = path.join(outDir, "manifest.json");
	if (fs.existsSync(manifestPath)) {
		fs.unlinkSync(manifestPath);
		removed += 1;
	}
	return removed;
}

// ---------------------------------------------------------------- 主流程

async function main() {
	const startedAt = Date.now();
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error("[qa-host-ui] " + (error && error.message ? error.message : error));
		return 1;
	}
	if (options.help) {
		console.log(usage());
		return 0;
	}
	const outDir = path.resolve(ROOT, options.out);

	const clientPath = options.client === null ? CLIENT_PATH : path.resolve(ROOT, options.client);
	if (!fs.existsSync(clientPath)) throw new Error("找不到 client.js：" + clientPath);
	if (!fs.existsSync(THEME_CLIENT_PATH)) throw new Error("找不到宿主主题包：" + THEME_CLIENT_PATH + "（可用 TEACH_HOST_THEME_CLIENT 覆盖）");
	const clientText = fs.readFileSync(clientPath, "utf8");
	const themeText = fs.readFileSync(THEME_CLIENT_PATH, "utf8");
	const { css: hostCss, parts: hostCssParts, names: hostCssNames } = extractHostCss(themeText);

	// 1. 每次运行都重新打包 harness（entry.js + 真 react/react-dom + fixtures）
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "qa-host-ui-"));
	const bundlePath = path.join(scratch, "bundle.js");
	await build({
		entryPoints: [path.join(FIXTURES, "entry.js")],
		outfile: bundlePath,
		bundle: true,
		format: "esm",
        external: ["/host-assets/host-primitives.js"],
		platform: "browser",
		target: ["chrome120"],
		legalComments: "none",
		logLevel: "silent",
		define: { "process.env.NODE_ENV": '"production"' }
	});
	const harnessCss = fs.readFileSync(path.join(FIXTURES, "harness.css"), "utf8");
	const lessonStub = fs.readFileSync(path.join(FIXTURES, "lesson-stub.html"), "utf8");

	// 2. 本地服务：/ 页面、/host-theme.css 宿主样式、/harness.css 页面壳、/bundle.js、/client.js、课程页
	const routes = new Map([
		["/", { type: "text/html; charset=utf-8", body: harnessHtml }],
		["/host-theme.css", { type: "text/css; charset=utf-8", body: hostCss }],
		["/harness.css", { type: "text/css; charset=utf-8", body: harnessCss }],
		["/bundle.js", { type: "text/javascript; charset=utf-8", body: fs.readFileSync(bundlePath) }],
		["/client.js", { type: "text/javascript; charset=utf-8", body: clientText }],
		["/lesson-stub.html", { type: "text/html; charset=utf-8", body: lessonStub }]
	]);
	const { server, port } = await serve(routes);
	const origin = "http://127.0.0.1:" + port;

	// 3. Playwright：context 固定 deviceScaleFactor=2，页面按 1440x1000 起
	const requireFrom = createRequire(PLAYWRIGHT_PATH);
	const { chromium } = requireFrom("playwright");
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: options.widths[0], height: VIEWPORT_HEIGHT },
		deviceScaleFactor: DEVICE_SCALE_FACTOR,
		colorScheme: "light",
		locale: "zh-CN"
	});
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push({ kind: "pageerror", message: String(error && error.message ? error.message : error) }));
	page.on("console", (message) => {
		if (message.type() === "error") pageErrors.push({ kind: "console.error", message: message.text() });
	});

	const shots = [];
	const tokenReports = [];
	const removed = cleanOutput(outDir);
	if (removed > 0) console.log("清理旧产物 " + removed + " 个：" + path.relative(ROOT, outDir));

	try {
		// 4. 令牌探针：与矩阵无关，先单独跑一遍并打印；失配直接失败，不浪费后面的截图时间。
		await page.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });
		for (const theme of options.themes) {
			await page.goto(origin + "/?surface=settings&state=ready&theme=" + theme + "&width=1440", { waitUntil: "load" });
			await waitForMount(page);
			await waitForStateMarks(page, SURFACES.settings.states[0]);
			await waitQuiet(page);
			await settle(page);
			const probe = await probeTokens(page);
			tokenReports.push(assertTokens(theme, probe, Buffer.byteLength(hostCss), hostCssParts));
			if (pageErrors.length > 0) throw new Error("令牌探针页面报错：\n  - " + pageErrors.map((item) => item.kind + ": " + item.message).join("\n  - "));
		}

		// 5. 矩阵：主题 → 宽度 → 面 → 状态
		for (const theme of options.themes) {
			console.log("[run] " + theme + " 主题");
			for (const width of options.widths) {
				await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
				for (const surfaceId of options.only) {
					const surface = SURFACES[surfaceId];
					for (const state of surface.states) {
						const url = origin + "/?surface=" + surfaceId + "&state=" + encodeURIComponent(state.id) + (state.pane ? "&pane=" + state.pane : "") + "&theme=" + theme + "&width=" + width;
						const label = surfaceId + "/" + state.id + " " + theme + " " + width + "px";
						const before = pageErrors.length;
						await page.goto(url, { waitUntil: "load" });
						await waitForMount(page);
						failOnPageErrors(pageErrors, before, label);
						await waitForStateMarks(page, state.beforeInteraction ? { waitFor: state.beforeInteraction } : state);
						await waitForRpcSettled(page, state);
						const callsBeforeClick = await runInteraction(page, state);
						if (state.interaction !== undefined) {
							// 「刷新」会重开课堂（open）再读一次汇总（status）：至少两次新调用，且都要回来。
							// 纯滚动状态没有新 RPC，只等页面标记，不空等一次不存在的调用。
							if (state.interaction.textKey !== undefined) await waitForRpcSettled(page, state, callsBeforeClick + (state.interaction.rpcCalls ?? 1));
							await waitForStateMarks(page, state);
						}
						await waitQuiet(page);
						await settle(page);
						failOnPageErrors(pageErrors, before, label);
						const directory = path.join(outDir, surfaceId);
						fs.mkdirSync(directory, { recursive: true });
						const file = path.join(directory, state.id + "--" + theme + "--w" + width + ".png");
						const buffer = await page.screenshot({ path: file, fullPage: true });
						const size = pngSize(buffer);
						shots.push({
							surface: surfaceId,
							state: state.id,
							theme,
							width,
							paneWidth: ["settings", "dock", "welcome"].includes(surfaceId) ? null : await page.evaluate(() => Number(document.querySelector(".qa-sidebar-pane").dataset.qaPaneWidth)),
							file: path.relative(ROOT, file),
							bytes: buffer.length,
							png: size,
							rpcCalls: await page.evaluate(() => window.__qa.calls.map((call) => call.endpoint))
						});
					}
				}
			}
		}
	} finally {
		await context.close();
		await browser.close();
		server.close();
	}

	// 6. 清单 + 文件表
	const manifest = {
		bench: "scripts/qa-host-ui.mjs",
		generatedAt: new Date().toISOString(),
		outDir: path.relative(ROOT, outDir),
		client: { path: path.relative(ROOT, clientPath), bytes: Buffer.byteLength(clientText), sha256: sha256(clientText) },
		hostTheme: { path: THEME_CLIENT_PATH, bytes: Buffer.byteLength(themeText), sha256: sha256(themeText), cssBytes: Buffer.byteLength(hostCss), cssParts: hostCssParts, cssPartNames: hostCssNames },
		matrix: { themes: options.themes, widths: options.widths, surfaces: options.only, viewportHeight: VIEWPORT_HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR },
		tokens: tokenReports,
		shots
	};
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
	console.log("");
	console.log("写文件：" + shots.length + " 张 -> " + path.relative(ROOT, outDir) + "（" + elapsed + "s）");
	const header = ["surface", "state", "theme", "vw", "png", "bytes", "file"];
	const rows = shots.map((shot) => [
		shot.surface,
		shot.state,
		shot.theme,
		String(shot.width),
		shot.png.width + "x" + shot.png.height,
		String(shot.bytes),
		shot.file.replace(path.relative(ROOT, outDir) + "/", "")
	]);
	const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
	const formatRow = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ");
	console.log("");
	console.log(formatRow(header));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const row of rows) console.log(formatRow(row));
	console.log("");
	console.log("client.js sha256=" + manifest.client.sha256.slice(0, 16) + "  host-theme sha256=" + manifest.hostTheme.sha256.slice(0, 16));
	console.log("重跑：node scripts/qa-host-ui.mjs --out " + options.out);
	return 0;
}

main().then((code) => {
	process.exitCode = code;
}).catch((error) => {
	console.error("");
	console.error("[qa-host-ui] 失败：" + (error && error.stack ? error.stack : error));
	process.exitCode = 1;
});
