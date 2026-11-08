window.__ModuleLoader__.load({
	id: "dsh-teach-me",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// 教学偏好、集合管理与阅读条共用宿主令牌。
		let primitives = {};
		try { primitives = require("@deepseek-ai/dsh-client-ui-primitives"); } catch {}
		/**
		 * 官方遮罩模糊只在提供 --dsw-mask-blur 的宿主上生效；Web 上它是 none。
		 * 这时退回同一套宿主主题里的官方菜单模糊，顶栏仍有毛玻璃，而不是退化成纯半透明。
		 * 只读一次计算值；平台与主题在会话内不会换。
		 */
		let maskBlurProbe;
		function officialMaskBlur() {
			if (maskBlurProbe !== undefined) return maskBlurProbe;
			try {
				if (typeof document === "undefined" || typeof getComputedStyle !== "function") return (maskBlurProbe = false);
				const html = getComputedStyle(document.documentElement).getPropertyValue("--dsw-mask-blur").trim();
				const body = document.body ? getComputedStyle(document.body).getPropertyValue("--dsw-mask-blur").trim() : "";
				const value = html || body;
				return (maskBlurProbe = value !== "" && value !== "none");
			} catch {
				return (maskBlurProbe = false);
			}
		}
		const FACT_LEVELS = ["none", "loose", "moderate", "strict"];
		const DEPTH_LEVELS = ["shallow", "moderate", "deep"];
		/** 选项与定位、Escape、外点关闭均交给宿主 Menu，不维护第二套弹层。 */
		function HostSelect({ id, label, value, items, disabled, onChange, nested, className, "aria-describedby": describedBy }) {
			const [open, setOpen] = react.useState(false);
			const Menu = primitives.Menu;
			const Button = primitives.Button || "button";
			const Chevron = primitives.IconChevronDownOutlineRegular;
			const selected = items.find((item) => item.id === value);
			const anchor = react.createElement(Button, {
				id, type: "button", variant: "ghost", size: "sm", className: "tsm-menu-select" + (className ? " " + className : ""), "aria-describedby": describedBy,
				"aria-label": label, "aria-haspopup": "menu", "aria-expanded": open,
				disabled: disabled || !Menu, onClick: () => setOpen(!open)
			}, [react.createElement("span", { key: "label" }, selected?.label || label), Chevron ? react.createElement(Chevron, { key: "chevron", size: 12, "aria-hidden": true }) : null]);
			const menu = Menu ? react.createElement(Menu, {
				open, onClose: () => setOpen(false), portal: true, align: "start", minWidthFromAnchor: true,
				className: "tsm-menu-select-anchor", items, selectedId: value,
				onSelect: (next) => { setOpen(false); onChange(next); }, anchor
			}) : anchor;
			// Portal 选项仍属于此 React 树；阻止父 Menu 把选项点击当作外点。
			return nested ? react.createElement("span", { onPointerDown: (event) => { if (!event.currentTarget.contains(event.target)) event.stopPropagation(); } }, menu) : menu;
		}
		function LevelSlider({ t, field, value, disabled, onChange }) {
			const levels = field === "factCheck" ? FACT_LEVELS : DEPTH_LEVELS;
			const labels = field === "factCheck" ? [t("checkNone"), t("checkLoose"), t("checkModerate"), t("checkStrict")] : [t("depthShallow"), t("depthModerate"), t("depthDeep")];
			const id = react.useId();
			const index = Math.max(0, levels.indexOf(value || "moderate"));
			return react.createElement("div", { className: "tsm-level" }, [
				react.createElement("label", { key: "label", htmlFor: id, className: "tsm-label" }, field === "factCheck" ? t("factCheckLabel") : t("depthLabel")),
				react.createElement("input", { key: "range", id, type: "range", min: 0, max: levels.length - 1, step: 1, value: index, disabled, "aria-valuetext": labels[index], onKeyDown: (event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) event.stopPropagation(); }, onChange: (event) => onChange(levels[Number(event.target.value)]) }),
				react.createElement("div", { key: "labels", className: "tsm-stops", "aria-hidden": "true" }, labels.map((label, i) => react.createElement("span", { key: i, "data-selected": i === index ? "true" : undefined }, label)))
			]);
		}
		function ReadingBar({ t, reading, pending, action, leading }) {
			const percent = Math.round((reading && reading.maxRatio || 0) * 100);
			return react.createElement("div", { className: "tsm-reading" + (leading ? " tsm-reading--with-leading" : "") }, [
				react.createElement("div", { key: "label", className: "tsm-readinglabel" }, [
					leading ? react.createElement("span", { key: "leading", className: "tsm-readingleading" }, leading) : null,
					leading ? react.createElement("span", { key: "spacer", className: "tsm-readingspacer", "aria-hidden": "true" }) : null,
					react.createElement("span", { key: "word", className: "tsm-readingword" }, reading ? t("readingLabel") : t("readingUnknown")),
					react.createElement("span", { key: "tail", className: "tsm-readingtail" }, [
						react.createElement("span", { key: "percent", className: "tsm-readingpercent" }, percent + "%" + (pending ? " · " + t("readingUnsaved") : "")),
						action || null
					])
				]),
				react.createElement("div", { key: "bar", className: "tsm-progress", role: "progressbar", "aria-label": t("readingLabel"), "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent }, react.createElement("span", { style: { width: percent + "%" } }))
			]);
		}
        function FactCheckDetails({ t, report }) {
            const label = report.status === "complete" ? t("factCheckComplete") : report.status === "disabled" ? t("checkNone") : t("factCheckIncomplete");
            return react.createElement("details", { className: "tsm-manage" }, [
                react.createElement("summary", { key: "summary" }, t("factCheckDetails") + " · " + label),
                react.createElement("div", { key: "body", className: "tsm-evidence" }, [
                    react.createElement("p", { key: "text" }, report.summary || label),
                    ...(report.participants || []).map((person, index) => react.createElement("div", { key: person.agentId }, [
                        react.createElement("p", { key: "person" }, t("checkReviewer") + " " + (index + 1) + " · " + (person.status === "complete" ? t("factCheckComplete") : t("factCheckIncomplete"))),
                        react.createElement("ul", { key: "sources" }, (person.sources || []).map((source, n) => react.createElement("li", { key: n }, /^https?:\/\//.test(source) ? react.createElement("a", { href: source, target: "_blank", rel: "noopener noreferrer" }, source) : source))),
                        ...(person.findings || []).map((finding, n) => react.createElement("p", { key: "finding-" + n }, finding.claim + " · " + t(finding.resolution === "fixed" ? "checkFixed" : finding.resolution === "removed" ? "checkRemoved" : "checkPending") + " · " + finding.note))
                    ])),
                    ...(report.followup || []).map((item, index) => react.createElement("p", { key: "follow-" + index }, t("checkFollowup") + " · " + item.issue + " · " + item.result)),
                    ...(report.pending || []).map((item, index) => react.createElement("p", { key: "pending-" + index }, t("checkPending") + " · " + item))
                ])
            ]);
        }
		function CollectionControls({ t, sessionId, callRpc, value, onChanged, compact }) {
			const [name, setName] = react.useState("");
			const [action, setAction] = react.useState("create");
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");
			const [showArchived, setShowArchived] = react.useState(false);
			const [candidate, setCandidate] = react.useState("");
			const selectId = react.useId();
			const inputId = react.useId();
			const collections = Array.isArray(value.collections) ? value.collections : [{ id: "default", name: "默认集合", archived: false }];
			const currentId = value.collectionId || "default";
			const current = collections.find((c) => c.id === currentId);
			const run = async (endpoint, payload) => {
				if (busy) return;
				setBusy(true); setError("");
				try {
					const result = await callRpc(endpoint, { sessionId, ...payload });
					if (!result || !result.ok) throw new Error(classroomErrorText(t, result && result.error));
					if (payload.action === "create" || payload.action === "copy") {
						const selected = await callRpc("collections/select", { sessionId, collectionId: result.value.id });
						if (!selected || !selected.ok) throw new Error(classroomErrorText(t, selected && selected.error));
					}
					setName(""); setCandidate("");
					window.dispatchEvent(new CustomEvent("teach-preferences-changed", { detail: { sessionId } }));
					onChanged();
				} catch (failure) { setError(failure.message); }
				finally { setBusy(false); }
			};
			return react.createElement("div", { className: "tsm-collections" }, [
				react.createElement("label", { key: "label", htmlFor: selectId, className: "tsm-label" }, t("collectionLabel")),
				react.createElement(HostSelect, { key: "select", nested: compact, id: selectId, label: t("collectionLabel"), value: currentId, disabled: busy, onChange: (collectionId) => run("collections/select", { collectionId }), items: collections.filter((c) => showArchived || !c.archived || c.id === currentId).map((c) => ({ id: c.id, label: c.name + (c.archived ? " · " + t("collectionArchived") : "") })) }),
				current && current.archived ? react.createElement("p", { key: "archived", className: "tsm-note" }, t("collectionArchiveHint")) : null,
				!compact && value.reading && value.reading.count > 0 ? react.createElement("div", { key: "summary" }, [
					react.createElement(ReadingBar, { key: "bar", t, reading: { maxRatio: value.reading.percent / 100 } }),
					react.createElement("p", { key: "unknown", className: "tsm-note" }, fill(t("collectionReadingHint"), { count: value.reading.unrecorded }))
				]) : null,
				react.createElement("details", { key: "manage", className: "tsm-manage" }, [
					react.createElement("summary", { key: "summary" }, t("collectionManage")),
					react.createElement("div", { key: "body", className: "tsm-foldbody" }, [
						primitives.Checkbox ? react.createElement(primitives.Checkbox, { key: "archived-toggle", checked: showArchived, onChange: setShowArchived, label: t("collectionShowArchived") }) : null,
						react.createElement("form", { key: "form", onSubmit: (event) => { event.preventDefault(); run("collections/manage", { action, ...(action === "rename" ? { id: currentId } : {}), sourceId: currentId, name }); } }, [
							react.createElement(HostSelect, { key: "action", nested: compact, label: t("collectionAction"), value: action, disabled: busy, onChange: setAction, items: ["create", "copy", "rename"].map((a) => ({ id: a, label: t("collection" + a) })) }),
							react.createElement("label", { key: "name-label", htmlFor: inputId, className: "tsm-label" }, t("collectionName")),
							react.createElement(primitives.Input || "input", { key: "name", id: inputId, className: primitives.Input ? "tsm-name-input" : "tsm-control", maxLength: 100, required: true, value: name, disabled: busy, onChange: (event) => setName(event.target.value) }),
							react.createElement(primitives.Button || "button", { key: "save", className: "tsm-btn", type: "submit", disabled: busy || !name.trim() }, busy ? t("saving") : t("collectionApply"))
						]),
						react.createElement(primitives.Button || "button", { key: "archive", type: "button", className: "tsm-quiet", disabled: busy, onClick: () => run("collections/manage", { action: current && current.archived ? "restore" : "archive", id: currentId }) }, current && current.archived ? t("collectionRestore") : t("collectionArchive")),
						!compact && Array.isArray(value.available) && value.available.length ? react.createElement("div", { key: "adopt" }, [
							react.createElement(HostSelect, { key: "candidate", nested: compact, label: t("collectionAdopt"), value: candidate, disabled: busy, onChange: setCandidate, items: [{ id: "", label: t("collectionChooseVersion") }, ...value.available.map((v) => ({ id: JSON.stringify(v), label: v.title + " · " + v.contentVersion.slice(0, 8) }))] }),
							react.createElement(primitives.Button || "button", { key: "adopt", type: "button", className: "tsm-btn", disabled: busy || !candidate || (current && current.archived), onClick: () => { const v = JSON.parse(candidate); run("collections/manage", { action: "adopt", id: currentId, ...v }); } }, t("collectionAdopt")),
							react.createElement("p", { key: "hint", className: "tsm-note" }, t("collectionAdoptHint"))
						]) : null
					])
				]),
				error ? react.createElement("p", { key: "error", className: "tsm-noticeline--error", role: "alert" }, error) : null
			]);
		}
		function TeachingDefaults({ t, value, write, disabled }) {
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState("");
			const change = async (field, next) => {
				setBusy(true); setNotice(t("saving"));
				try { const accepted = await write(["teaching", field], next); if (!accepted) throw new Error("rejected"); setNotice(t("saved")); }
				catch { setNotice(t("preferenceSaveFailed")); }
				finally { setBusy(false); }
			};
			return react.createElement("div", { className: "tsm-group" }, [
				react.createElement("h3", { key: "title", className: "tsm-groupname" }, t("teachingDefaults")),
				react.createElement("p", { key: "hint", className: "tsm-note" }, t("teachingDefaultsHint")),
				...['factCheck', 'depth'].map((field) => react.createElement(LevelSlider, { key: field, t, field, value: value[field], disabled: disabled || busy, onChange: (next) => change(field, next) })),
				react.createElement("p", { key: "notice", role: "status", className: "tsm-note" }, notice)
			]);
		}
		function TeachingDockBody({ t, sessionId, callRpc }) {
			const triggerRef = react.useRef(null);
			const [open, setOpen] = react.useState(false);
			const [value, setValue] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState("");
			const [error, setError] = react.useState("");
			const [tick, setTick] = react.useState(0);
			react.useEffect(() => {
				let alive = true;
				Promise.resolve(callRpc("preferences/get", { sessionId })).then((result) => {
					if (!alive) return;
					if (!result || !result.ok) throw new Error(classroomErrorText(t, result && result.error));
					setValue(result.value); setError("");
				}).catch((failure) => { if (alive) setError(failure.message); });
				const changed = (event) => { if (event.detail.sessionId === sessionId) setTick((n) => n + 1); };
				window.addEventListener("teach-preferences-changed", changed);
				return () => { alive = false; window.removeEventListener("teach-preferences-changed", changed); };
			}, [sessionId, tick]);
			const change = async (field, next) => {
				if (busy) return;
				setBusy(true); setNotice(t("saving")); setError("");
				try {
					const result = await callRpc("preferences/set", { sessionId, [field]: next });
					if (!result || !result.ok) throw new Error(classroomErrorText(t, result && result.error));
					setValue((prior) => ({ ...prior, ...result.value })); setNotice(t("saved"));
				} catch (failure) { setNotice(""); setError(t("preferenceSaveFailed") + " " + failure.message); }
				finally { setBusy(false); }
			};
			const contents = react.createElement("div", { className: "tsm-foldbody" }, [
				react.createElement("p", { key: "hint", className: "tsm-note" }, t("teachingSessionHint")),
				value ? react.createElement(CollectionControls, { key: "collections", t, sessionId, callRpc, value, compact: true, onChanged: () => setTick((n) => n + 1) }) : null,
				value ? ["factCheck", "depth"].map((field) => react.createElement(LevelSlider, { key: field, t, field, value: value[field], disabled: busy, onChange: (next) => change(field, next) })) : null,
				// 成功/正在保存只给读屏：弹层最后一行不再出现「已保存」；失败仍走下面的可见 alert。
				react.createElement("span", { key: "notice", role: "status", "aria-live": "polite", className: "tsm-sr" }, value ? notice : t("loading")),
				error ? react.createElement("div", { key: "error", role: "alert" }, [react.createElement("p", { key: "text", className: "tsm-noticeline--error" }, error), react.createElement("button", { key: "retry", type: "button", className: "tsm-quiet", onClick: () => setTick((n) => n + 1) }, t("coursesRetry"))]) : null
			]);
			const Menu = primitives.Menu;
			const Button = primitives.Button || "button";
			const Sliders = primitives.IconSlidersTwoOutlineRegular;
			const Chevron = primitives.IconChevronDownOutlineRegular;
			const anchor = react.createElement(Button, {
				ref: triggerRef, type: "button", variant: "ghost", size: "sm", className: "tsm-teaching-seat",
				"aria-label": t("teachingSettings"), "aria-haspopup": "menu", "aria-expanded": open,
				disabled: !Menu, onClick: () => setOpen((current) => !current)
			}, [
				Sliders ? react.createElement(Sliders, { key: "icon", size: 16, "aria-hidden": true }) : null,
				react.createElement("span", { key: "label" }, t("teachingSettings")),
				Chevron ? react.createElement(Chevron, { key: "chevron", size: 12, className: "tsm-seat-chevron", "aria-hidden": true }) : null
			]);
			return react.createElement("span", { className: "tsm-surface tsm-teaching-seat-wrap" }, [
				react.createElement("style", { key: "style", dangerouslySetInnerHTML: { __html: SURFACE_CSS } }),
				Menu ? react.createElement(Menu, {
					key: "menu", open, onClose: () => setOpen(false), portal: true, align: "start",
					anchor, autoFocus: true, returnFocus: () => triggerRef.current, listClassName: "tsm-teaching-menu"
				}, react.createElement("div", { className: "tsm-surface tsm-teaching-popover", "aria-label": t("teachingSettings") }, contents)) : anchor
			]);
		}
		function TeachingDock(props) {
			const blank = typeof props.useSession === "function" ? props.useSession((state) => state.blank) : props.session?.blank;
			const projection = typeof props.useProjection === "function" ? props.useProjection("agentPreset") : undefined;
            const preset = projection ?? (typeof props.useSessions === "function" ? props.useSessions((state) => state.byId[props.sessionId]?.projectionValues?.agentPreset) : props.session?.projectionValues?.agentPreset);
			if (preset !== "teach" || (props.placement === "active" && blank !== false)) return null;
			return react.createElement(TeachingDockBody, { key: props.sessionId, ...props });
		}

		//region 文案
		/** 中文文案。 */
		const zh = {
			checkReviewer: "核查者",
			checkFixed: "已修正",
			checkRemoved: "已删除",
			checkPending: "待核",
			checkFollowup: "复查",

			teachingSettings: "教学设置",
			teachingDefaults: "教学默认值",
			teachingDefaultsHint: "仅新会话采用；已有会话保持自己的设置。",
			teachingSessionHint: "仅当前会话；修改在下一次请求生效，正在生成的课程保持原设置。",
			factCheckLabel: "事实核查等级",
			depthLabel: "讲解深度",
			checkNone: "不核查",
			checkLoose: "宽松",
			checkModerate: "适中",
			checkStrict: "严格",
			depthShallow: "浅显",
			depthModerate: "适中",
			depthDeep: "深入",
			preferenceSaveFailed: "保存失败，已恢复上次保存值。",
			readingLabel: "阅读进度",
			readingUnknown: "暂无阅读记录",
			readingUnsaved: "尚未保存",
			readingRetry: "重试保存",
			collectionLabel: "当前教学集合",
			collectionArchived: "已归档",
			collectionArchiveHint: "可继续阅读；生成新课程前请先恢复集合。",
			collectionReadingHint: "按课程等权统计；其中 {count} 节暂无阅读记录。阅读不代表掌握。",
			collectionManage: "管理集合",
			collectionShowArchived: "显示已归档集合",
			collectionAction: "集合操作",
			collectioncreate: "新建集合",
			collectioncopy: "复制课程清单",
			collectionrename: "重命名当前集合",
			collectionName: "集合名称",
			collectionApply: "保存集合",
			collectionRestore: "恢复集合",
			collectionArchive: "归档当前集合",
			collectionAdopt: "添加或采用此版本",
			collectionChooseVersion: "选择已发布课程版本",
			collectionAdoptHint: "采用内容新版后阅读从零开始，旧版记录保留。复制集合不复制学习历史。",
			factCheckDetails: "事实核查详情",
			factCheckIncomplete: "核查未完成",
			factCheckComplete: "核查已完成",
			versionHistory: "历史内容版本",
			openVersion: "打开此版本",

			nav: "教学模式",
			title: "教学模式",
			animationHint: "Remotion 工程的绝对路径；留空就不做动画。",
			animationPlaceholder: "/绝对路径/到/Remotion 工程",
			softLimit: "动画时长上限（秒）",
			missing: "工程缺失时",
			missingSkip: "安静跳过",
			missingWarn: "在阶段回执里提醒",
			staging: "每课源码先放工作区",
			stagingHint: "源码先写到工作区的 .dsh-teach-me/animation-src/；关掉则要求工程本身在会话工作区里。",
			saving: "正在保存…",
			saved: "已保存",
			failed: "保存失败，输入已保留，请再试一次。",
			rangeHint: "整片动画的建议时长上限；超出后在分镜理由里写一句。默认 120 秒，范围 10–600。",
			invalidLimit: "范围外，已恢复上次保存的值。",
			invalidSaved: "保存的值超出 10–600，请填一个范围内的整数秒。",
			missingHint: "选「提醒」只在阶段回执里点一句，不影响课程交付。",
			unavailable: "设置里还没有这一行（重启宿主后才会出现）",
			readonly: "当前配置不可写",
			loading: "读取中…",
			classroomTab: "课堂",
			classroomBack: "‹ 选课",
			classroomLoading: "正在打开课堂…",
			classroomFailed: "课堂打不开",
			classroomExport: "导出离线页",
			classroomImport: "导入进度",
			classroomRefresh: "重新加载课堂",
			classroomOpenAgain: "重新打开",
			classroomSubmitted: "已提交",
			classroomReloaded: "课堂已重新加载",
			coursesTab: "教学模式 · 选课",
			coursesIntro: "从这里选一节课；题目和作答都在课堂页签里。",
			coursesEmptyTitle: "还没有发布的课程",
			coursesEmpty: "让导师发布一节课，发布后会出现在这里。",
			coursesLoading: "正在读课程…",
			coursesFailed: "课程列表读不到",
			coursesRefresh: "刷新",
			coursesRetry: "重试",
			coursesOpen: "打开",
			coursesPick: "选课",

			coursesNoArchiveTitle: "还没有学习档案",
			coursesNoArchive: "发布第一节课、或第一次提交作答之后，档案会在这里建起来。",
			netUnreachable: "课堂接口不可达：HTTP {status}",
			netFailed: "课堂接口请求失败：{message}",
			badResponse: "课堂接口返回了不认识的内容（HTTP {status}）",
			requestTimeout: "课堂接口 15 秒没有响应，先确认宿主还在运行",
			coursesOpenFailed: "打不开这节课：宿主没有挂课堂页签，重启后再试",
			coursesPickFailed: "打不开选课页签：宿主没有挂侧栏，重启后再试",
			importTooLarge: "文件超过 {size} MB，先拆分再导入",
			importNotObject: "导入内容不是学习进度对象",
			importVersionText: "只支持 version 1 的学习进度文件",
			importResult: "进度已导入：新增 {imported}，跳过 {skipped}",
			importNotJson: "这个文件不是 JSON",
			classroomExported: "离线页已导出",
			classroomNoUrl: "课堂没有给出课程页地址。",
			listSep: "、",
			staleReasonWrap: "（{reason}）",
			// ——设计重构新增：三面共用的词表与账目行——
			pageNote: "移开焦点即保存；预设本身在新建会话时选。",
			stateOn: "这一版会做动画：目录已保存，工程本身还没验证。",
			stateOff: "这一版不做动画：还没配工程目录。",
			stateInvalidLimit: "这一版会做动画；存下来的时长上限不合法。",
			sectionProject: "动画工程",
			sectionStoryboard: "动画时长",
			projectRoot: "工程目录",
			ledgerQuestions: "{count} 题",
			ledgerAnswered: "已答 {count}",
			ledgerPending: "待批改 {count}",
			ledgerPendingOf: "其中待批改 {count}",
			ledgerNoAnswer: "尚未作答",
			ledgerAssessment: "最近评估：",
			// ——首次安装的欢迎页（只出现一次）——
			welcomeKicker: "教学模式 · 首次使用",
			welcomeTitle: "欢迎使用教学模式",
			welcomeLede: "一个学习目标，一节课：先诊断你的起点，再讲清楚，最后让你自己作答。",
			welcomeOnce: "这一页只会出现一次。关掉后不再出现；想再看，到设置页点「重新显示欢迎页」。",
			welcomeStep1: "选预设",
			welcomeStep1Body: "新建会话时，在输入框那一行的预设选择器里选「教学模式」。",
			welcomeStep2: "说要学什么",
			welcomeStep2Body: "给出目标、当前基础和想用的材料；先答诊断题，再确认小课计划。",
			welcomeStep3: "到课堂里读和答",
			welcomeStep3Body: "侧栏「教学模式 · 选课」打开课程；页面自测与「提交到课堂」是两回事。",
			welcomeSettingsTitle: "另外两处设置",
			welcomeSessionSettings: "「教学设置」按钮：与预设选择器同排，改当前会话的核查等级与讲解深度。",
			welcomeSettingsPage: "「设置 → 教学模式」：新会话的默认值，以及动画工程目录。",
			welcomeAnimationTitle: "教学动画（可选）",
			welcomeAnimationBody: "默认不做动画。要做，先在设置页填 Remotion 工程的绝对路径。",
			welcomeAnimationBody2: "插件只在这个目录里读写；填好后先提案，你同意才写代码和渲染，参考线 120 秒。",
			welcomeStart: "开始使用",
			welcomeClose: "关闭",
			welcomeSection: "欢迎页",
			welcomeReopen: "重新显示欢迎页",
			welcomeReopenHint: "第一次安装后显示一次；关掉后不再出现。",
			classroomFailedNext: "重新打开，或者回选课换一节。",
			"verdict.passed": "通过",
			"verdict.failed": "未通过",
			"verdict.needsPractice": "需练习",
			"verdict.needsReview": "待复核",
			coursesCount: "{count} 节课",
			coursesOpenName: "打开 {title}，{count} 题",
			coursesAnsweredOn: "作答 {day}",
			coursesVerdictAt: "评估 {day}",
			coursesVerdictStale: "评估已过期",
			coursesVerdictHistory: "上次 {word}",
			coursesQuestionless: "本课没有练习题",
			coursesSubmittedNoVerdict: "已提交，暂无结论",
			coursesNotSubmitted: "尚未提交作答",
			coursesGapUnregistered: "{count} 题还没登记进档案",
			coursesUnshown: "{count} 题没排进页面",
			"code.lesson-not-found": "这节课还没发布，或者已经不在课程清单里",
			"code.lesson-revision-stale": "课程改版了，重新打开这节课",
			"code.session-mismatch": "会话对不上，重新打开这节课",
			"code.workspace-mismatch": "这个工作区对不上",
			"code.ticket-invalid": "课堂凭据无效，重新打开这节课",
			"code.ticket-expired": "课堂凭据过期了，重新打开这节课",
			"code.unauthorized": "没有权限：宿主的登录态可能已经过期",
			"code.forbidden": "没有权限做这件事",
			"code.rate-limited": "操作太频繁，等一会儿再试",
			"code.export-failed": "导出离线页失败",
			"code.bad-request": "请求内容不完整",
			"code.unknown-endpoint": "这个宿主版本不支持该操作",
			"code.request-timeout": "课堂接口没有响应",
			"code.import-version": "只支持 version 1 的学习进度文件",
			"code.import-lesson": "导入文件不是这节课程的",
			"code.import-workspace": "导入文件不是这个工作区的",
			"code.import-revision": "导入文件对应旧版课程",
			"code.import-fingerprint": "导入文件对不上这节课程的发布指纹",
			"code.import-question-revision": "导入文件里的题目改版了，重新导出后再导入",
			"code.import-too-many": "一次导入的记录太多，请拆分文件"
		};
		/** 英文文案。 */
		const en = {
			checkReviewer: "Reviewer",
			checkFixed: "Corrected",
			checkRemoved: "Removed",
			checkPending: "Pending verification",
			checkFollowup: "Follow-up",

			teachingSettings: "Teaching settings",
			teachingDefaults: "Teaching defaults",
			teachingDefaultsHint: "Applies to new sessions. Existing sessions keep their settings.",
			teachingSessionHint: "This session only. Changes apply to the next request.",
			factCheckLabel: "Fact checking",
			depthLabel: "Explanation depth",
			checkNone: "None",
			checkLoose: "Loose",
			checkModerate: "Moderate",
			checkStrict: "Strict",
			depthShallow: "Shallow",
			depthModerate: "Moderate",
			depthDeep: "Deep",
			preferenceSaveFailed: "Save failed. Restored the last saved value.",
			readingLabel: "Reading progress",
			readingUnknown: "No reading record",
			readingUnsaved: "Not saved",
			readingRetry: "Retry saving",
			collectionLabel: "Teaching collection",
			collectionArchived: "Archived",
			collectionArchiveHint: "Reading is available. Restore before generating lessons.",
			collectionReadingHint: "Equal weight per lesson; {count} have no reading record. Reading does not mean mastery.",
			collectionManage: "Manage collections",
			collectionShowArchived: "Show archived collections",
			collectionAction: "Collection action",
			collectioncreate: "Create collection",
			collectioncopy: "Copy lesson list",
			collectionrename: "Rename current collection",
			collectionName: "Collection name",
			collectionApply: "Save collection",
			collectionRestore: "Restore collection",
			collectionArchive: "Archive current collection",
			collectionAdopt: "Add or adopt version",
			collectionChooseVersion: "Choose a published version",
			collectionAdoptHint: "A new content version starts reading at zero. Old history is kept. Copies have no learning history.",
			factCheckDetails: "Fact-check details",
			factCheckIncomplete: "Fact checking incomplete",
			factCheckComplete: "Fact checking complete",
			versionHistory: "Content version history",
			openVersion: "Open version",

			nav: "Teaching mode",
			title: "Teaching mode",
			animationHint: "Absolute path of the Remotion project; leave it empty to skip animation.",
			animationPlaceholder: "/absolute/path/to/Remotion-project",
			softLimit: "Animation length limit (seconds)",
			missing: "When the project is missing",
			missingSkip: "Skip silently",
			missingWarn: "Mention it in the stage reply",
			staging: "Keep lesson sources in the workspace",
			stagingHint: "Write sources under .dsh-teach-me/animation-src/; off means the project itself must live in the workspace.",
			saving: "Saving…",
			saved: "Saved",
			failed: "Save failed; your input is kept. Try again.",
			rangeHint: "Suggested limit for the whole animation; explain any overrun in the storyboard notes. Default 120 seconds, range 10–600.",
			invalidLimit: "Out of range; the last saved value is back.",
			invalidSaved: "The saved value is outside 10–600. Enter a whole number in range.",
			missingHint: "“Mention it” only adds a line to the stage reply; it never blocks a lesson.",
			unavailable: "This entry is not served yet (restart the host)",
			readonly: "Settings are read-only",
			loading: "Loading…",
			classroomTab: "Classroom",
			classroomBack: "‹ Lessons",
			classroomLoading: "Opening classroom…",
			classroomFailed: "Could not open the classroom",
			classroomExport: "Export offline page",
			classroomImport: "Import progress",
			classroomRefresh: "Reload classroom",
			classroomOpenAgain: "Reopen",
			classroomSubmitted: "Submitted",
			classroomReloaded: "Classroom reloaded",

			coursesTab: "Teaching · pick a lesson",
			coursesIntro: "Pick a lesson here; questions and answers live in the classroom tab.",
			coursesEmptyTitle: "No lessons published yet",
			coursesEmpty: "Ask the tutor to publish a lesson; it shows up here once it exists.",
			coursesLoading: "Reading lessons…",
			coursesFailed: "Could not read the lesson list",
			coursesRefresh: "Refresh",
			coursesRetry: "Try again",
			coursesOpen: "Open",
			coursesPick: "Lessons",

			coursesNoArchiveTitle: "No archive yet",
			coursesNoArchive: "Publish a first lesson, or send a first answer, and the archive starts here.",
			netUnreachable: "Classroom API unreachable: HTTP {status}",
			netFailed: "Classroom API request failed: {message}",
			badResponse: "The classroom API returned something unexpected (HTTP {status})",
			requestTimeout: "The classroom API did not respond within 15 seconds; check that the host is running",
			coursesOpenFailed: "Could not open this lesson: the classroom tab is not mounted. Restart the host.",
			coursesPickFailed: "Could not open the lesson list: the sidebar is not mounted. Restart the host.",
			importTooLarge: "This file is larger than {size} MB; split it before importing",
			importNotObject: "The import is not a progress file",
			importVersionText: "Only version 1 progress files are supported",
			importResult: "Progress imported: {imported} added, {skipped} skipped",
			importNotJson: "That file is not JSON",
			classroomExported: "Offline page exported",
			classroomNoUrl: "The classroom returned no lesson page address.",
			listSep: ", ",
			staleReasonWrap: " ({reason})",
			// ——design refactor: shared vocabulary for the three surfaces——
			pageNote: "Focus leaving a field saves it; pick the preset itself when starting a session.",
			stateOn: "Animation is on: the directory is saved, the project itself is not verified.",
			stateOff: "Animation is off: no project directory yet.",
			stateInvalidLimit: "Animation is on; the saved length limit is invalid.",
			sectionProject: "Animation project",
			sectionStoryboard: "Animation length",
			projectRoot: "Project directory",
			ledgerQuestions: "{count} questions",
			ledgerAnswered: "{count} answered",
			ledgerPending: "{count} awaiting grading",
			ledgerPendingOf: "{count} of them awaiting grading",
			ledgerNoAnswer: "Nothing answered yet",
			ledgerAssessment: "latest assessment: ",
			// ——first-run welcome page (shown once)——
			welcomeKicker: "Teaching mode · first run",
			welcomeTitle: "Welcome to Teaching mode",
			welcomeLede: "One learning goal, one lesson: diagnose where you start, explain it clearly, then let you answer.",
			welcomeOnce: "This page appears only once. Close it and it will not come back; to see it again, use “Show the welcome page” in the settings page.",
			welcomeStep1: "Pick the preset",
			welcomeStep1Body: "When you start a session, choose “Teaching mode” in the preset selector on the composer row.",
			welcomeStep2: "Say what you want to learn",
			welcomeStep2Body: "Give the goal, your background and any material; answer the diagnostic questions, then confirm the plan.",
			welcomeStep3: "Read and answer in the classroom",
			welcomeStep3Body: "Open lessons from the sidebar under “Teaching mode · Lessons”; the page self-check and “Submit to classroom” are separate.",
			welcomeSettingsTitle: "Two more places to look",
			welcomeSessionSettings: "The “Teaching settings” button next to the preset selector: fact checking and explanation depth for this session.",
			welcomeSettingsPage: "Settings → Teaching mode: defaults for new sessions, and the animation project directory.",
			welcomeAnimationTitle: "Teaching animation (optional)",
			welcomeAnimationBody: "Animation is off by default. To use it, set the absolute path of your Remotion project in the settings page.",
			welcomeAnimationBody2: "The plugin only reads and writes inside that directory; the tutor proposes a storyboard first, and code plus rendering follow only after you agree. Length guide: 120 seconds.",
			welcomeStart: "Get started",
			welcomeClose: "Close",
			welcomeSection: "Welcome page",
			welcomeReopen: "Show the welcome page",
			welcomeReopenHint: "Shown once after install. Closing it hides it for good.",
			classroomFailedNext: "Reopen it, or go back to the lesson list.",
			"verdict.passed": "Passed",
			"verdict.failed": "Failed",
			"verdict.needsPractice": "Needs practice",
			"verdict.needsReview": "Needs review",
			coursesCount: "{count} lessons",
			coursesOpenName: "Open {title}, {count} questions",
			coursesAnsweredOn: "answered {day}",
			coursesVerdictAt: "graded {day}",
			coursesVerdictStale: "expired",
			coursesVerdictHistory: "last {word}",
			coursesQuestionless: "no questions in this lesson",
			coursesSubmittedNoVerdict: "submitted, not graded yet",
			coursesNotSubmitted: "nothing answered yet",
			coursesGapUnregistered: "{count} not registered in the archive",
			coursesUnshown: "{count} not on the page",
			"code.lesson-not-found": "This lesson is not published, or no longer listed",
			"code.lesson-revision-stale": "The lesson changed; reopen it",
			"code.session-mismatch": "Session mismatch; reopen this lesson",
			"code.workspace-mismatch": "This import belongs to another workspace",
			"code.ticket-invalid": "Classroom credentials are not valid; reopen this lesson",
			"code.ticket-expired": "Classroom credentials expired; reopen this lesson",
			"code.unauthorized": "Not authorized: the host sign-in may have expired",
			"code.forbidden": "Not allowed to do that",
			"code.rate-limited": "Too many requests; wait a moment and retry",
			"code.export-failed": "Exporting the offline page failed",
			"code.bad-request": "The request was incomplete",
			"code.unknown-endpoint": "This host version does not support that action",
			"code.request-timeout": "The classroom API did not respond",
			"code.import-version": "Only version 1 progress files are supported",
			"code.import-lesson": "That import belongs to another lesson",
			"code.import-workspace": "That import belongs to another workspace",
			"code.import-revision": "That import matches an older lesson revision",
			"code.import-fingerprint": "That import does not match this lesson's published fingerprint",
			"code.import-question-revision": "Questions in that import have changed; export progress again",
			"code.import-too-many": "Too many records in one import; split the file"
		};
		//endregion

		//region 样式（宿主令牌 + 一层作用域样式表）
		/**
		 * 宿主面唯一的样式层：三个承载面共用一个作用域类，伪类、命中区、容器查询、分隔线都写在这里。
		 * 为什么不用内联样式：内联表达不了 :focus-visible、@media/@container，也表达不了「相邻之间一条线」，
		 * 而这些刚好是这一面该精致的地方。
		 *
		 * 尺度：字号 11 / 12 / 13 / 14 / 16（14 只给课程名与开关行标题）；间距 2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 / 28；
		 * 分隔只有一种 1px --dsw-alias-border-l2；圆角跟宿主 --dsw-radius-md（本宿主 12px）。
		 * 颜色一律取宿主令牌，缺失的走回退链，不新造颜色。
		 */
		const SURFACE_CSS = `.tsm-surface.tsm-teaching-seat-wrap{display:inline-flex;min-width:0;container-type:normal}.tsm-surface .tsm-teaching-seat{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;white-space:nowrap}.tsm-surface .tsm-teaching-seat:hover,.tsm-surface .tsm-teaching-seat[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.tsm-surface .tsm-seat-chevron{color:var(--dsw-alias-label-caption)}.tsm-teaching-menu{width:340px;max-width:calc(100vw - 24px);max-height:min(70vh,560px);overflow-y:auto}.tsm-surface.tsm-teaching-popover{padding:4px 12px 12px;font-size:13px}.tsm-teaching-popover .tsm-foldbody{padding:4px 0;animation:none}.tsm-surface .tsm-name-input{width:100%}.tsm-surface .tsm-menu-select-anchor{display:block;min-width:0}.tsm-surface .tsm-menu-select{display:flex;width:100%;justify-content:space-between;gap:8px;min-height:36px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);font:inherit}.tsm-menu-select>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tsm-surface .tsm-menu-select[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}@media(pointer:coarse){.tsm-surface .tsm-teaching-seat,.tsm-surface .tsm-menu-select{min-height:44px}}

.tsm-surface .tsm-manage[open]>.tsm-foldbody{max-height:40vh;overflow:auto}.tsm-surface .tsm-level{display:grid;gap:8px;margin:16px 0}.tsm-surface .tsm-level input[type=range]{width:100%;accent-color:var(--dsw-alias-brand-primary,currentColor);min-height:28px;cursor:pointer}.tsm-surface .tsm-stops{display:flex;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-secondary)}.tsm-surface .tsm-stops [data-selected=true]{color:var(--dsw-alias-label-primary);font-weight:600;transition:color 140ms ease}.tsm-surface .tsm-reading{display:block;width:100%;padding:8px 0}.tsm-surface .tsm-readinglabel{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}.tsm-surface .tsm-progress{height:3px;background:var(--dsw-alias-border-l2);margin-top:6px;overflow:hidden}.tsm-surface .tsm-progress>span{display:block;height:100%;background:var(--dsw-alias-label-primary);transition:width 160ms ease-out}.tsm-surface .tsm-collections{padding:12px 0;display:grid;gap:8px;border-bottom:.5px solid var(--dsw-alias-border-l2)}.tsm-surface .tsm-manage summary{cursor:pointer;font-size:13px;padding:6px 0;color:var(--dsw-alias-label-secondary)}.tsm-surface .tsm-foldbody{padding:12px 0;animation:tsm-unfold 160ms ease-out}.tsm-surface .tsm-foldbody form{display:grid;gap:8px;margin:12px 0}.tsm-surface .tsm-inline{display:flex;align-items:center;gap:8px;font-size:13px}.tsm-surface .tsm-version{padding:8px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}.tsm-surface .tsm-evidence{max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.tsm-surface input[type=range]:focus-visible,.tsm-surface summary:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-label-primary));outline-offset:2px}@keyframes tsm-unfold{from{opacity:.55;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.tsm-surface .tsm-foldbody{animation:none}.tsm-surface .tsm-progress>span,.tsm-surface .tsm-stops [data-selected=true]{transition:none}}@media(pointer:coarse){.tsm-surface .tsm-level input[type=range],.tsm-surface summary{min-height:44px}}
/* 宿主三面唯一的样式层：设置页 / 选课 / 课堂共用。取宿主令牌，缺失走回退链（回退值同时是宿主当前值）。
   字号不另造档：全部映射到宿主自己的字号令牌 --dsw-font-*（11/12/13/14/16 档）；
   分隔只有 .5px border-l2，与宿主设置行同一条线；圆角跟宿主 radius-sm；颜色一律 --dsw-*。 */
.tsm-surface{
  box-sizing:border-box;
  font-family:var(--dsw-font-family,inherit);
  font-size:var(--dsw-font-xs-13-font-size,13px);
  line-height:var(--dsw-font-xs-13-line-height,20px);
  color:var(--dsw-alias-label-primary);
  container-type:inline-size;
  --tsm-16:var(--dsw-font-base-16-font-size,16px);
  --tsm-16-lh:var(--dsw-font-base-16-line-height,24px);
  --tsm-14:var(--dsw-font-s-14-font-size,14px);
  --tsm-14-lh:var(--dsw-font-s-14-line-height,22px);
  --tsm-13:var(--dsw-font-xs-13-font-size,13px);
  --tsm-13-lh:var(--dsw-font-xs-13-line-height,20px);
  --tsm-12:var(--dsw-font-xxs-12-font-size,12px);
  --tsm-12-lh:var(--dsw-font-xxs-12-line-height,18px);
}
.tsm-surface *{box-sizing:border-box}
/* reset 用 :where() 降到零权重：任何组件类都能覆盖它，不再靠标签碰巧是 div 或 p（V08）。 */
:where(.tsm-surface) :where(p,h2,h3,ul,ol,li,hr){margin:0;padding:0}
.tsm-surface ul,.tsm-surface ol{list-style:none}
.tsm-surface :focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
.tsm-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* ——设置页—— */
.tsm-page{display:flex;flex-direction:column;gap:0;max-width:640px}
.tsm-head{display:flex;flex-direction:column;gap:6px;padding-bottom:28px}
.tsm-title{font-size:var(--tsm-16);line-height:var(--tsm-16-lh);font-weight:600;color:var(--dsw-alias-label-primary)}
.tsm-state{font-size:var(--tsm-13);line-height:var(--tsm-13-lh);color:var(--dsw-alias-label-primary)}
.tsm-note{font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary)}
.tsm-availability{padding-bottom:12px;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary)}
/* 上 20、下 24：组尾留出收尾，分隔线两侧都不贴字（V02）。 */
.tsm-group{display:flex;flex-direction:column;gap:16px;padding:20px 0 24px;border-top:.5px solid var(--dsw-alias-border-l2)}
.tsm-grouphead{display:flex;flex-direction:column;gap:4px;padding-bottom:2px}
.tsm-groupname{font-size:var(--tsm-14);line-height:var(--tsm-14-lh);font-weight:600;color:var(--dsw-alias-label-primary)}
.tsm-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.tsm-labelrow{display:flex;align-items:baseline;gap:8px;min-width:0}
.tsm-label{font-size:var(--tsm-13);line-height:var(--tsm-13-lh);font-weight:500;color:var(--dsw-alias-label-primary)}
.tsm-label--off{color:var(--dsw-alias-label-secondary)}
.tsm-pending{flex:0 0 auto;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tsm-control{width:100%;min-height:36px;padding:6px 10px;font-family:inherit;font-size:var(--tsm-13);line-height:var(--tsm-13-lh);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,8px);transition:border-color 120ms ease-out}
.tsm-control:hover:not(:disabled){border-color:var(--dsw-alias-border-l4)}
.tsm-control:focus-visible{outline-offset:1px}
.tsm-control:disabled{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);cursor:not-allowed}
.tsm-control[aria-invalid="true"]{border-color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary))}
.tsm-control--mono{font-family:var(--dsh-font-family-code-default,ui-monospace,"SF Mono",monospace)}
.tsm-control--number{max-width:120px;font-variant-numeric:tabular-nums}
.tsm-control--select{max-width:260px}
.tsm-hint{font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary)}
.tsm-hint--error{font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary))}
/* 方框紧挨名字：只有一个开关时，右端对齐只会造出一条 500px 的空白（V03）。 */
.tsm-switchrow{display:flex;align-items:center;justify-content:flex-start;gap:8px;min-height:24px}
.tsm-check{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,currentColor)}

/* ——侧栏两面：课堂与选课共用一套壳—— */
.tsm-pane{display:flex;flex-direction:column;height:100%;min-height:0;gap:0;padding:12px;overflow:hidden}
.tsm-toolbar{display:flex;align-items:center;gap:8px;min-height:24px;padding-bottom:8px}
.tsm-count{margin-right:auto;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.tsm-noticeline{min-height:var(--tsm-12-lh);padding-bottom:4px;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.tsm-noticeline--error{color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary))}
.tsm-rule{flex:0 0 auto;height:0;border-top:.5px solid var(--dsw-alias-border-l2)}
.tsm-list{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow-y:auto;margin:0 -12px;border-top:.5px solid var(--dsw-alias-border-l2)}
/* 阅读条上的重试：常驻在标签行右侧，出现/消失不改变阅读条高度。 */
.tsm-surface .tsm-reading--with-leading{padding:2px 0 0}
.tsm-reading--with-leading .tsm-readinglabel{gap:8px}
.tsm-readingleading{display:block;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tsm-readingspacer{flex:1 1 auto}
.tsm-reading--with-leading .tsm-readingword{flex:0 0 auto}
.tsm-readingword{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tsm-readingtail{display:inline-flex;align-items:center;gap:4px;min-width:0;white-space:nowrap}
.tsm-readingretry{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:24px;height:24px;margin:-4px -4px -4px 0;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 120ms ease-out,color 120ms ease-out}
.tsm-readingretry::after{content:"";position:absolute;left:50%;top:50%;width:2px;height:2px;margin:-1px 0 0 -1px;border-radius:50%;background:currentColor}
.tsm-readingretry:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.tsm-readingretry:disabled{cursor:default;opacity:.45}
.tsm-readingretry[data-pending=true]{opacity:1;color:var(--dsw-alias-label-primary)}
.tsm-readingretryglyph{font-size:14px;line-height:1}
.tsm-lesson{display:flex;flex-direction:column;gap:2px;width:100%;padding:10px 12px;font-family:inherit;font-size:var(--tsm-13);line-height:var(--tsm-13-lh);text-align:start;color:var(--dsw-alias-label-primary);background:none;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2);border-radius:0;cursor:pointer}
.tsm-lesson:last-child{border-bottom:0}
.tsm-lesson:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.tsm-lesson:focus-visible{outline-offset:-2px}
.tsm-lessonline{display:flex;align-items:baseline;gap:12px;width:100%;min-width:0}
.tsm-lessontitle{flex:1 1 auto;min-width:0;font-size:var(--tsm-14);line-height:var(--tsm-14-lh);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tsm-figure{flex:0 0 auto;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
/* 入口提示常驻：不靠悬停才长出来，题量也不随悬停消失（U04）。 */
.tsm-caret{flex:0 0 auto;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary)}
.tsm-lessonmeta{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;min-width:0;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.tsm-verdict{color:var(--dsw-alias-label-primary);font-weight:500}
.tsm-verdict--bad{color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary))}
/* 历史/说明性事实：灰字，不参与「要动手」的强调（V06）。 */
.tsm-history{color:var(--dsw-alias-label-secondary)}
.tsm-stale{display:inline-block;padding:0 6px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-state-warn-tertiary,#fef5e7);color:var(--dsw-alias-label-primary);font-size:var(--tsm-12);line-height:var(--tsm-12-lh)}
/* 题号不一致：一行说清，具体题号进 title，不拿内部 id 撑行高（V05）。 */
.tsm-gap{margin-top:2px;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.tsm-gap b{font-weight:500}
.tsm-skeleton{display:flex;flex-direction:column;justify-content:center;gap:6px;min-height:60px;padding:0 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.tsm-bone{display:block;height:14px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-skeleton,rgba(38,49,72,.06))}
.tsm-bone--title{width:72%}
.tsm-bone--meta{width:44%;height:12px}
/* 状态块只有一条左边：面板里与正文对齐（0），列表里补回那 12px 的负 margin（V08）。 */
.tsm-empty{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:16px 0;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.tsm-list > .tsm-empty{padding:16px 12px}
.tsm-empty b{font-size:var(--tsm-13);line-height:var(--tsm-13-lh);font-weight:500;color:var(--dsw-alias-label-primary)}
.tsm-emptytext{display:flex;flex-direction:column;gap:2px;min-width:0}
.tsm-empty > .tsm-actions,.tsm-empty > .tsm-quiet{margin-top:2px}
.tsm-empty > .tsm-quiet{margin-left:-6px}

/* ——课堂—— */
.tsm-classhead{display:flex;flex-direction:column;gap:4px;padding-bottom:8px}
.tsm-backrow{display:flex;align-items:baseline;gap:10px;min-width:0}
.tsm-back{flex:0 0 auto;padding:0;font-family:inherit;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary);background:none;border:0;cursor:pointer}
.tsm-back:hover{color:var(--dsw-alias-label-primary)}
.tsm-lessonname{flex:1 1 auto;min-width:0;font-size:var(--tsm-14);line-height:var(--tsm-14-lh);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tsm-ledger{display:flex;flex-direction:column;gap:2px;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.tsm-ledgerline{display:block}
/* 结论单独一句：它只是最近一次评估，不是整课结论（U02）。 */
.tsm-ledgerassessment{display:block;color:var(--dsw-alias-label-secondary)}
/* 紧凑顶栏：账目收进阅读条左侧，只占一行；长内容省略，完整文本留在 title。 */
.tsm-ledger--inline{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.tsm-ledger--inline .tsm-ledgerassessment{display:inline;color:inherit}
.tsm-ledgersep{color:var(--dsw-alias-label-secondary)}
.tsm-backrow--title{align-items:center;gap:8px}
.tsm-classactions{flex:0 0 auto;display:flex;align-items:center;gap:2px;margin-left:2px}
.tsm-classaction{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 120ms ease-out,color 120ms ease-out}
.tsm-classaction:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.tsm-classaction:disabled{color:var(--dsw-alias-label-secondary);cursor:default;opacity:.55}
.tsm-classaction--import svg{transform:rotate(180deg)}
.tsm-classactionglyph{font-size:14px;line-height:1}
.tsm-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:0 0 10px}
.tsm-btn{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:3px 12px;font-family:inherit;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);font-weight:500;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,8px);cursor:pointer;white-space:nowrap;transition:background-color 120ms ease-out}
.tsm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
/* 动作只有两种形态：一枚描边主钮，其余是不带下划线的次级文字钮（V07）。 */
.tsm-quiet{flex:0 0 auto;min-height:24px;padding:2px 6px;font-family:inherit;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);color:var(--dsw-alias-label-secondary);background:none;border:0;border-radius:var(--dsw-radius-xs,4px);cursor:pointer;white-space:nowrap;transition:background-color 120ms ease-out,color 120ms ease-out}
.tsm-quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.tsm-btn:disabled,.tsm-quiet:disabled{color:var(--dsw-alias-label-secondary);cursor:default;opacity:1}
.tsm-btn:disabled{border-color:var(--dsw-alias-border-l2);background:transparent}
.tsm-quiet:disabled{background:none}
.tsm-frame{flex:1 1 auto;width:100%;min-height:140px;border:0;background:var(--dsw-alias-bg-base)}

/* ——选课：吸顶顶栏。集合选择留在滚动区外，列表从顶栏下面经过。 —— */
.tsm-pane--courses{padding:0;overflow:hidden}
.tsm-pane--courses > .tsm-collections{flex:0 0 auto;margin:0 12px;padding:12px 0}
.tsm-pane--courses .tsm-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 12px 12px;overscroll-behavior:contain}
.tsm-pane--courses .tsm-topbar{position:sticky;top:0;z-index:2;margin:0 -12px;padding:8px 12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);background:color-mix(in srgb,var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base)) 72%,transparent);-webkit-backdrop-filter:var(--dsw-mask-blur);backdrop-filter:var(--dsw-mask-blur)}
.tsm-pane--courses .tsm-toolbar{min-height:24px;padding:0 0 8px}
.tsm-pane--courses .tsm-noticeline{padding-bottom:8px}
.tsm-pane--courses .tsm-list{flex:none;min-height:0;overflow:visible;border-top:0}

/* ——课堂：顶栏覆盖在 iframe 上，课程页从顶栏下面经过。 —— */
.tsm-pane--classroom{position:relative;padding:0;gap:0;overflow:hidden}
.tsm-pane--classroom .tsm-classbar{position:absolute;inset:0 0 auto;z-index:2;display:flex;flex-direction:column;gap:0;max-height:calc(100% - 120px);overflow-y:auto;overscroll-behavior:contain;padding:12px 12px 0;background:var(--dsw-alias-bg-base);background:color-mix(in srgb,var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base)) 72%,transparent);-webkit-backdrop-filter:var(--dsw-mask-blur);backdrop-filter:var(--dsw-mask-blur)}
.tsm-pane--classroom .tsm-classhead{padding-bottom:2px}
.tsm-pane--classroom .tsm-classbar .tsm-manage summary{padding:2px 0;font-size:var(--tsm-12);line-height:var(--tsm-12-lh)}
.tsm-pane--classroom .tsm-frame{position:absolute;inset:0 12px;width:calc(100% - 24px);height:100%;min-height:0;flex:none}

/* 宿主没有提供官方遮罩模糊（--dsw-mask-blur:none，常见于 Web）时，
   退回同一套主题里的官方菜单模糊；两个令牌都来自宿主，不硬编码 blur 值。 */
.tsm-surface[data-tsm-mask=off] .tsm-topbar,
.tsm-surface[data-tsm-mask=off] .tsm-classbar{-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);backdrop-filter:var(--dsw-menu-backdrop-filter)}

/* 系统要求减少透明时，顶栏改回不透明底色，保证文字对比度。 */
@media (prefers-reduced-transparency: reduce){
  .tsm-surface[data-tsm-mask] .tsm-topbar,.tsm-surface[data-tsm-mask] .tsm-classbar{background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base));-webkit-backdrop-filter:none;backdrop-filter:none}
}

/* 窄面板：标签行与行内结论折行，不靠省略号硬截 */
@container (max-width:300px){
  .tsm-labelrow{flex-wrap:wrap}
}
/* 粗指针：控件与按钮放大到 44，勾选框 20 并带 44 行高 */
@media (pointer:coarse){
  .tsm-control{min-height:44px}
  .tsm-btn{min-height:44px}
  .tsm-quiet{min-height:44px}
  .tsm-lesson{padding:12px}
  .tsm-switchrow{min-height:44px}
  .tsm-check{width:20px;height:20px}
  .tsm-classaction{width:44px;height:44px}
  .tsm-readingretry{width:32px;height:32px}
}
@media (prefers-reduced-motion:reduce){
  .tsm-control,.tsm-btn,.tsm-readingretry,.tsm-classaction{transition:none}
}

/* ——首次安装欢迎页—— */
/* 宿主弹层默认宽 min(380px,100%)：欢迎页要放三段说明，放宽到 520。
   双类选择器只为压过宿主弹层自己的单类 width，不是新的一层主题。 */
.tsm-welcome-modal.tsm-welcome-modal{width:min(520px,calc(100vw - 24px));max-height:min(88vh,760px)}
/* 正文自己滚：宿主弹层是 overflow:hidden，短屏下不滚就会被裁掉。 */
.tsm-surface.tsm-welcome{display:flex;flex-direction:column;gap:16px;max-height:min(74vh,640px);overflow-y:auto;overscroll-behavior:contain}
.tsm-welcome-kicker{display:flex;align-items:center;gap:6px;font-size:var(--tsm-12);line-height:var(--tsm-12-lh);letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.tsm-welcome-lede{font-size:var(--tsm-14);line-height:1.7;text-wrap:pretty;color:var(--dsw-alias-label-primary)}
/* 「只出现一次」是一句承诺，不是脚注：给一条竖线，位置紧跟导语。 */
.tsm-welcome-once{padding-left:10px;border-left:2px solid var(--dsw-alias-border-l3);font-size:var(--tsm-12);line-height:var(--tsm-12-lh);text-wrap:pretty;color:var(--dsw-alias-label-secondary)}
.tsm-welcome-steps{display:flex;flex-direction:column;gap:12px}
.tsm-welcome-step{display:flex;align-items:flex-start;gap:10px}
.tsm-welcome-stepnum{flex:0 0 auto;width:20px;height:20px;border:1px solid var(--dsw-alias-border-l3);border-radius:50%;font-size:var(--tsm-12);line-height:18px;font-variant-numeric:tabular-nums;text-align:center;color:var(--dsw-alias-label-secondary)}
.tsm-welcome-steptext{display:flex;flex-direction:column;gap:2px;min-width:0}
.tsm-welcome-stepname{font-size:var(--tsm-13);line-height:var(--tsm-13-lh);font-weight:600;color:var(--dsw-alias-label-primary)}
.tsm-welcome-stepbody{font-size:var(--tsm-13);line-height:1.6;text-wrap:pretty;color:var(--dsw-alias-label-secondary)}
.tsm-welcome-group{display:flex;flex-direction:column;gap:6px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2)}
.tsm-welcome-groupname{font-size:var(--tsm-13);line-height:var(--tsm-13-lh);font-weight:600;color:var(--dsw-alias-label-primary)}
.tsm-welcome-line{font-size:var(--tsm-12);line-height:1.65;text-wrap:pretty;color:var(--dsw-alias-label-secondary)}
/* 窄于 420：弹层在手机上只剩 ~360，靠收紧纵向节奏把整页留在一屏内，而不是先让人滚动。 */
@container (max-width:420px){
  .tsm-welcome-steps{gap:10px}
  .tsm-welcome-group{padding-top:10px;gap:4px}
  .tsm-welcome-lede{font-size:var(--tsm-13);line-height:1.65}
}
@container (max-width:360px){
  .tsm-welcome-step{gap:8px}
  .tsm-welcome-stepnum{width:18px;height:18px;line-height:16px}
}`;
		//endregion


		/** 课堂调用最多等 15 秒：宿主卡住时界面要给出「没响应」，不能一直转。 */
		const REQUEST_TIMEOUT_MS = 15000;

		/** 活区「清空 → 再写入」之间的那一拍：够让读屏看见变化，又不至于听得出来是两句话。 */
		const ANNOUNCE_DELAY_MS = 40;

		/** 导入文件上限 8 MB：超过就不读进内存，先让人拆分文件。 */
		const IMPORT_MAX_BYTES = 8 * 1024 * 1024;

		/** 软性上限的允许区间，与 lib/config-schema.js 的 min/max 一致。 */
		const LIMIT_MIN = 10;
		const LIMIT_MAX = 600;
		/** 不填时按这个秒数算：页头的生效状态句要说出一个具体数字，不能空着。 */
		const DEFAULT_LIMIT_SECONDS = 120;

		/**
		 * 解析「软性上限」输入。
		 * 空 = 用默认值（120 秒），不写配置；只有整数秒才写回，避免把 12.5 悄悄存成别的数。
		 * @param {string} raw 输入框里的原始字符串
		 * @returns {{ kind: "empty" } | { kind: "invalid" } | { kind: "ok", value: number }}
		 */
		function parseLimitInput(raw) {
			if (typeof raw !== "string" || raw.trim() === "") return { kind: "empty" };
			const value = Number(raw);
			if (!Number.isFinite(value) || !Number.isInteger(value) || value < LIMIT_MIN || value > LIMIT_MAX) return { kind: "invalid" };
			return { kind: "ok", value };
		}

		/**
		 * 品牌标记：与 `assets/brand/icon-line.svg` 同一份几何（512 视窗、线稿、currentColor）。
		 * 线宽按显示尺寸乘 `weight`——16–24px 下 22 的基准线宽只剩 0.7px，会糊成发丝。
		 * 遮罩把人像从黑板那一组里挖掉，所以构图不变也不会出现线条互穿。
		 */
		function TeachMark({ size = 16, weight = 1.8 }) {
			const rawId = react.useId ? react.useId() : "teach";
			const maskId = "teach-mark-" + String(rawId).replace(/[^a-zA-Z0-9]/g, "");
			const sw = (base) => base * weight;
			const body = "M336 373 V267 A26 26 0 0 1 362 241 L420 241 A26 26 0 0 1 446 267 V373 Z";
			return react.createElement("svg", {
				viewBox: "0 0 512 512",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true,
				focusable: "false",
				display: "block"
			},
				react.createElement("defs", null,
					react.createElement("mask", { id: maskId, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 512, height: 512 },
						react.createElement("rect", { x: 0, y: 0, width: 512, height: 512, fill: "#ffffff" }),
						react.createElement("g", { fill: "#000000", stroke: "#000000", strokeWidth: sw(16), strokeLinejoin: "round" },
							react.createElement("path", { d: body }),
							react.createElement("circle", { cx: 391, cy: 195, r: 34 })
						)
					)
				),
				react.createElement("g", { transform: "translate(-38.4 -37.8) scale(1.15)" },
					react.createElement("g", { mask: "url(#" + maskId + ")" },
						react.createElement("rect", { x: 66, y: 138, width: 280, height: 235, rx: 40, strokeWidth: sw(22) }),
						react.createElement("path", { d: "M92 216 H252", strokeWidth: sw(18) }),
						react.createElement("path", { d: "M92 266 H184", strokeWidth: sw(18) })
					),
					react.createElement("path", { d: "M336 283 Q 306 266 260 242", strokeWidth: sw(14) }),
					react.createElement("path", { d: body, strokeWidth: sw(22) }),
					react.createElement("path", { d: "M365 241 L391 323 L417 241", strokeWidth: sw(22) }),
					react.createElement("circle", { cx: 391, cy: 195, r: 34, strokeWidth: sw(22) })
				)
			);
		}

		/** 设置导航里的图标：宿主给 `size`，按它画。 */
		function TeachSettingsIcon({ size }) {
			return react.createElement(TeachMark, { size: size || 20, weight: 1.7 });
		}

		/**
		 * 右侧栏引导页的胶囊图标。宿主给 22（有描述）或 26（无描述），
		 * 不给这个字段时它画的是自己的方块占位图——那正是「仍是默认图标」的来源。
		 */
		function TeachGuideIcon(props) {
			return react.createElement(TeachMark, { size: (props && props.size) || 22, weight: 1.6 });
		}

		/** 侧栏标题：标记 + 文案，共用一行。 */
		function MarkedTitle({ label }) {
			return react.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", minWidth: 0 } },
				react.createElement(TeachMark, { size: 14, weight: 1.9 }),
				react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label)
			);
		}

		//region 首次安装的欢迎页
		/**
		 * 「已看过」的浏览器兜底标记。
		 *
		 * 主记录在 profile 设置行的 `welcome.seen` 上（换浏览器也不会再弹）。这里只在一种情况下用：
		 * 宿主把这次写入拒了（只读 profile、接口超时、离线）。没有它，写不进去时欢迎页会在
		 * 每次刷新后再来一遍——那正是最招人烦的「只出现一次」。
		 * 拿不到 localStorage（隐私模式、沙箱、非浏览器）就当成没有标记，不抛错、不降级成别的东西。
		 */
		const WELCOME_MARK_KEY = "dsh-teach-me:welcome";

		function welcomeMarkStore() {
			try {
				const store = typeof window === "undefined" ? undefined : window.localStorage;
				return store === undefined || store === null ? null : store;
			} catch {
				return null;
			}
		}

		function readWelcomeMark() {
			const store = welcomeMarkStore();
			if (store === null) return false;
			try { return store.getItem(WELCOME_MARK_KEY) === "1" } catch { return false }
		}

		function writeWelcomeMark() {
			const store = welcomeMarkStore();
			if (store === null) return;
			try { store.setItem(WELCOME_MARK_KEY, "1") } catch {}
		}

		function clearWelcomeMark() {
			const store = welcomeMarkStore();
			if (store === null) return;
			try { store.removeItem(WELCOME_MARK_KEY) } catch {}
		}

		/**
		 * 欢迎页此刻该不该出现——唯一判定点，单测只钉这一处真值表和组件接线。
		 *
		 * 三条同时成立才出现：配置读到了、这一行可写、还没看过。
		 * 读不到配置或不可写时都不弹：弹了也没地方记住「已看过」，等于每次刷新都来一遍。
		 * 只读部署因此没有欢迎页，这是有意的取舍（见 ADR-0021）。
		 * @param {{ status?: string, writable?: boolean, value?: object } | undefined} snapshot configForms 快照
		 * @param {boolean} seenLocally 浏览器兜底标记
		 * @returns {boolean}
		 */
		function decideWelcome(snapshot, seenLocally) {
			if (snapshot === undefined || snapshot === null || snapshot.status !== "ready") return false;
			if (snapshot.writable !== true) return false;
			if (seenLocally === true) return false;
			const value = snapshot.value === null || typeof snapshot.value !== "object" ? {} : snapshot.value;
			const welcome = value.welcome === null || typeof value.welcome !== "object" ? {} : value.welcome;
			return welcome.seen !== true;
		}

		/**
		 * 欢迎页正文：纯内容，不碰配置。
		 *
		 * 弹层外壳（portal、焦点陷阱、Esc）交给宿主 `Modal`，这里不造第二套；
		 * bench 与单测渲染的也是这一块，所以它必须能单独挂载。
		 */
		function TeachWelcomeBody({ t }) {
			const step = (index, name, body) => react.createElement("li", { key: "step-" + index, className: "tsm-welcome-step" }, [
				react.createElement("span", { key: "num", className: "tsm-welcome-stepnum", "aria-hidden": "true" }, String(index)),
				react.createElement("span", { key: "text", className: "tsm-welcome-steptext" }, [
					react.createElement("span", { key: "name", className: "tsm-welcome-stepname" }, name),
					react.createElement("span", { key: "body", className: "tsm-welcome-stepbody" }, body)
				])
			]);
			const group = (key, title, lines) => react.createElement("div", { key: key, className: "tsm-welcome-group" }, [
				react.createElement("h3", { key: "name", className: "tsm-welcome-groupname" }, title),
				...lines.map((line, index) => react.createElement("p", { key: "line-" + index, className: "tsm-welcome-line" }, line))
			]);
			return react.createElement("div", { className: "tsm-surface tsm-welcome" }, [
				react.createElement("style", { key: "style", dangerouslySetInnerHTML: { __html: SURFACE_CSS } }),
				react.createElement("p", { key: "kicker", className: "tsm-welcome-kicker" }, [
					react.createElement(TeachMark, { key: "mark", size: 18, weight: 1.75 }),
					react.createElement("span", { key: "text" }, t("welcomeKicker"))
				]),
				react.createElement("p", { key: "lede", className: "tsm-welcome-lede" }, t("welcomeLede")),
				react.createElement("p", { key: "once", className: "tsm-welcome-once" }, t("welcomeOnce")),
				react.createElement("ol", { key: "steps", className: "tsm-welcome-steps" }, [
					step(1, t("welcomeStep1"), t("welcomeStep1Body")),
					step(2, t("welcomeStep2"), t("welcomeStep2Body")),
					step(3, t("welcomeStep3"), t("welcomeStep3Body"))
				]),
				group("settings", t("welcomeSettingsTitle"), [t("welcomeSessionSettings"), t("welcomeSettingsPage")]),
				group("animation", t("welcomeAnimationTitle"), [t("welcomeAnimationBody"), t("welcomeAnimationBody2")])
			]);
		}

		/**
		 * 欢迎页浮层：注册在宿主的 root 级 `shell.overlay` 上，第一次安装后出现一次。
		 *
		 * 关闭 = 把 `welcome.seen` 写进 profile 的设置行（volatile，写入不重启插件），此后任何
		 * 浏览器都不再弹；写回失败时只留浏览器兜底标记，不反复打扰。设置页的「重新显示欢迎页」
		 * 把同一个字段写回 false，这里跟着重新出现。
		 */
		function TeachWelcome(props) {
			const { t, useConfig, write } = props;
			const Modal = primitives.Modal;
			const Button = primitives.Button || "button";
			const snapshot = typeof useConfig === "function" ? useConfig((state) => state) : undefined;
			const [closed, setClosed] = react.useState(false);
			const [seenLocally, setSeenLocally] = react.useState(() => readWelcomeMark());
			const value = snapshot !== undefined && snapshot !== null && snapshot.value !== null && typeof snapshot.value === "object" ? snapshot.value : {};
			const welcome = value.welcome !== null && typeof value.welcome === "object" ? value.welcome : {};
			const seen = welcome.seen === true;
			// 设置页把它写回 false 之后，弹层要能当场再开一次：判定值一变就把乐观关闭复位。
			react.useEffect(() => { if (!seen) setClosed(false) }, [seen]);
			if (Modal === undefined || Modal === null) return null;
			if (closed) return null;
			if (!decideWelcome(snapshot, seenLocally)) return null;
			const dismiss = () => {
				setClosed(true);
				const markFallback = () => { writeWelcomeMark(); setSeenLocally(true); };
				Promise.resolve(typeof write === "function" ? write(["welcome", "seen"], true) : false).then((accepted) => {
					if (accepted === true) return;
					markFallback();
				}, markFallback);
			};
			return react.createElement(Modal, {
				open: true,
				onClose: dismiss,
				title: t("welcomeTitle"),
				closeLabel: t("welcomeClose"),
				className: "tsm-welcome-modal",
				children: react.createElement(TeachWelcomeBody, { t }),
				footer: react.createElement(Button, { variant: "primary", "data-modal-autofocus": true, onClick: dismiss }, t("welcomeStart"))
			});
		}
		//endregion

		/**
		 * 教学模式设置页：四个字段，改完即写，写的是 profile 里那一行 `teach-settings`。
		 * 宿主侧 `lib/settings.js` 只暴露 volatile 字段，所以这个页面除了这四个不碰别的。
		 * 每个字段有自己的保存结果：成功后两秒消失，失败留在原地等重试；
		 * 范围外的数字不会被悄悄改写，而是恢复上次保存的值并说明原因。
		 */
		function TeachSettingsSection(props) {
			const { t, useConfig, write } = props;
			const snapshot = useConfig((state) => state);
			const value = snapshot.value || {};
			const animation = value.animation || {};
			const savedRoot = typeof animation.root === "string" ? animation.root : "";
			const savedLimit = animation.softLimitSeconds === undefined ? "" : String(animation.softLimitSeconds);
			const [draft, setDraft] = react.useState({ root: undefined, softLimit: undefined });
			const [notices, setNotices] = react.useState({});
			// 只有这一处是活区：字段旁的「已保存」是给眼睛的，读屏统一听这一行。
			const [announce, setAnnounce] = react.useState("");
			let alive = react.useRef(true);
			let timers = react.useRef({});
			let announceTimer = react.useRef(null);
			let announceSeq = react.useRef(0);
			// Esc 放弃本次编辑：置位后由 onBlur 消费，避免撤销动作又被当成一次保存。
			let cancelBlur = react.useRef(false);
			react.useEffect(() => {
				// StrictMode 会先跑一次 cleanup 再重新 setup：这里必须把标志复位，
				// 否则开发模式下第一次保存之后所有结果都会被当成「组件已卸载」丢掉。
				alive.current = true;
				const pending = timers.current;
				return () => {
					alive.current = false;
					for (const id of Object.values(pending)) clearTimeout(id);
					if (announceTimer.current !== null) clearTimeout(announceTimer.current);
				};
			}, []);

			const writable = snapshot.status === "ready" && snapshot.writable === true;
			const root = draft.root !== undefined ? draft.root : savedRoot;
			const softLimit = draft.softLimit !== undefined ? draft.softLimit : savedLimit;
			// 只有「存下来的值本身越界」才在纸面上标错；正在输入的新值等 lose focus 再判，
			// 否则敲 "120" 的前两下会一路闪红。
			const limitInvalid = parseLimitInput(savedLimit).kind === "invalid";
			// 页面级状态只讲「现在能不能改」，保存结果挂在各自字段上。
			const availability = snapshot.status === "loading" ? t("loading") : snapshot.status === "unavailable" ? t("unavailable") : snapshot.writable === false ? t("readonly") : "";

			/** 记一条字段级结果；成功两秒后自己消失，失败留在原地直到下次编辑。 */
			/**
			 * 把一句话送进活区。同一个字段连着存两次同样的结果时，只改文本值 DOM 没变，
			 * 读屏不会再播一遍；所以先把活区清空，下一拍再写进去（用序号挡住过期的定时器）。
			 */
			const announceText = (message) => {
				const seq = announceSeq.current + 1;
				announceSeq.current = seq;
				setAnnounce("");
				if (typeof setTimeout !== "function") {
					setAnnounce(message);
					return;
				}
				if (announceTimer.current !== null) clearTimeout(announceTimer.current);
				announceTimer.current = setTimeout(() => {
					if (alive.current && announceSeq.current === seq) setAnnounce(message);
				}, ANNOUNCE_DELAY_MS);
			};

			const setFieldNotice = (field, tone, text) => {
				// 播报带上字段名，否则「已保存」三个字脱离上下文没有意义。
				const fields = { root: t("projectRoot"), softLimit: t("softLimit"), missing: t("missing"), staging: t("staging"), welcome: t("welcomeSection") };
				announceText(fields[field] + " · " + text);
				const pending = timers.current;
				if (pending[field] !== undefined) {
					clearTimeout(pending[field]);
					delete pending[field];
				}
				setNotices((previous) => ({ ...previous, [field]: { tone, text } }));
				if (tone === "saved") {
					pending[field] = setTimeout(() => {
						if (alive.current) setNotices((previous) => ({ ...previous, [field]: undefined }));
					}, 2400);
				}
			};

			/** 开始重新编辑时收起上次的结果：旧结果贴在输入框上会误导。 */
			const clearFieldNotice = (field) => {
				const pending = timers.current;
				if (pending[field] !== undefined) {
					clearTimeout(pending[field]);
					delete pending[field];
				}
				setNotices((previous) => (previous[field] === undefined ? previous : { ...previous, [field]: undefined }));
			};

			/** 保存一次，把结果落到该字段的状态行；只有宿主接受后才清掉草稿（失败保留用户输入）。 */
			const save = (field, path, next, onAccepted) => {
				if (!writable) return;
				setFieldNotice(field, "pending", t("saving"));
				Promise.resolve(write(path, next)).then((accepted) => {
					if (!alive.current) return;
					if (accepted) {
						if (typeof onAccepted === "function") onAccepted();
						setFieldNotice(field, "saved", t("saved"));
					} else {
						setFieldNotice(field, "error", t("failed"));
					}
				}, () => {
					if (alive.current) setFieldNotice(field, "error", t("failed"));
				});
			};

			/** 字段名 + 该字段的即时结果：正在保存/已保存贴着标签，失败落在控件下方（错误是要动手的，不能离控件远）。 */
			const fieldHead = (field, text, htmlFor) => {
				const notice = notices[field];
				const quiet = notice !== undefined && notice.tone !== "error";
				return react.createElement("div", { key: "head", className: "tsm-labelrow" }, [
					react.createElement("label", { key: "label", htmlFor: htmlFor, className: writable ? "tsm-label" : "tsm-label tsm-label--off" }, text),
					quiet ? react.createElement("span", { key: "notice", "aria-hidden": "true", className: "tsm-pending" }, notice.text) : null
				]);
			};

			/** 字段的错误行：保存失败与「存下来的值越界」共用同一个位置，所以错误一处只现一行。 */
			const fieldError = (field, id) => {
				const notice = notices[field];
				const text = notice !== undefined && notice.tone === "error"
					? notice.text
					: field === "softLimit" && limitInvalid ? t("invalidSaved") : "";
				if (text === "") return null;
				return react.createElement("p", { key: "error", id: id, className: "tsm-hint--error" }, text);
			};
			const describedBy = (field, hintId, errorId) => (fieldError(field, errorId) === null ? hintId : hintId + " " + errorId);

			// 配置没读完之前不替用户下结论：读不到就说读不到，不能顺手说成「这一版不做动画」。
			const configReady = snapshot.status === "ready";
			// 这一面的「一个问题」：这一套配置现在会产生什么。句子由配置算出来，不是另写一句文案。
			const seconds = limitInvalid || savedLimit === "" ? String(DEFAULT_LIMIT_SECONDS) : savedLimit;
			const stateLine = !configReady
				? ""
				: savedRoot === ""
					? t("stateOff")
					: limitInvalid ? t("stateInvalidLimit") : fill(t("stateOn"), { seconds: seconds });

			return react.createElement("section", {
				id: "teach-me-settings",
				className: "tsm-surface tsm-page",
				"aria-labelledby": "teach-me-settings-title"
			}, [
				react.createElement("style", { key: "style", dangerouslySetInnerHTML: { __html: SURFACE_CSS } }),
				// 页头两段：标题 + 生效状态（墨色），下一行才是那句「怎么存」的说明。
				react.createElement("div", { key: "head", className: "tsm-head" }, [
					react.createElement("h2", { key: "title", id: "teach-me-settings-title", className: "tsm-title" }, t("title")),
					stateLine === "" ? null : react.createElement("p", { key: "state", className: "tsm-state" }, stateLine),
					configReady ? react.createElement("p", { key: "note", className: "tsm-note" }, t("pageNote")) : null
				]),
				availability === "" ? null : react.createElement("p", { key: "availability", className: "tsm-availability" }, availability),
				configReady
					? [
					react.createElement(TeachingDefaults, { key: "teaching-defaults", t, value: value.teaching || {}, write, disabled: !writable }),
					react.createElement("div", { key: "project", className: "tsm-group" }, [
						react.createElement("div", { key: "name", className: "tsm-grouphead" }, [
							react.createElement("h3", { key: "h", className: "tsm-groupname" }, t("sectionProject"))
						]),
						react.createElement("div", { key: "root", className: "tsm-field" }, [
							fieldHead("root", t("projectRoot"), "teach-me-animation-root"),
							react.createElement("input", {
								key: "input",
								id: "teach-me-animation-root",
								className: "tsm-control tsm-control--mono",
								"aria-describedby": describedBy("root", "teach-me-animation-root-hint", "teach-me-animation-root-error"),
								type: "text",
								spellCheck: false,
								autoComplete: "off",
								autoCapitalize: "off",
								autoCorrect: "off",
								value: root,
								placeholder: t("animationPlaceholder"),
								disabled: !writable,
								onChange: (event) => {
									clearFieldNotice("root");
									setDraft((previous) => ({ ...previous, root: event.target.value }));
								},
								onBlur: () => {
									if (cancelBlur.current) {
										cancelBlur.current = false;
										setDraft((previous) => ({ ...previous, root: undefined }));
										return;
									}
									const next = (draft.root !== undefined ? draft.root : root).trim();
									if (next === savedRoot) {
										setDraft((previous) => ({ ...previous, root: undefined }));
										return;
									}
									save("root", ["animation", "root"], next, () => setDraft((previous) => ({ ...previous, root: undefined })));
								},
								onKeyDown: (event) => {
									if (event.key === "Enter") event.currentTarget.blur();
									if (event.key === "Escape") {
										cancelBlur.current = true;
										event.currentTarget.blur();
									}
								}
							}),
							react.createElement("p", { key: "hint", id: "teach-me-animation-root-hint", className: "tsm-hint" }, t("animationHint")),
							fieldError("root", "teach-me-animation-root-error")
						]),
						react.createElement("div", { key: "missing", className: "tsm-field" }, [
							fieldHead("missing", t("missing"), "teach-me-animation-missing"),
							react.createElement(HostSelect, {
								key: "select", id: "teach-me-animation-missing", label: t("missing"),
								className: "tsm-control",
								"aria-describedby": describedBy("missing", "teach-me-animation-missing-hint", "teach-me-animation-missing-error"),
								value: animation.missing === "warn" ? "warn" : "skip", disabled: !writable,
								onChange: (next) => save("missing", ["animation", "missing"], next),
								items: [{ id: "skip", label: t("missingSkip") }, { id: "warn", label: t("missingWarn") }]
							}),
							react.createElement("p", { key: "hint", id: "teach-me-animation-missing-hint", className: "tsm-hint" }, t("missingHint")),
							fieldError("missing", "teach-me-animation-missing-error")
						]),
						// 勾选项：方框紧挨名字（8px），不再推到行尾假装工具栏；保存结果仍跟在名字后面。
						react.createElement("div", { key: "staging", className: "tsm-field" }, [
							react.createElement("div", { key: "line", className: "tsm-switchrow" }, [
								react.createElement("input", {
									key: "box",
									id: "teach-me-animation-staging",
									className: "tsm-check",
									type: "checkbox",
									"aria-describedby": describedBy("staging", "teach-me-animation-staging-hint", "teach-me-animation-staging-error"),
									checked: animation.staging !== false,
									disabled: !writable,
									onChange: (event) => {
										save("staging", ["animation", "staging"], event.target.checked);
									}
								}),
								react.createElement("div", { key: "name", className: "tsm-labelrow" }, [
									react.createElement("label", {
										key: "label",
										htmlFor: "teach-me-animation-staging",
										className: writable ? "tsm-label" : "tsm-label tsm-label--off"
									}, t("staging")),
									notices.staging === undefined || notices.staging.tone === "error" ? null : react.createElement("span", {
										key: "notice",
										"aria-hidden": "true",
										className: "tsm-pending"
									}, notices.staging.text)
								])
							]),
						react.createElement("p", { key: "hint", id: "teach-me-animation-staging-hint", className: "tsm-hint" }, t("stagingHint")),
							fieldError("staging", "teach-me-animation-staging-error")
						])
					]),
					react.createElement("div", { key: "storyboard", className: "tsm-group" }, [
						react.createElement("div", { key: "name", className: "tsm-grouphead" }, [
							react.createElement("h3", { key: "h", className: "tsm-groupname" }, t("sectionStoryboard"))
						]),
						react.createElement("div", { key: "limit", className: "tsm-field" }, [
							fieldHead("softLimit", t("softLimit"), "teach-me-soft-limit"),
							react.createElement("input", {
								key: "input",
								id: "teach-me-soft-limit",
								className: "tsm-control tsm-control--number",
								"aria-describedby": describedBy("softLimit", "teach-me-soft-limit-hint", "teach-me-soft-limit-error"),
								"aria-invalid": limitInvalid ? "true" : "false",
								type: "number",
								inputMode: "numeric",
								min: LIMIT_MIN,
								max: LIMIT_MAX,
								step: 10,
								value: softLimit,
								placeholder: String(DEFAULT_LIMIT_SECONDS),
								disabled: !writable,
								onChange: (event) => {
									clearFieldNotice("softLimit");
									setDraft((previous) => ({ ...previous, softLimit: event.target.value }));
								},
								onBlur: () => {
									if (cancelBlur.current) {
										cancelBlur.current = false;
										setDraft((previous) => ({ ...previous, softLimit: undefined }));
										return;
									}
									const raw = draft.softLimit !== undefined ? draft.softLimit : softLimit;
									const parsed = parseLimitInput(raw);
									if (parsed.kind === "empty") {
										// 清空 = 回到默认 120 秒，不往配置里写一个魔法数字。
										setDraft((previous) => ({ ...previous, softLimit: undefined }));
										return;
									}
									if (parsed.kind === "invalid") {
										// 不悄悄改成 10 或 600：恢复上次保存的值，并说明为什么。
										setDraft((previous) => ({ ...previous, softLimit: undefined }));
										setFieldNotice("softLimit", "error", t("invalidLimit"));
										return;
									}
									if (parsed.value === animation.softLimitSeconds) {
										setDraft((previous) => ({ ...previous, softLimit: undefined }));
										return;
									}
									save("softLimit", ["animation", "softLimitSeconds"], parsed.value, () => setDraft((previous) => ({ ...previous, softLimit: undefined })));
								},
								onKeyDown: (event) => {
									if (event.key === "Enter") event.currentTarget.blur();
									if (event.key === "Escape") {
										cancelBlur.current = true;
										event.currentTarget.blur();
									}
								}
							}),
							react.createElement("p", { key: "hint", id: "teach-me-soft-limit-hint", className: "tsm-hint" }, t("rangeHint")),
							fieldError("softLimit", "teach-me-soft-limit-error")
						])
					]),
					// 欢迎页的一次性说明放在最后：它是「恢复入口」，不是常用开关。
					// 写回的是欢迎页自己读的同一个字段（welcome.seen），所以点完当场就会再出现一次。
					react.createElement("div", { key: "welcome", className: "tsm-group" }, [
						react.createElement("div", { key: "name", className: "tsm-grouphead" }, [
							react.createElement("h3", { key: "h", className: "tsm-groupname" }, t("welcomeSection")),
							react.createElement("p", { key: "hint", className: "tsm-hint" }, t("welcomeReopenHint"))
						]),
						react.createElement("div", { key: "action", className: "tsm-actions" }, [
							react.createElement(primitives.Button || "button", {
								key: "reopen",
								type: "button",
								className: "tsm-btn",
								disabled: !writable,
								onClick: () => save("welcome", ["welcome", "seen"], false, clearWelcomeMark)
							}, t("welcomeReopen")),
							notices.welcome !== undefined && notices.welcome.tone === "saved"
								? react.createElement("span", { key: "notice", "aria-hidden": "true", className: "tsm-pending" }, notices.welcome.text)
								: null
						]),
						fieldError("welcome", "teach-me-welcome-error")
					])
					]
					: null,
				react.createElement("p", { key: "announce", role: "status", "aria-live": "polite", className: "tsm-sr" }, announce)
			]);
		}

		//region 课堂侧栏
		const TAB_ID = "dsh-teach-me";
		const CLASSROOM_KIND = "teach-classroom";
		const CLASSROOM_NS = "teach.classroom";

		/**
		 * 课堂页签的排布：标题独占一行（课程名可以很长，不该和按钮抢同一行后各占一半），
		 * 动作按钮在下一行按 8px 排开；340px 的侧栏里四个按钮正好一行。
		 */
		/** 只接管 dsh-resource://file/session/<id>/<path> 下的 lessons/*.html。 */
		function isLessonAddress(address) {
			if (typeof address !== "string") return false;
			const match = /^dsh-resource:\/\/file\/session\/[^/]+\/(.+)$/.exec(address);
			if (match === null) return false;
			let relative;
			try {
				relative = decodeURIComponent(match[1]).replace(/\\/g, "/");
			} catch {
				return false;
			}
			return /(^|\/)lessons\//.test(relative) && /\.html?$/i.test(relative);
		}

		/** 文案模板填值：数字与片段由代码给，句子由文案表给，两边都不拼语言。 */
		function fill(template, values) {
			return String(template).replace(/\{([a-zA-Z]+)\}/g, (whole, name) => {
				const value = values !== null && values !== undefined ? values[name] : undefined;
				return value === undefined ? whole : String(value);
			});
		}

		/**
		 * 服务端错误码 → 界面上那句话。码表里的码翻成当前语言（en 界面不该弹中文），
		 * 没登记的码回退服务端原文（宁可读到中文，也不要丢掉真实原因），最后才回退码本身。
		 */
		function classroomErrorText(t, error) {
			const code = error && typeof error.code === "string" ? error.code : "";
			if (code !== "") {
				const mapped = t("code." + code);
				if (typeof mapped === "string" && mapped !== "" && mapped !== "code." + code) return mapped;
			}
			if (error && typeof error.message === "string" && error.message !== "") return error.message;
			if (code !== "") return code;
			return String(error);
		}

		/** 课堂票就在 classroom/open 回执的 url 第一段：/teach-classroom/<token>/<encoded path>。 */
		function classroomTicketOf(view) {
			const url = view && view.value && typeof view.value.url === "string" ? view.value.url : "";
			const match = /^\/teach-classroom\/([^/]+)\//.exec(url);
			return match === null ? "" : match[1];
		}

		/** 结论是协议枚举（passed / needs_practice / needs_review）——界面只印给人看的词。 */
		const VERDICT_COPY = {
			passed: "verdict.passed",
			failed: "verdict.failed",
			needs_practice: "verdict.needsPractice",
			needs_review: "verdict.needsReview"
		};

		/** 需要动手的结论：未通过与需练习要显出来，通过与待复核只是记录。 */
		const isBadVerdict = (verdict) => verdict === "failed" || verdict === "needs_practice";

		/** 未知枚举原样显示：宁可让人读到英文码，也不要猜一个中文词。 */
		function verdictWord(t, verdict) {
			if (typeof verdict !== "string" || verdict === "") return "";
			const key = VERDICT_COPY[verdict];
			return key === undefined ? verdict : t(key);
		}

		/** 2026-10-30T12:00:00Z → 10-30。侧栏里没有读者需要秒，也没有空间放年。 */
		function shortDay(value) {
			const match = /^\d{4}-(\d{2})-(\d{2})/.exec(typeof value === "string" ? value : "");
			return match === null ? "" : match[1] + "-" + match[2];
		}

		/**
		 * 账目行拆两段：数字（次级灰）与结论词（墨色，给这一行一个锚）。缺的项不占位。
		 * answered === null 表示还没读到 status：那是「不知道」，不是「一题没答」。
		 */
		function ledgerParts(t, ledger) {
			const counts = [];
			if (typeof ledger.questions === "number") counts.push(fill(t("ledgerQuestions"), { count: ledger.questions }));
			if (typeof ledger.answered === "number" && ledger.answered > 0) counts.push(fill(t("ledgerAnswered"), { count: ledger.answered }));
			else if (typeof ledger.answered === "number" && typeof ledger.questions === "number" && ledger.questions > 0) counts.push(t("ledgerNoAnswer"));
			if (typeof ledger.pending === "number" && ledger.pending > 0) {
				// 「已答 4 · 待批改 2」会被读成 6：待批改本来就是已答里还没判的那部分。
				counts.push(fill(typeof ledger.answered === "number" ? t("ledgerPendingOf") : t("ledgerPending"), { count: ledger.pending }));
			}
			return { counts: counts, verdict: verdictWord(t, ledger.verdict) };
		}

		/** 纯文本形态：给标题属性、播报与测试用，与画面上的顺序一致。 */
		function ledgerLine(t, ledger) {
			const parts = ledgerParts(t, ledger);
			return [parts.counts.join(" · "), parts.verdict].filter((part) => part !== "").join(" · ");
		}

		/**
		 * 把 classroom/status 的回执折成账目行。只认仍有效的结论（effectiveVerdict），
		 * 按 verdictAt 取最新一条——与判卷出口同一口径，界面不自己算第二套。
		 */
		function ledgerOfStatus(value, previous) {
			const source = value !== null && typeof value === "object" ? value : {};
			const questions = Array.isArray(source.questions) ? source.questions.length : previous.questions;
			const submissions = Array.isArray(source.submissions) ? source.submissions : [];
			const answered = new Set();
			let latestVerdict = "";
			let latestAt = "";
			for (const submission of submissions) {
				if (submission === null || typeof submission !== "object") continue;
				if (typeof submission.questionId === "string") answered.add(submission.questionId);
				if (typeof submission.effectiveVerdict !== "string" || submission.effectiveVerdict === "") continue;
				const at = typeof submission.verdictAt === "string" ? submission.verdictAt : "";
				if (at >= latestAt) {
					latestAt = at;
					latestVerdict = submission.effectiveVerdict;
				}
			}
			const pending = typeof source.pendingCount === "number" ? source.pendingCount : Array.isArray(source.pending) ? source.pending.length : previous.pending;
			const answeredCount = typeof questions === "number" ? Math.min(answered.size, questions) : answered.size;
			return { questions: questions, answered: answeredCount, pending: pending, verdict: latestVerdict, assessedAt: latestAt };
		}

		/**
		 * 课堂 tab：把课程页放进 sandbox iframe，父 tab 只负责受控 RPC。
		 * 页面里的 bridge 不会直接写档案；submit 必须经过父 tab 的 classroom/submit。
		 */
		function ClassroomTab(props) {
			const { useTabInfo, t, sessionId, address, lesson, callRpc, openCourses } = props;
			const tab = useTabInfo();
			const fileAddress = tab.tab.navigation.address;
			const params = tab.tab.navigation.params;
			const lessonId = params !== null && typeof params === "object" && typeof params.lessonId === "string" ? params.lessonId : "";
			const [view, setView] = react.useState({ status: "loading" });
			// 提示带档位：失败要红、要立刻播报；成功只是安静的一句。
			const [notice, setNotice] = react.useState({ tone: "info", text: "" });
			// 刷新状态要换 iframe 的 key：整页重挂才会重新走 classroom/open，
			// 拿到新注入的题目清单与新 nonce（旧 iframe 里的 nonce 已经对不上了）。
			const [frameSeq, setFrameSeq] = react.useState(0);

			// 一次只做一件事：请求在飞时按钮禁用，双击不会发出两份。
			const [busy, setBusy] = react.useState(false);
			// 账目行：题量、已答、待批改、最近有效结论。常驻在顶部，不是「点刷新才闪一下」。
			const [ledger, setLedger] = react.useState({ questions: null, answered: null, pending: null, verdict: "", assessedAt: "" });
			// 失败/缺地址时的出路是再开一次；这条计数只用来重跑打开请求，不动 iframe key。
			const [reloadSeq, setReloadSeq] = react.useState(0);
            const [reading, setReading] = react.useState(null);
            const [readingPending, setReadingPending] = react.useState(false);
			const iframeRef = react.useRef(null);
			const headRef = react.useRef(null);
			const nonceRef = react.useRef("");
			const fileRef = react.useRef(null);
			const aliveRef = react.useRef(true);
            const pendingReading = react.useRef(null);
            const fixedClassroom = react.useRef(null);

			/** 卸载之后不再写状态：异步回调回来时组件可能已经没了。 */
			const say = (tone, text) => {
				if (aliveRef.current) setNotice({ tone: tone, text: text });
			};
			const clearNotice = () => {
				if (aliveRef.current) setNotice({ tone: "info", text: "" });
			};

			/**
			 * 顶栏覆盖在 iframe 上时，把顶栏高度作为课程页顶部空白下发。
			 * 课程页在 sandbox 里独立滚动，宿主不能直接给它加 padding；走现有的 nonce 桥，
			 * 让课程页在 body 最前面插一段透明空白，首屏内容就从顶栏下沿开始，下滑时再从模糊层下经过。
			 */
			const postTopInset = () => {
				const bar = headRef.current;
				const frame = iframeRef.current;
				if (bar === null || frame === null || !frame.contentWindow) return;
				const px = Math.ceil(bar.getBoundingClientRect().height);
				if (px <= 0) return;
				frame.contentWindow.postMessage({ source: "teach-host", type: "teach:top-inset", nonce: nonceRef.current, px: px }, "*");
			};

			/** 重试保存是阅读条上的常驻图标：没有待保存内容时禁用，不靠出现/消失来提示。 */
			const retryReading = () => {
				const frame = iframeRef.current;
				if (frame && frame.contentWindow) frame.contentWindow.postMessage({ source: "teach-host", type: "teach:retry-reading", nonce: nonceRef.current }, "*");
			};

			/** 失败或缺地址时再开一次：同一条 classroom/open，不另造入口（U06）。 */
			const reopen = () => {
				clearNotice();
				if (aliveRef.current) setView({ status: "loading" });
				setReloadSeq((seq) => seq + 1);
			};

			/** 读一次 status 只为了账目行：失败不打扰任何人，账目行退回「只有题量」。 */
			const syncLedger = (value) => {
				if (!aliveRef.current || value === null || typeof value !== "object") return Promise.resolve();
				return Promise.resolve(callRpc("classroom/status", { sessionId: sessionId, lessonId: value.lessonId }, { ticket: classroomTicketOf({ value: value }) }))
					.then((result) => {
						if (!aliveRef.current || !result || result.ok !== true) return;
						setLedger((previous) => ledgerOfStatus(result.value, previous));
					}, () => undefined);
			};

			react.useEffect(() => {
				let alive = true;
				setView({ status: "loading" });
				clearNotice();
				// 两条入口：按 lessonId（从课程列表点进来）或按文件地址（文件树/模型打开）。
				const request = lessonId === "" ? address(fileAddress) : lesson(lessonId, fixedClassroom.current?.collectionId ?? params?.collectionId, fixedClassroom.current?.contentVersion ?? params?.contentVersion);
				Promise.resolve(request).then((result) => {
					if (!alive) return;
					// 错误一律走码表：不拿服务端的中文句子做分支判断。
					if (!result || result.ok !== true) throw new Error(classroomErrorText(t, result && result.error));
					nonceRef.current = result.value.nonce || "";
                    fixedClassroom.current = result.value;
                    setReading(result.value.reading || null);
                    setReadingPending(false); pendingReading.current = null;
					setView({ status: "ready", value: result.value });
					// 题量在 open 回执里就有；已答/待批改/结论再用一次 status 补齐（失败就只留题量）。
					setLedger({ questions: Array.isArray(result.value.questions) ? result.value.questions.length : null, answered: null, pending: null, verdict: "", assessedAt: "" });
					syncLedger(result.value);
				}, (error) => {
					if (alive) setView({ status: "failed", message: classroomErrorText(t, error) });
				}).catch((error) => {
					if (alive) setView({ status: "failed", message: classroomErrorText(t, error) });
				});
				return () => { alive = false; };
			}, [fileAddress, lessonId, params?.collectionId, params?.contentVersion, reloadSeq]);

			react.useEffect(() => {
				if (view.status !== "ready") return undefined;
				const frame = iframeRef.current;
				if (frame === null) return undefined;
				const presence = () => {
                    if (frame.contentWindow) frame.contentWindow.postMessage({ source: "teach-host", type: "teach:visibility", nonce: nonceRef.current, active: document.visibilityState !== "hidden" && document.hasFocus() && frame.getClientRects().length > 0 }, "*");
                };
                const onMessage = (event) => {
					if (event.source !== frame.contentWindow) return;
					const data = event.data;
					if (data === null || typeof data !== "object" || data.source !== "teach-classroom") return;
					if (typeof data.nonce !== "string" || data.nonce !== nonceRef.current) return;
					if (data.type === "ready") { presence(); postTopInset(); return; }
                    if (data.type === "reading-preview" && data.lessonId === view.value.lessonId && data.revision === view.value.revision && Number.isFinite(data.ratio)) {
                        setReading((prior) => ({ ...prior, maxRatio: Math.max(prior?.maxRatio || 0, Math.min(1, Math.max(0, data.ratio))), position: data.position }));
                        return;
                    }
                    if (data.type === "reading" && data.lessonId === view.value.lessonId && data.revision === view.value.revision) {
                        pendingReading.current = data;
                        setReading((prior) => ({ ...prior, maxRatio: Math.max(prior?.maxRatio || 0, data.ratio), position: data.position }));
                        setReadingPending(true);
                        Promise.resolve(callRpc("classroom/reading", { sessionId, lessonId: view.value.lessonId, ratio: data.ratio, position: data.position, activeAt: data.activeAt, active: data.active, sequence: data.sequence }, { ticket: classroomTicketOf(view) })).then((result) => {
                            if (!result || !result.ok) throw new Error(classroomErrorText(t, result && result.error));
                            if (pendingReading.current === data) { setReading((prior) => ({ ...result.value, maxRatio: Math.max(prior?.maxRatio || 0, result.value?.maxRatio || 0) })); setReadingPending(false); pendingReading.current = null; }
                            window.dispatchEvent(new CustomEvent("teach-reading-changed", { detail: { sessionId } }));
                        }).catch(() => { setReadingPending(true); });
                        return;
                    }
					if (data.type !== "submit" && data.type !== "status") return;
					const endpoint = data.type === "submit" ? "classroom/submit" : "classroom/status";
					const payload = data.type === "submit"
						? { sessionId: sessionId, lessonId: view.value.lessonId, revision: view.value.revision, questionId: data.questionId, questionRevision: data.questionRevision, rawAnswer: data.rawAnswer, idempotencyKey: data.idempotencyKey, hintsUsed: data.hintsUsed, showedSolution: data.showedSolution }
						: { sessionId: sessionId, lessonId: view.value.lessonId };
					Promise.resolve(callRpc(endpoint, payload, { ticket: classroomTicketOf(view) })).then((result) => {
						if (!result || result.ok !== true) throw new Error(classroomErrorText(t, (result && result.error) || { code: "rpc-failed" }));
						if (frame.contentWindow) frame.contentWindow.postMessage({ source: "teach-host", type: "teach:result", nonce: data.nonce, requestId: data.requestId, value: result.value }, "*");
						if (data.type === "submit") {
							say("info", t("classroomSubmitted"));
							// 交完一题账目行要跟着变：再读一次 status，失败就静默。
							syncLedger(view.value);
						} else {
							setLedger((previous) => ledgerOfStatus(result.value, previous));
						}
					}).catch((error) => {
						if (frame.contentWindow) frame.contentWindow.postMessage({ source: "teach-host", type: "teach:error", nonce: data.nonce, requestId: data.requestId, error: { code: "rpc-failed", message: classroomErrorText(t, error) } }, "*");
						say("error", classroomErrorText(t, error));
					});
				};
				window.addEventListener("message", onMessage);
				const presenceTimer = typeof setInterval === "function" ? setInterval(presence, 1000) : null;
                return () => { window.removeEventListener("message", onMessage); if (presenceTimer !== null) clearInterval(presenceTimer); };
			}, [view.status, view.value, sessionId]);

			// 放在最后：上面两个 effect 的顺序是别处在依赖的（挂载顺序），这个只管卸载标志。
			react.useEffect(() => {
				aliveRef.current = true;
				return () => { aliveRef.current = false; };
			}, []);

			// 顶栏是覆盖层：测量它的真实高度，下发给课程页做顶部空白。
			// 账目异步出现、动作换行、事实核查展开都会改变高度，ResizeObserver 负责跟上。
			react.useEffect(() => {
				if (view.status !== "ready") return undefined;
				const bar = headRef.current;
				if (bar === null) return undefined;
				const send = () => postTopInset();
				send();
				const Observer = typeof ResizeObserver === "function" ? ResizeObserver : null;
				const observer = Observer === null ? null : new Observer(send);
				if (observer !== null) observer.observe(bar);
				const onResize = () => send();
				window.addEventListener("resize", onResize);
				return () => {
					if (observer !== null) observer.disconnect();
					window.removeEventListener("resize", onResize);
				};
			}, [view.status, view.value, ledger, notice]);

			const exportOffline = () => {
				if (busy) return;
				clearNotice();
				setBusy(true);
				Promise.resolve(callRpc("classroom/export", { sessionId: sessionId, lessonId: view.value.lessonId }, { ticket: classroomTicketOf(view) })).then((result) => {
					if (!result || result.ok !== true) throw new Error(classroomErrorText(t, (result && result.error) || { code: "export-failed" }));
					if (!aliveRef.current) return;
					const html = typeof result.value.html === "string" ? result.value.html : "";
					if (html === "") return;
					const blob = new Blob([html], { type: "text/html;charset=utf-8" });
					const url = URL.createObjectURL(blob);
					const link = document.createElement("a");
					link.href = url;
					link.download = typeof result.value.filename === "string" && result.value.filename !== "" ? result.value.filename : "lesson.html";
					document.body.appendChild(link);
					link.click();
					link.remove();
					setTimeout(() => URL.revokeObjectURL(url), 2000);
					say("info", t("classroomExported"));
				}).catch((error) => say("error", classroomErrorText(t, error))).then(() => {
					if (aliveRef.current) setBusy(false);
				});
			};

			/** 重新加载：重开课堂（拿新 nonce/题目清单并整页重挂）+ 读一次状态汇总。 */
			const reloadClassroom = () => {
				if (busy) return;
				clearNotice();
				setBusy(true);
				const lessonId = view.value.lessonId;
				const previousTicket = classroomTicketOf(view);
				const reopened = Promise.resolve(callRpc("classroom/open", { sessionId: sessionId, lessonId: lessonId, ...(view.value.collectionId ? { collectionId: view.value.collectionId } : {}), ...(view.value.contentVersion ? { contentVersion: view.value.contentVersion } : {}) })).then((result) => {
					if (!result || result.ok !== true) throw new Error(classroomErrorText(t, (result && result.error) || { code: "bad-request" }));
					if (!aliveRef.current) return result.value;
					nonceRef.current = result.value.nonce || "";
                    fixedClassroom.current = result.value;
                    setReading(result.value.reading || null);
					setView({ status: "ready", value: result.value });
					setFrameSeq((seq) => seq + 1);
					return result.value;
				});
				/** 状态回执只做一件事：把账目行更新到最新。 */
				const summarize = (result) => {
					if (!result || result.ok !== true) throw new Error(classroomErrorText(t, (result && result.error) || { code: "bad-request" }));
					if (aliveRef.current) setLedger((previous) => ledgerOfStatus(result.value, previous));
					return result;
				};
				const summarized = Promise.resolve(callRpc("classroom/status", { sessionId: sessionId, lessonId: lessonId }, { ticket: previousTicket })).then((result) => {
					if (result && result.ok === true) return result;
					// 重开可能换了 revision：旧票绑的版本过时（410）时，用重开回执里的新票再读一次。
					const code = result && result.error ? result.error.code : "";
					if (code === "lesson-revision-stale" || code === "ticket-expired") {
						return reopened.then((value) => callRpc("classroom/status", { sessionId: sessionId, lessonId: lessonId }, { ticket: classroomTicketOf({ value: value }) }));
					}
					return result;
				}).then(summarize);
				let failed = false;
				return Promise.all([reopened, summarized])
					.catch((error) => { failed = true; say("error", classroomErrorText(t, error)); })
					.then(() => {
						if (!aliveRef.current) return;
						setBusy(false);
						// 刷新成功后账目行已经变了，状态行只留一句「已刷新」。
						if (!failed) say("info", t("classroomReloaded"));
					});
			};

			const importProgress = (event) => {
				const file = event.target.files && event.target.files[0];
				event.target.value = "";
				if (!file || busy) return;
				clearNotice();
				if (typeof file.size === "number" && file.size > IMPORT_MAX_BYTES) {
					say("error", fill(t("importTooLarge"), { size: Math.round(IMPORT_MAX_BYTES / (1024 * 1024)) }));
					return;
				}
				setBusy(true);
				file.text().then((text) => {
					let data;
					try {
						data = JSON.parse(text);
					} catch {
						say("error", t("importNotJson"));
						return;
					}
					// 形状与版本先自己判一次：明显不对的文件不必去打扰课堂接口。
					if (data === null || typeof data !== "object" || Array.isArray(data)) {
						say("error", t("importNotObject"));
						return;
					}
					if (data.version !== 1) {
						say("error", t("importVersionText"));
						return;
					}
					return Promise.resolve(callRpc("classroom/import", { sessionId: sessionId, lessonId: view.value.lessonId, data: data }, { ticket: classroomTicketOf(view) })).then((result) => {
						if (!result || result.ok !== true) throw new Error(classroomErrorText(t, (result && result.error) || { code: "bad-request" }));
						const value = result.value || {};
						say("info", fill(t("importResult"), { imported: value.imported, skipped: value.skipped }));
					});
				}).catch((error) => {
					say("error", classroomErrorText(t, error));
				}).then(() => {
					if (aliveRef.current) setBusy(false);
				});
			};

			if (view.status === "loading") {
				// 载入不是一句话：和选课那边同一套骨架行，数据落下时版面不跳。
				return react.createElement("div", { className: "tsm-surface tsm-pane", role: "status" }, [
					react.createElement("style", { key: "style", dangerouslySetInnerHTML: { __html: SURFACE_CSS } }),
					react.createElement("div", { key: "skeleton-head", className: "tsm-skeleton", "aria-hidden": "true" }, [
						react.createElement("span", { key: "title", className: "tsm-bone tsm-bone--title" }),
						react.createElement("span", { key: "meta", className: "tsm-bone tsm-bone--meta" })
					]),
					react.createElement("span", { key: "state", className: "tsm-sr" }, t("classroomLoading"))
				]);
			}
			/** 失败与缺地址共用一条头部：先给离开的路（‹ 选课），再讲这一块发生了什么。 */
			const stateHead = () => react.createElement("div", { key: "nav", className: "tsm-classhead" }, [
				react.createElement("div", { key: "row", className: "tsm-backrow" }, [
					react.createElement("button", {
						key: "pick",
						type: "button",
						className: "tsm-back",
						"aria-label": t("coursesPick"),
						onClick: () => { if (openCourses() === false) say("error", t("coursesPickFailed")); }
					}, t("classroomBack"))
				])
			]);
			if (view.status === "failed") {
				// 失败态是一次完整回答：发生了什么、下一步做什么、退路在哪（U06）。
				// 一个活区：容器不带 role，内层那块 role=alert 负责播报。
				return react.createElement("div", { className: "tsm-surface tsm-pane" }, [
					react.createElement("style", { key: "style", dangerouslySetInnerHTML: { __html: SURFACE_CSS } }),
					stateHead(),
					react.createElement("div", { key: "state", className: "tsm-empty" }, [
						react.createElement("div", { key: "alert", role: "alert", className: "tsm-emptytext" }, [
							react.createElement("b", { key: "why" }, t("classroomFailed")),
							react.createElement("span", { key: "why-text" }, view.message),
							react.createElement("span", { key: "next" }, t("classroomFailedNext"))
						]),
						react.createElement("button", { key: "reopen", type: "button", className: "tsm-btn", onClick: reopen }, t("classroomOpenAgain")),
						notice.text === "" ? null : react.createElement("p", { key: "notice", className: "tsm-hint--error" }, notice.text)
					])
				]);
			}
			// 就绪却没给出地址（或回执根本不是对象）：别把 iframe 指向空串装成正常页面。
			if (view.value === null || typeof view.value !== "object" || typeof view.value.url !== "string" || view.value.url === "") {
				return react.createElement("div", { className: "tsm-surface tsm-pane" }, [
					react.createElement("style", { key: "style", dangerouslySetInnerHTML: { __html: SURFACE_CSS } }),
					stateHead(),
					react.createElement("div", { key: "state", className: "tsm-empty" }, [
						react.createElement("div", { key: "alert", role: "alert", className: "tsm-emptytext" }, [
							react.createElement("b", { key: "why" }, t("classroomNoUrl"))
						]),
						react.createElement("button", { key: "reopen", type: "button", className: "tsm-btn", onClick: reopen }, t("classroomOpenAgain"))
					])
				]);
			}
			const name = view.value.title || t("classroomTab");
			const ledgerWords = ledgerParts(t, ledger);
			const ledgerCounts = ledgerWords.counts.join(" · ");
			const ledgerText = ledgerLine(t, ledger);
			// 阅读条上的常驻重试：没有待保存内容时置灰，但位置一直在，页面不会因为它出现/消失而跳动。
			const RefreshIcon = primitives.IconRefreshOutlineRegular;
			const DownloadIcon = primitives.IconDownloadOutlineRegular;
			const readingAction = react.createElement("button", {
				key: "reading-retry",
				type: "button",
				className: "tsm-readingretry",
				"data-reading-retry": "true",
				"data-pending": readingPending ? "true" : "false",
				"aria-label": t("readingRetry"),
				title: t("readingRetry"),
				disabled: !readingPending,
				onClick: retryReading
			}, RefreshIcon ? react.createElement(RefreshIcon, { size: 14, "aria-hidden": true }) : react.createElement("span", { className: "tsm-readingretryglyph", "aria-hidden": true }, "↻"));

			// 三个动作收进标题行右侧：图标按钮 + tooltip/aria-label，不再单独占一行。
			const actionIcon = (Component, glyph) => Component
				? react.createElement(Component, { size: 16, "aria-hidden": true })
				: react.createElement("span", { className: "tsm-classactionglyph", "aria-hidden": true }, glyph);
			const classAction = (key, label, Component, glyph, onClick, extraClass) => react.createElement("button", {
				key: key,
				type: "button",
				className: "tsm-classaction" + (extraClass ? " " + extraClass : ""),
				"aria-label": label,
				title: label,
				disabled: busy,
				onClick: onClick
			}, actionIcon(Component, glyph));
			const actions = react.createElement("div", { key: "actions", className: "tsm-classactions" }, [
				classAction("reload", t("classroomRefresh"), RefreshIcon, "↻", reloadClassroom),
				classAction("export", t("classroomExport"), DownloadIcon, "↓", exportOffline),
				classAction("import", t("classroomImport"), DownloadIcon, "↑", () => { if (fileRef.current) fileRef.current.click(); }, "tsm-classaction--import"),
				react.createElement("input", { key: "file", ref: fileRef, type: "file", accept: "application/json,.json", style: { display: "none" }, onChange: importProgress })
			]);

			// 账目收进阅读条左侧，只占一行；完整文本留在 title，长内容省略。
			const ledgerInline = ledgerText === "" ? null : react.createElement("span", { key: "ledger", className: "tsm-ledger tsm-ledger--inline", title: ledgerText }, [
				ledgerCounts === "" ? null : react.createElement("span", { key: "counts" }, ledgerCounts),
				ledgerCounts !== "" && ledgerWords.verdict !== "" ? react.createElement("span", { key: "sep", className: "tsm-ledgersep" }, " · ") : null,
				ledgerWords.verdict === "" ? null : react.createElement("span", { key: "assessment", className: "tsm-ledgerassessment" }, [
					t("ledgerAssessment"),
					react.createElement("span", { key: "word", className: isBadVerdict(ledger.verdict) ? "tsm-verdict tsm-verdict--bad" : "tsm-verdict" }, ledgerWords.verdict),
					shortDay(ledger.assessedAt) === "" ? null : react.createElement("span", { key: "day", className: "tsm-history" }, " · " + shortDay(ledger.assessedAt))
				])
			]);

			// 整个头部是一层覆盖在 iframe 上的模糊顶栏；课程页内部的滚动内容从它下面经过。
			const classbar = react.createElement("div", { key: "bar", ref: headRef, className: "tsm-classbar" }, [
				// 标题行：返回 + 课程名 + 动作图标；账目和阅读进度合成下一行。
				react.createElement("div", { key: "head", className: "tsm-classhead" }, [
					react.createElement("div", { key: "nav", className: "tsm-backrow tsm-backrow--title" }, [
						// 可见文本带「‹」，读屏只念词：名字给 aria-label，箭头留给眼睛。
						react.createElement("button", {
							key: "pick",
							type: "button",
							className: "tsm-back",
							"aria-label": t("coursesPick"),
							onClick: () => { if (openCourses() === false) say("error", t("coursesPickFailed")); }
						}, t("classroomBack")),
						react.createElement("h3", { key: "title", className: "tsm-lessonname", title: name }, name),
						actions
					])
				]),
				react.createElement(ReadingBar, { key: "reading", t, reading, pending: readingPending, action: readingAction, leading: ledgerInline }),
				view.value.factCheck ? react.createElement(FactCheckDetails, { key: "fact-check", t, report: view.value.factCheck }) : null,
				// 状态行：常量高度占位，不跳高；成功次要色、失败错误色。
				react.createElement("p", { key: "notice", className: notice.tone === "error" ? "tsm-noticeline tsm-noticeline--error" : "tsm-noticeline" }, notice.text),
				// 给读屏的两行：成功走 polite、失败走 assertive；任何时刻只有一行有字，不会重复播报。
				react.createElement("span", { key: "live-polite", role: "status", "aria-live": "polite", className: "tsm-sr" }, notice.tone === "error" ? "" : notice.text),
				react.createElement("span", { key: "live-alert", role: "alert", "aria-live": "assertive", className: "tsm-sr" }, notice.tone === "error" ? notice.text : ""),
				react.createElement("hr", { key: "rule", className: "tsm-rule" })
			]);

			return react.createElement("div", { className: "tsm-surface tsm-pane tsm-pane--classroom", "data-tsm-mask": officialMaskBlur() ? "on" : "off" }, [
				react.createElement("style", { key: "style", dangerouslySetInnerHTML: { __html: SURFACE_CSS } }),
				classbar,
				react.createElement("iframe", {
					key: "frame-" + frameSeq,
					ref: iframeRef,
					src: view.value.url,
					title: view.value.title || t("classroomTab"),
					sandbox: "allow-scripts",
					className: "tsm-frame",
					onLoad: postTopInset
				})
			]);
		}

				function ClassroomTitle({ useTabInfo, t }) {
			const tab = useTabInfo();
			return react.createElement(MarkedTitle, { label: tab.tab.title || t("classroomTab") });
		}
		//region 课程列表（选课入口）
		const COURSES_ID = "dsh-teach-me/courses";
		const COURSES_KIND = "teach-courses";

		/**
		 * 课程列表：侧栏里的选课入口。
		 * 数据只来自 /teach 的 classroom/catalog（本地档案，不联网），点「打开」按 lessonId
		 * 另开一个课堂 tab —— 不走文件地址认领，所以不会占用官方的 HTML 预览。
		 */
		function CoursesTab(props) {
			const { t, sessionId, callRpc, openLessonById } = props;
			const [view, setView] = react.useState({ status: "loading" });
			// 同课堂面：提示带档位，失败要能一眼看成失败。
			const [notice, setNotice] = react.useState({ tone: "info", text: "" });
			const [tick, setTick] = react.useState(0);
			const say = (tone, text) => setNotice({ tone: tone, text: text });
			const clearNotice = () => setNotice({ tone: "info", text: "" });
			react.useEffect(() => {
				let alive = true;
				// 刷新不把已经画出来的列表清掉：有数据就留着，失败只在提示行说一句（U06）。
				setView((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
				const fail = (error) => {
					if (!alive) return;
					say("error", classroomErrorText(t, error));
					setView((previous) => (previous.status === "ready" ? previous : { status: "failed", message: classroomErrorText(t, error) }));
				};
				Promise.resolve(callRpc("classroom/catalog", { sessionId: sessionId })).then((result) => {
					if (!alive) return;
					if (!result || result.ok !== true) throw new Error(classroomErrorText(t, (result && result.error) || { code: "bad-request" }));
					setView({ status: "ready", value: result.value });
				}, fail).catch(fail);
				return () => { alive = false; };
			}, [sessionId, tick]);
            react.useEffect(() => {
              const changed = (event) => { if (event.detail.sessionId === sessionId) setTick((n) => n + 1); };
              window.addEventListener("teach-preferences-changed", changed);
              window.addEventListener("teach-reading-changed", changed);
              return () => { window.removeEventListener("teach-preferences-changed", changed); window.removeEventListener("teach-reading-changed", changed); };
            }, [sessionId]);

			/**
			 * 打开一节课。openLessonById 在页签没挂上时返回 false（宿主侧不抛），
			 * 这里必须把 false 变成一句话——否则点「打开」就是一次静默失败。
			 */
			const open = (lesson) => {
				clearNotice();
				let opened = false;
				try {
					opened = openLessonById(lesson.id, view.value.collectionId, lesson.contentVersion) !== false;
				} catch {
					opened = false;
				}
				if (!opened) say("error", t("coursesOpenFailed"));
			};

			// 顶部条：宿主页签已经写着「教学模式 · 选课」，这里只放数量与刷新这两个真信息。
			const lessonCount = view.status === "ready" && view.value && Array.isArray(view.value.lessons) ? view.value.lessons.length : null;
			const head = react.createElement("div", { key: "bar", className: "tsm-toolbar" }, [
				react.createElement("span", { key: "count", className: "tsm-count" }, lessonCount === null ? "" : fill(t("coursesCount"), { count: lessonCount })),
				react.createElement("button", {
					key: "refresh",
					type: "button",
					className: "tsm-quiet",
					onClick: () => {
						clearNotice();
						setTick(tick + 1);
					}
				}, t("coursesRefresh"))
			]);

			// 顶部条是唯一吸顶层：集合选择固定在它上方，课程列表在下面的滚动区里经过它。
			const shell = (parts, live) => react.createElement("div", { className: "tsm-surface tsm-pane tsm-pane--courses", "data-tsm-mask": officialMaskBlur() ? "on" : "off" }, [
				react.createElement("style", { key: "style", dangerouslySetInnerHTML: { __html: SURFACE_CSS } }),
				react.createElement(CollectionControls, { key: "collections", t, sessionId, callRpc, value: view.value || {}, onChanged: () => setTick((n) => n + 1) }),
				react.createElement("div", { key: "scroll", className: "tsm-scroll" }, parts),
				...(live || [])
			]);

			// 提示紧贴动作行：谁点的、结果是什么，都在同一块里，不用去列表底部找。
			const noticeLine = react.createElement("p", { key: "notice", className: notice.tone === "error" ? "tsm-noticeline tsm-noticeline--error" : "tsm-noticeline" }, notice.text);
			const topbar = react.createElement("div", { key: "topbar", className: "tsm-topbar" }, [head, noticeLine]);
			const livePolite = react.createElement("span", { key: "live-polite", role: "status", "aria-live": "polite", className: "tsm-sr" }, notice.tone === "error" ? "" : notice.text);
			const liveAlert = react.createElement("span", { key: "live-alert", role: "alert", "aria-live": "assertive", className: "tsm-sr" }, notice.tone === "error" ? notice.text : "");
			// 载入用真实行高的骨架条：数据落下时列表不跳高，也不用一句「正在读」占位。
			const skeletonRows = [0, 1, 2].map((index) => react.createElement("div", { key: "skeleton-" + index, className: "tsm-skeleton", "aria-hidden": "true" }, [
				react.createElement("span", { key: "title", className: "tsm-bone tsm-bone--title" }),
				react.createElement("span", { key: "meta", className: "tsm-bone tsm-bone--meta" })
			]));

			if (view.status === "loading") {
				return shell([
					topbar,
					react.createElement("div", { key: "list", className: "tsm-list" }, skeletonRows),
					react.createElement("span", { key: "loading", role: "status", className: "tsm-sr" }, t("coursesLoading"))
				]);
			}
			if (view.status === "failed") {
				// 失败态自带动作：重试就在这句话下面，不用回顶部找刷新。
				// 顶部条与列表线都保留，换状态时版面不跳（对照空态）；assertive 只包文字，不包按钮。
				return shell([
					topbar,
					react.createElement("div", { key: "list", className: "tsm-list" }, react.createElement("div", { key: "state", className: "tsm-empty" }, [
						react.createElement("div", { key: "alert", role: "alert", className: "tsm-emptytext" }, [
							react.createElement("b", { key: "why" }, t("coursesFailed")),
							react.createElement("span", { key: "text" }, view.message)
						]),
						react.createElement("button", {
							key: "retry",
							type: "button",
							className: "tsm-btn",
							onClick: () => {
								clearNotice();
								setTick(tick + 1);
							}
						}, t("coursesRetry"))
					]))
				]);
			}

			const lessons = Array.isArray(view.value && view.value.lessons) ? view.value.lessons : [];
			if (lessons.length === 0) {
				// 空态要说清「发生了什么」和「下一步在哪」：标题一句，下面一句，不用内部工具名（U06）。
				const archived = view.value !== null && typeof view.value === "object" && view.value.initialized === true;
				return shell([
					topbar,
					react.createElement("div", { key: "list", className: "tsm-list" }, react.createElement("div", {
						key: "empty",
						className: "tsm-empty",
						role: "status"
					}, [
						react.createElement("b", { key: "title" }, archived ? t("coursesEmptyTitle") : t("coursesNoArchiveTitle")),
						react.createElement("span", { key: "next" }, archived ? t("coursesEmpty") : t("coursesNoArchive"))
					]))
				]);
			}

			const rows = lessons.map((lesson, index) => {
				const title = typeof lesson.title === "string" && lesson.title !== "" ? lesson.title : String(lesson.id);
				const count = typeof lesson.questionCount === "number" ? lesson.questionCount : null;
				const shapes = count === null ? "" : fill(t("ledgerQuestions"), { count: count });
				// 两处题号对不上要分开说，方向不能反：missingPageIds 是「页面写了、档案里没登记」，
				// unmappedQuestionIds 是「档案里有、页面没排」（10.2）。读行的是学习者不是工程师：
				// 行里只说「几题不对」，具体题号放进 title，等悬停或读屏放大再看。
				const unregistered = Array.isArray(lesson.missingPageIds) ? lesson.missingPageIds.filter((id) => typeof id === "string" && id !== "") : [];
				const unshown = Array.isArray(lesson.unmappedQuestionIds) ? lesson.unmappedQuestionIds.filter((id) => typeof id === "string" && id !== "") : [];
				const gapParts = [];
				if (unregistered.length > 0) gapParts.push(fill(t("coursesGapUnregistered"), { count: unregistered.length }));
				if (unshown.length > 0) gapParts.push(fill(t("coursesUnshown"), { count: unshown.length }));
				const hasGap = gapParts.length > 0;
				const metaId = "teach-me-lesson-" + String(index) + "-meta";
				const gapId = metaId + "-gap";
				// 结论是协议枚举，先翻成词。失效不是「再加一枚红章」，而是这条结论不能再信：
				// 主线换成「评估已过期」，历史结论降成灰字，一行只留一个要看的词（V06）。
				const verdict = verdictWord(t, lesson.lastVerdict);
				const stale = lesson.lastVerdictStale === true;
				const submittedDay = shortDay(lesson.lastSubmittedAt);
				const verdictDay = shortDay(lesson.lastVerdictAt);
				const reason = stale && typeof lesson.lastVerdictStaleReason === "string" && lesson.lastVerdictStaleReason !== ""
					? fill(t("staleReasonWrap"), { reason: lesson.lastVerdictStaleReason })
					: "";
				const metaParts = [];
				if (stale) {
					metaParts.push(react.createElement("span", { key: "stale", className: "tsm-stale" }, t("coursesVerdictStale")));
					if (verdict !== "") metaParts.push(react.createElement("span", { key: "verdict", className: "tsm-history" }, fill(t("coursesVerdictHistory"), { word: verdict })));
				} else if (verdict !== "") {
					metaParts.push(react.createElement("span", { key: "verdict", className: isBadVerdict(lesson.lastVerdict) ? "tsm-verdict tsm-verdict--bad" : "tsm-verdict" }, verdict));
				} else if (count === 0 && !hasGap) {
					// 0 题就说 0 题：说「尚未作答」会让人去找一道不存在的题（U01）。
					metaParts.push(react.createElement("span", { key: "state", className: "tsm-history" }, t("coursesQuestionless")));
				} else if (count === 0) {
					// 档案里 0 题、页面却写了题：这一行的状态就是下面那行不一致，别再说「本课没有练习题」。
				} else if (submittedDay !== "") {
					// 已提交、还没评估是支持的状态，不能写成「尚未作答」（U01）。
					metaParts.push(react.createElement("span", { key: "state", className: "tsm-history" }, t("coursesSubmittedNoVerdict")));
				} else {
					metaParts.push(react.createElement("span", { key: "state", className: "tsm-history" }, t("coursesNotSubmitted")));
				}
				// 日期只印一种，且说清是哪种：作答时间优先，没有作答才退回评估时间。
				if (submittedDay !== "") metaParts.push(react.createElement("span", { key: "day", className: "tsm-history" }, fill(t("coursesAnsweredOn"), { day: submittedDay })));
				else if (verdictDay !== "") metaParts.push(react.createElement("span", { key: "day", className: "tsm-history" }, fill(t("coursesVerdictAt"), { day: verdictDay })));
				// 原因最后：折行时它落到第二行，日期和状态词留在第一行
				if (reason !== "") metaParts.push(react.createElement("span", { key: "reason", className: "tsm-history" }, reason));
				// 可访问名点出动作与课程，元信息改走 describedby——否则读屏会听到一整行字。
				const label = count === null ? t("coursesOpen") + " " + title : fill(t("coursesOpenName"), { title: title, count: count });
				const gapLine = hasGap
					? react.createElement("span", {
						key: "gap",
						id: gapId,
						className: "tsm-gap",
						title: unregistered.concat(unshown).join(t("listSep"))
					}, gapParts.join(" · "))
					: null;
				// 整行就是一个按钮：键盘一次 Tab 到一课，回车即开。入口提示常驻在行尾，
				// 题量也不再随悬停消失（U04）。不一致那行进 describedby：aria-label 会盖住子树，
				// 不挂上去读屏就完全听不到它是缺题的。
				return react.createElement("button", {
					key: String(lesson.id),
					type: "button",
					className: "tsm-lesson",
					title: title,
					"aria-label": label,
					"aria-describedby": hasGap ? metaId + " " + gapId : metaId,
					onClick: () => open(lesson)
				}, [
					react.createElement("span", { key: "line1", className: "tsm-lessonline" }, [
						react.createElement("span", { key: "title", className: "tsm-lessontitle" }, title),
						shapes === "" ? null : react.createElement("span", { key: "figure", className: "tsm-figure" }, shapes),
						react.createElement("span", { key: "caret", className: "tsm-caret", "aria-hidden": "true" }, "›")
					]),
					react.createElement("span", { key: "line2", id: metaId, className: "tsm-lessonmeta" }, metaParts),
					react.createElement(ReadingBar, { key: "reading", t, reading: lesson.reading }),
					gapLine
				]);
			});

			return shell([
				topbar,
				react.createElement("div", { key: "list", className: "tsm-list" }, rows.map((row, index) => !(lessons[index].versions || []).length ? row : react.createElement("div", { key: lessons[index].id }, [row, (lessons[index].versions || []).length > 1 ? react.createElement("details", { key: "versions", className: "tsm-version" }, [react.createElement("summary", { key: "summary" }, t("versionHistory")), ...(lessons[index].versions || []).map((v) => react.createElement("button", { key: v.contentVersion, className: "tsm-quiet", type: "button", onClick: () => openLessonById(lessons[index].id, view.value.collectionId, v.contentVersion) }, t("openVersion") + " · " + v.contentVersion.slice(0, 8)))]) : null])))
			], [livePolite, liveAlert]);
		}

		function CoursesTitle({ useTabInfo, t }) {
			const tab = useTabInfo();
			return react.createElement(MarkedTitle, { label: tab.tab.title || t("coursesTab") });
		}
		//endregion

		const ENTRY = "teach-settings";
		const NS = "settings.teachMe";

		/** 需要的浏览器服务：插槽、文案、设置表单与侧栏 tab。 */
		// 不再依赖 connection：课堂回传走自己的前缀路由（见 callRpc），侧栏只需 slots/locale/tab 注册表。
		const inject = ["slots", "locale", "configForms", "sidebarRightTabs", "sidebarRight"];

		/**
		 * 注册「设置 → 教学模式」这一页。只有宿主的 `teach-settings` 行在服务里出现时才挂，
		 * 这样没装插件（或行没加载）的部署看不到空页面。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "teach-me: settings copy");
			const form = ctx.configForms.get(ENTRY);
			const face = () => ({
				hooks: { config: form },
				write: (path, value) => form.mutate([{ op: "set", path, value }])
			});
			ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => {
				const section = ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "teach-me",
					order: 60,
					label: () => ctx.locale.bind(NS)("nav"),
					locale: NS,
					inject: face
				}, TeachSettingsSection));
				// 官方图标槽：注册 id 必须与设置页 id 一致，否则宿主不渲染。
				// 老宿主不声明这个槽时 inject 不会回调，等于自动跳过。
				const icon = ctx.slots.inject("settings.section.icon", () => ctx.slots.register({
					name: "settings.section.icon",
					id: "teach-me",
					locale: NS
				}, TeachSettingsIcon));
				// 首次安装的欢迎页：挂到宿主的 root 级浮层槽上，位置与页面无关（不绑会话）。
				// 它自己读同一个 configForms 快照判断要不要出现；宿主不声明 shell.overlay 时
				// inject 不会回调，等于自动跳过（老宿主上就是没有欢迎页，别的都不受影响）。
				const welcome = ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "teach-me-welcome",
					locale: NS,
					inject: face
				}, TeachWelcome));
				return () => {
					welcome();
					icon();
					section();
				};
			}), "teach-me: settings section");

			// 侧栏两个 tab：teach-courses 是选课入口（page type，不带 patterns，只按 kind 打开），
			// teach-classroom 才是课程页本体。打开方式有两条：
			//   1) 列表页点「打开」→ openTab(CLASSROOM_KIND, { params: { lessonId } })；
			//   2) 文件树/模型打开已发布课程页 → 地址认领。
			// 认领只认 session 作用域（dsh-resource://file/session/**）。这个 pattern 比
			// better-sidebar 的 dsh-resource://file/** 更长，按宿主的排序规则（band → pattern 长度
			// → 注册顺序）稳定胜出，不再依赖插件加载顺序；absolute 作用域与非 lessons 路径照旧
			// 落到官方预览，不占位。
			// 课堂回传走我们自己的前缀路由（POST /teach-classroom/rpc/<endpoint>）：课程资源与接口
			// 共用一条路由，鉴权由宿主的 Host/Origin + 登录态围栏负责。不再用 connection.rpc 的
			// 自建通道 —— 那个在本宿主版本里注册不出 HTTP 路由，POST 会落到静态处理器返回 405。
			// 课堂票只走请求头 X-Teach-Classroom（服务端不接受 body 里的 sessionId 当身份依据）。
			// 引导端点（classroom/open、classroom/catalog）还没有票可带；其余调用由调用方传入。
			const callRpc = (endpoint, payload, options) => {
				// 绑当前语言取绑定时刻的文案表：错误提示要跟着宿主语言走，不能写死中文。
				const tr = ctx.locale.bind(CLASSROOM_NS);
				const path = "/teach-classroom/rpc/" + String(endpoint).split("/").map(encodeURIComponent).join("/");
				const headers = { "content-type": "application/json" };
				const ticket = options && typeof options.ticket === "string" ? options.ticket : "";
				if (ticket !== "") headers["x-teach-classroom"] = ticket;
				const init = {
					method: "POST",
					credentials: "same-origin",
					headers: headers,
					body: JSON.stringify({ payload: payload || {} })
				};
				// 超时靠 AbortController；没有它的环境退回「等宿主自己回话」，不假装有超时。
				const controller = typeof AbortController === "function" ? new AbortController() : null;
				const timer = controller !== null && typeof setTimeout === "function"
					? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
					: null;
				if (controller !== null) init.signal = controller.signal;
				const settle = () => { if (timer !== null) clearTimeout(timer); };
				const request = fetch(path, init).then((response) => {
					return response.json().then((body) => {
						if (body && typeof body === "object" && typeof body.ok === "boolean") return body;
						return { ok: false, error: { code: "bad-response", message: fill(tr("badResponse"), { status: response.status }) } };
					}, () => ({
						ok: false,
						error: { code: "transport", message: fill(tr("netUnreachable"), { status: response.status }) }
					}));
				}, (error) => {
					if (error && error.name === "AbortError") {
						return { ok: false, error: { code: "request-timeout", message: tr("requestTimeout") } };
					}
					return {
						ok: false,
						error: { code: "transport", message: fill(tr("netFailed"), { message: error && error.message ? error.message : String(error) }) }
					};
				});
				return request.then((result) => { settle(); return result; }, (error) => { settle(); throw error; });
			};
			ctx.effect(() => ctx.locale.register(CLASSROOM_NS, { zh, en }), "teach-me: classroom copy");

            ctx.effect(() => ctx.slots.inject("conversation.hero.options", () => ctx.slots.register({
                name: "conversation.hero.options", id: "teach-settings", order: 10, locale: CLASSROOM_NS,
                inject: (sessionId) => ({ sessionId, callRpc })
            }, TeachingDock)), "teach-me: conversation teaching settings")
            ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
                name: "conversation.session.header.actions", id: "teach-settings", order: -9, locale: CLASSROOM_NS,
                inject: (sessionId) => ({ sessionId, callRpc, placement: "active" })
            }, TeachingDock)), "teach-me: active teaching settings");

			/** 打开某节课：tab 列不在了就退回一句话，不让点击变成静默失败。 */
			const openCourse = (lessonId, collectionId, contentVersion) => {
				try {
					ctx.sidebarRight.openTab(CLASSROOM_KIND, { params: { lessonId: lessonId, ...(collectionId ? { collectionId } : {}), ...(contentVersion ? { contentVersion } : {}) } });
					return true;
				} catch {
					return false;
				}
			};
			const openCourses = () => {
				try {
					ctx.sidebarRight.openTab(COURSES_KIND);
					return true;
				} catch {
					return false;
				}
			};

			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: COURSES_ID,
				kind: COURSES_KIND,
				priority: "extension",
				keepMounted: true,
				title: () => ctx.locale.bind(CLASSROOM_NS)("coursesTab"),
				guide: [{
					id: "teach-courses",
					order: 60,
					title: () => ctx.locale.bind(CLASSROOM_NS)("coursesTab"),
					description: () => ctx.locale.bind(CLASSROOM_NS)("coursesIntro"),
					icon: TeachGuideIcon
				}]
			}), "teach-me: courses tab type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: COURSES_ID,
				locale: CLASSROOM_NS,
				inject: (sessionId) => ({
					sessionId,
					callRpc,
					openLessonById: openCourse
				})
			}, CoursesTab)), "teach-me: courses body");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
				name: "sidebar.right.pane.tab.title",
				key: COURSES_ID,
				locale: CLASSROOM_NS
			}, CoursesTitle)), "teach-me: courses title");

			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: CLASSROOM_KIND,
				patterns: ["dsh-resource://file/session/**"],
				priority: "extension",
				keepMounted: true,
				canOpen: isLessonAddress,
				title: () => ctx.locale.bind(CLASSROOM_NS)("classroomTab")
			}), "teach-me: classroom tab type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
				locale: CLASSROOM_NS,
				inject: (sessionId) => ({
					sessionId,
					address: (address) => callRpc("classroom/open", { sessionId, address }),
					lesson: (lessonId, collectionId, contentVersion) => callRpc("classroom/open", { sessionId, lessonId, collectionId, contentVersion }),
					callRpc,
					openCourses
				})
			}, ClassroomTab)), "teach-me: classroom body");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
				name: "sidebar.right.pane.tab.title",
				key: TAB_ID,
				locale: CLASSROOM_NS
			}, ClassroomTitle)), "teach-me: classroom title");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.TeachSettingsSection = TeachSettingsSection;
        exports.TeachingDock = TeachingDock;
        exports.TeachingDockBody = TeachingDockBody;
        exports.CollectionControls = CollectionControls;
        exports.HostSelect = HostSelect;
		exports.settingsLimits = { minSeconds: LIMIT_MIN, maxSeconds: LIMIT_MAX, parse: parseLimitInput };
		// 给测试用的内部件：文案表要与代码里的 t("...") 一一对上，错误码表要能单独验。
		exports.brandMark = TeachMark;
		exports.copy = { zh: zh, en: en };
		exports.classroomHelpers = { fill: fill, errorText: classroomErrorText };
		// 欢迎页：正文单独导出给 bench 渲染；判定与兜底标记导出给单测钉真值表。
		exports.TeachWelcome = TeachWelcome;
		exports.TeachWelcomeBody = TeachWelcomeBody;
		exports.welcomeHelpers = {
			decide: decideWelcome,
			markKey: WELCOME_MARK_KEY,
			readMark: readWelcomeMark,
			writeMark: writeWelcomeMark,
			clearMark: clearWelcomeMark
		};
		return module.exports;
	}
});
