/**
 * 浏览器侧的 bench 入口（esbuild 打成经典脚本，由 scripts/qa-host-ui.mjs 每次运行重建）。
 *
 * 它只做四件事，顺序是刻意的：
 *   1. 先按 URL 参数把宿主语境摆好（明暗主题属性、缺失令牌的回退、页面壳）；
 *   2. 再 stub `window.__ModuleLoader__`；
 *   3. 然后才把 client.js 的源码读进来、交给这个 stub 里的 factory 执行（等价于宿主的加载方式）——
 *      react 走 factory 的 require 回调，所以组件拿到的是 node_modules 里那份真 React 19；
 *   4. 拿组件：优先 exports，其次走宿主的 `apply(ctx)` 注册路径把组件捞出来
 *      （当前 client.js 只 export 设置面，侧栏两面只在 apply 里注册），最后用真 react-dom 挂载。
 *
 * client.js 每轮都从磁盘重新取（runner 的 /client.js 路由不做缓存），所以改完源码直接重跑就能对比。
 */

let React;
let createRoot;
let hostModules;
import { SETTINGS_SNAPSHOTS, SESSION_ID, SURFACES, TAB_INFO, paneWidthFor } from "./fixtures.js";

const h = (...args) => React.createElement(...args);
const params = new URLSearchParams(window.location.search);
const surfaceId = params.get("surface") || "settings";
const stateId = params.get("state") || "";
const theme = params.get("theme") === "dark" ? "dark" : "light";
const viewportWidth = Number(params.get("width") || window.innerWidth || 1440);

/**
 * 宿主没定义这三个变量时的回退值。只写在 bench 页面里，不改宿主样式本身：
 * 字体两档是宿主文档里给的栈，正文尺寸按宿主默认 14px。
 */
const FALLBACK_TOKENS = {
	"--dsh-font-family-text-default": '-apple-system, "SF Pro Text", "PingFang SC", sans-serif',
	"--dsh-font-family-code-default": 'ui-monospace, "SF Mono", monospace',
	"--dsh-content-font-size": "14px"
};

/** 回退只在缺失时补，且记下补了哪些，runner 会把这件事打印出来。 */
function applyTokenFallbacks() {
	const rootStyle = getComputedStyle(document.documentElement);
	const missing = [];
	for (const name of Object.keys(FALLBACK_TOKENS)) {
		if (rootStyle.getPropertyValue(name).trim() === "") missing.push(name);
	}
	if (missing.length === 0) return [];
	const style = document.createElement("style");
	style.id = "qa-token-fallback";
	style.textContent = ":root{" + missing.map((name) => name + ":" + FALLBACK_TOKENS[name] + ";").join("") + "}";
	document.head.appendChild(style);
	return missing;
}

/** 主题：亮色不带属性，暗色就是宿主那一个 body 属性。 */
function applyTheme() {
	document.documentElement.dataset.qaTheme = theme;
	document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
	if (theme === "dark") document.body.setAttribute("data-ds-dark-theme", "");
	else document.body.removeAttribute("data-ds-dark-theme");
}

/** 宿主语境的页面壳：设置页给 720px 内容列，侧栏面给贴右的整屏面板。 */
function buildShell(surface) {
	const page = document.createElement("div");
	page.className = "qa-page qa-page--" + (surface === "settings" ? "settings" : "sidebar");
	page.dataset.qaSurface = surface;
	const root = document.createElement("div");
	root.id = "qa-root";
	if (surface === "dock") {
        page.className = "qa-page qa-page--dock";
        const row = document.createElement("div"); row.className = "qa-hero-row";
        const preset = document.createElement("span"); preset.textContent = "教学模式"; preset.className = "qa-preset-label";
        row.append(preset, root); page.append(row);
    } else if (surface === "settings") {
		const column = document.createElement("div");
		column.className = "qa-settings-col";
		column.appendChild(root);
		page.appendChild(column);
	} else {
		const pane = document.createElement("div");
		pane.className = "qa-sidebar-pane";
		const paneWidth = paneWidthFor(viewportWidth);
		pane.style.width = paneWidth + "px";
		pane.dataset.qaPaneWidth = String(paneWidth);
		pane.appendChild(root);
		page.appendChild(pane);
	}
	document.body.appendChild(page);
	return root;
}

/** 文案表按宿主语言绑定来：查不到 key 就回 key（和宿主的回退一致）。 */
function makeT(dict) {
	return (key) => (typeof dict[key] === "string" ? dict[key] : String(key));
}

/**
 * 按 fixture 的 rpc 表造 callRpc；"pending" 用来截住 loading 态。
 * 同时记账（calls / inFlight）：runner 靠这个判断「接口回来了、页面画完了」，
 * 不会在请求还在飞的时候截到一张还在 loading 的图。
 */
function makeRpc(state) {
	const table = (state && state.rpc) || {};
	return (endpoint, payload) => {
		window.__qa.calls.push({ endpoint, payload });
		window.__qa.rpc.calls = window.__qa.calls.length;
		const entry = table[endpoint];
		let settled;
		if (entry === undefined) settled = Promise.resolve({ ok: false, error: { code: "unknown-endpoint", endpoint } });
		else if (entry === "pending") settled = new Promise(() => {});
		else settled = Promise.resolve(typeof entry === "function" ? entry(payload) : entry);
		window.__qa.rpc.inFlight += 1;
		return settled.finally(() => {
			window.__qa.rpc.inFlight = Math.max(0, window.__qa.rpc.inFlight - 1);
		});
	};
}

/**
 * useConfig 的替身：真 hook（useSyncExternalStore），快照稳定、write 后重渲染。
 * 组件是拿 `useConfig((state) => state)` 的，所以 getSnapshot 必须返回同一个引用。
 */
function createConfig(snapshot) {
	let state = snapshot;
	const listeners = new Set();
	const useConfig = (selector) => React.useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => selector(state)
	);
	const write = (path, value) => {
		const next = JSON.parse(JSON.stringify(state));
		let target = next.value;
		if (target === null || typeof target !== "object") target = next.value = {};
		for (let index = 0; index < path.length - 1; index += 1) {
			if (target[path[index]] === null || typeof target[path[index]] !== "object") target[path[index]] = {};
			target = target[path[index]];
		}
		target[path[path.length - 1]] = value;
		state = next;
		for (const listener of listeners) listener();
		return Promise.resolve(true);
	};
	return { useConfig, write };
}

/**
 * 宿主的注册路径：给 apply(ctx) 一个只实现「用到的那几个服务」的 ctx，把槽位注册捕获下来。
 * 这样即使 client.js 不 export 侧栏组件（只在 apply 里注册），bench 也能拿到同一个组件实例。
 */
function captureHostRegistrations(clientExports) {
	const registered = [];
	const dictionaries = [];
	const ctx = {
		effect: (fn) => fn(),
		locale: {
			register: (namespace, copy) => {
				dictionaries.push(copy);
				return () => {};
			},
			bind: () => makeT((dictionaries[dictionaries.length - 1] || {}).zh || {})
		},
		configForms: {
			get: () => ({ mutate: () => Promise.resolve(true) }),
			whileServed: (entries, fn) => {
				fn();
				return () => {};
			}
		},
		slots: {
			inject: (name, fn) => fn(),
			register: (descriptor, component) => {
				registered.push({ descriptor: descriptor || {}, component });
				return () => {};
			}
		},
		sidebarRightTabs: {
			register: () => () => {}
		},
		sidebarRight: {
			openTab: () => true
		}
	};
	let applyFailure = null;
	try {
		clientExports.apply(ctx);
	} catch (error) {
		applyFailure = error;
	}
	const pick = (predicate) => {
		const hit = registered.find((item) => predicate(item.descriptor));
		return hit === undefined ? null : hit.component;
	};
	return {
		applyFailure,
		dictionaries,
		components: {
			dock: clientExports.TeachingDock,
            settings: clientExports.TeachSettingsSection || pick((descriptor) => descriptor.name === "settings.section"),
			courses: clientExports.CoursesTab || pick((descriptor) => descriptor.name === "sidebar.right.pane.tab" && descriptor.key === "dsh-teach-me/courses"),
			classroom: clientExports.ClassroomTab || pick((descriptor) => descriptor.name === "sidebar.right.pane.tab" && descriptor.key === "dsh-teach-me")
		}
	};
}

/** 三个承载面各自的 props，形状与 client.js 的 apply() 注入的一致。 */
function describeSurface(surface, state, host) {
	const { components, t } = host;
	const callRpc = makeRpc(state);
	if (surface === "settings") {
		const config = createConfig((state && state.snapshot) || SETTINGS_SNAPSHOTS.ready);
		return {
			component: components.settings,
			props: {
				t,
				useConfig: config.useConfig,
				write: (path, value) => {
					window.__qa.writeCalls.push({ path, value });
					return config.write(path, value);
				}
			}
		};
	}
	if (surface === "dock") return { component: components.dock, props: { t, sessionId: SESSION_ID, session: { projectionValues: { agentPreset: "teach" } }, callRpc } };
	if (surface === "courses") {
		return {
			component: components.courses,
			props: {
				t,
				sessionId: SESSION_ID,
				callRpc,
				openLessonById: (lessonId) => {
					window.__qa.openLessonById.push(lessonId);
					return true;
				}
			}
		};
	}
	return {
		component: components.classroom,
		props: {
			useTabInfo: () => TAB_INFO,
			t,
			sessionId: SESSION_ID,
			// 两条入口都走同一个 classroom/open 桩，和 client.js 里 apply() 的接线一致。
			address: (address) => callRpc("classroom/open", { sessionId: SESSION_ID, address: address }),
			lesson: (lessonId) => callRpc("classroom/open", { sessionId: SESSION_ID, lessonId: lessonId }),
			callRpc,
			openCourses: () => {
				window.__qa.openCourses += 1;
				return true;
			}
		}
	};
}

/**
 * 用宿主的加载协议取 client.js：stub 先就位，再执行源码，factory 里拿到真 react。
 * 这里必须先 stub 再执行，所以不能写成静态 import（esbuild 会把 import 提到前面去）。
 */
async function loadClient() {
    ({ hostModules } = await import("/host-assets/host-primitives.js"));
    React = hostModules.react;
    ({ createRoot } = hostModules["react-dom/client"]);
	const response = await fetch("/client.js", { cache: "no-store" });
	if (!response.ok) throw new Error("client.js 读取失败：HTTP " + response.status);
	const source = await response.text();
	let plugin = null;
	window.__ModuleLoader__ = {
		load(definition) {
			plugin = definition;
		}
	};
	new Function(source)();
	if (plugin === null) throw new Error("client.js 没有调用 window.__ModuleLoader__.load");
	const clientExports = plugin.factory((name) => {
		if (Object.hasOwn(hostModules, name)) return hostModules[name];
		throw new Error("client.js require 了未提供的模块：" + name);
	});
	if (!clientExports || typeof clientExports !== "object") throw new Error("client.js 的 exports 不是对象");
	if (typeof clientExports.apply !== "function") throw new Error("client.js 没有导出 apply（宿主注册入口）");
	return clientExports;
}

function findState(surface) {
	const definition = SURFACES[surface];
	if (!definition) return null;
	return definition.states.find((state) => state.id === stateId) || null;
}

async function main() {
	window.__qa = {
		surface: surfaceId,
		state: stateId,
		theme,
		width: viewportWidth,
		paneWidth: surfaceId === "settings" ? null : paneWidthFor(viewportWidth),
		fallbackTokens: [],
		rpc: { calls: 0, inFlight: 0 },
		calls: [],
		writeCalls: [],
		openLessonById: [],
		openCourses: 0,
		applyFailure: ""
	};
	window.__qa.fallbackTokens = applyTokenFallbacks();
	applyTheme();
	const rootEl = buildShell(surfaceId);
	const state = findState(surfaceId);
	if (state === null) throw new Error("fixture 里没有这个状态：" + surfaceId + "/" + stateId);
	const clientExports = await loadClient();
	const host = captureHostRegistrations(clientExports);
	// t 优先用 exports.copy（工作区版本有），否则退回 apply 里 locale.register 进来的那份
	// （老版本只注册文案、不导出 copy）。
	const dictionary = (clientExports.copy && clientExports.copy.zh)
		|| ((host.dictionaries.find((item) => item && item.zh) || {}).zh)
		|| {};
	const t = makeT(dictionary);
	window.__qa.t = t;
	window.__qa.applyFailure = host.applyFailure === null ? "" : String(host.applyFailure.message || host.applyFailure);
	const description = describeSurface(surfaceId, state, { components: host.components, t });
	if (typeof description.component !== "function") {
		throw new Error("拿不到 " + surfaceId + " 的组件：既没从 exports 拿到，也没在 apply(ctx) 的槽位注册里捕获到");
	}
	createRoot(rootEl).render(h(description.component, description.props));
	document.documentElement.dataset.qaMounted = "true";
}

main().catch((error) => {
	document.documentElement.dataset.qaFailed = String((error && error.stack) || error);
	console.error("[qa-host-ui] harness 启动失败：", error);
});
