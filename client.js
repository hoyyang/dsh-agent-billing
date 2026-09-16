window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-agent-billing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/index.ts
		/**
		* React 桥接壳：slot 宿主是 React 树，这里用组件挂载 vanilla DOM 节点，
		* 内部实现保持零依赖 DOM 操作（挂载一次，卸载时清理监听）。
		*/
		function VanillaSlot(props) {
			const ref = react.default.useRef(null);
			react.default.useEffect(() => {
				const host = ref.current;
				if (!host) return;
				const node = props.build();
				host.appendChild(node);
				try {
					node.__dabMount?.();
				} catch {}
				const dispose = node.__dabDispose;
				return () => {
					try {
						dispose?.();
					} catch {}
					node.remove();
				};
			}, []);
			return react.default.createElement("div", {
				ref,
				style: { display: "contents" }
			});
		}
		const inject = ["slots"];
		const NS = "dsh-agent-billing";
		const API = "/dsh-agent-billing";
		const TOGGLE_EVENT = "dsh-agent-billing:toggle";
		let statusData = null;
		let overlayOpen = false;
		let activeTab = "overview";
		let activeWindow = "today";
		let settingsSubTab = "models";
		let catalogData = null;
		let catalogLoading = false;
		let catalogFailed = false;
		let selectedModelKey = null;
		let modelSearch = "";
		let rulesData = [];
		let profilesData = [];
		let editingProfileId = null;
		let toastTimer = null;
		const badgeEls = /* @__PURE__ */ new Set();
		const overlayEls = /* @__PURE__ */ new Set();
		let pollTimer = null;
		let perSession = null;
		let currentRefreshMs = 1e3;
		function el(tag, attrs = {}, ...children) {
			const node = document.createElement(tag);
			for (const [k, v] of Object.entries(attrs)) {
				if (v === void 0 || v === null) continue;
				if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
				else if (k === "class") node.className = v;
				else node.setAttribute(k, v);
			}
			for (const c of children) {
				if (c === null || c === void 0) continue;
				node.append(typeof c === "string" ? document.createTextNode(c) : c);
			}
			return node;
		}
		function fmtMoney(v, currency) {
			if (v === null || currency === null || currency === "—") return "—";
			const sym = currency === "USD" ? "$" : currency === "CNY" ? "¥" : `${currency} `;
			const abs = Math.abs(v);
			const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 4;
			return `${sym}${v.toFixed(digits)}`;
		}
		function fmtTok(n) {
			if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
			if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
			if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
			return String(n);
		}
		function fmtPct(r) {
			return r === null ? "—" : `${(r * 100).toFixed(1)}%`;
		}
		const CSS = `
#${NS}-style { }
/* ── B2 顶栏徽标 v3：亮金渐变药丸（billing 主题；深字高对比；动效留在交互里不糊在描边上）── */
/* reduced-motion 仅停常驻环境动画（虹彩流动），交互过渡全保留 */
@media (prefers-reduced-motion:reduce){.dab-badge::before{animation:none!important}}
/* 推开式展开：徽标随内容参与 flex 流（壳宽随内容平滑增长）——悬停向左展开时左侧元素被平滑推开、右缘由右侧固定元素天然锚定不动 */
.dab-anchor { position:relative; flex:none; display:inline-flex; }
.dab-badge { position:relative; height:34px; display:inline-flex; align-items:center; justify-content:flex-end; box-sizing:border-box; gap:0; padding:0 3px; border-radius:16px; cursor:pointer; user-select:none; overflow:hidden;
  border:2px solid transparent; white-space:nowrap;
  background:
    linear-gradient(180deg, #ffffff 0%, #eef0f8 100%) padding-box,
    linear-gradient(120deg, #ffb0e0 0%, #7cc8ff 33%, #b08cff 66%, #ffcf6e 100%) border-box;
  box-shadow:0 4px 14px rgba(120,110,200,.30), 0 0 10px rgba(255,183,230,.22), inset 0 2px 4px rgba(255,255,255,.95), inset 0 -5px 9px rgba(160,145,210,.16);
  font-size:12.5px; color:#1f2937; line-height:1;
  transition:gap .32s cubic-bezier(.34,1.3,.5,1), padding .32s cubic-bezier(.34,1.3,.5,1), border-radius .38s cubic-bezier(.4,0,.2,1), box-shadow .3s ease, filter .3s ease; }
/* 虹彩光泽层：在珠光面上缓慢流动（::before 独立于 ::after 扫光） */
.dab-badge::before { content:''; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
  background:linear-gradient(120deg, rgba(255,166,224,.34), rgba(150,214,255,.32) 33%, rgba(199,170,255,.32) 66%, rgba(255,226,166,.36));
  background-size:300% 100%; animation:dab-irid 7s ease-in-out infinite;
  -webkit-mask-image:radial-gradient(130% 150% at 50% 50%, transparent 60%, black 90%);
  mask-image:radial-gradient(130% 150% at 50% 50%, transparent 60%, black 90%); }
.dab-anchor:hover .dab-badge::before { animation-duration:2.8s; }
@keyframes dab-irid { 0%,100% { background-position:0% 50%; } 50% { background-position:100% 50%; } }
/* 悬停展开：gap/padding spring 同步撑开 + 文字三重过渡（max-width+opacity+位移），全程无缩放 */
.dab-anchor:hover .dab-badge { filter:saturate(1.12) brightness(1.03); box-shadow:0 4px 18px rgba(120,100,200,.36), 0 0 18px rgba(255,183,230,.45), inset 0 2px 4px rgba(255,255,255,.95), inset 0 -6px 10px rgba(160,145,210,.22), inset 0 0 14px rgba(255,190,235,.26); }
.dab-anchor:hover .dab-badge, .dab-badge:focus-visible { gap:11px; padding:0 4px 0 16px; border-radius:999px; }
.dab-info { display:inline-flex; align-items:center; max-width:0; opacity:0; overflow:hidden; transform:translateX(-6px); white-space:nowrap;
  transition:max-width .36s cubic-bezier(.4,0,.2,1), opacity .26s ease, transform .36s cubic-bezier(.4,0,.2,1); }
.dab-anchor:hover .dab-info { max-width:180px; opacity:1; transform:none; }
.dab-coin { flex:0 0 auto; width:28px; height:28px; display:grid; place-items:center; perspective:140px; }
.dab-coin svg { width:28px; height:28px; transition:transform .6s cubic-bezier(.3,.7,.3,1); }
.dab-anchor:hover .dab-coin svg { transform:rotateY(360deg); }
.dab-badge::after { content:''; position:absolute; top:-20%; left:-70%; width:46%; height:140%;
  background:linear-gradient(105deg, transparent, rgba(255,255,255,.5), transparent);
  transform:skewX(-18deg); transition:left .5s ease; pointer-events:none; }
.dab-anchor:hover .dab-badge::after { left:135%; transition:left .45s ease; }
.dab-badge:active { box-shadow:0 1px 6px rgba(120,100,200,.35), inset 0 2px 6px rgba(140,120,190,.28); }
/* 预算警示态：warn=浅琥珀，over=浅玫瑰（虹彩动画停用，文字保持近黑可读） */
.dab-badge.dab-warn {
  background:
    linear-gradient(180deg, rgba(255,255,255,.55) 0%, rgba(255,255,255,.25) 100%),
    linear-gradient(180deg, #fff3d6 0%, #ffe3a8 100%);
  border-color:rgba(196,140,30,.65); }
.dab-badge.dab-warn::before { animation:none; opacity:.4; }
.dab-badge.dab-over {
  background:
    linear-gradient(180deg, rgba(255,255,255,.5) 0%, rgba(255,255,255,.2) 100%),
    linear-gradient(180deg, #ffe4e0 0%, #ffc9c2 100%);
  border-color:rgba(210,90,80,.6); }
.dab-badge.dab-over::before { animation:none; opacity:.4; }
.dab-seg { display:inline-flex; flex-direction:column; align-items:flex-start; gap:3px; padding:0 13px; line-height:1; }
.dab-seg + .dab-seg { border-left:1px solid rgba(31,41,55,.09); }
.dab-lbl { font-size:10px; color:#111827; font-weight:700; letter-spacing:.4px; font-family:inherit; }
.dab-amt { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:800; font-variant-numeric:tabular-nums; font-size:16px; color:#111827; }
.dab-amt-today { color:#111827; }
.dab-amt-sess { color:#111827; }
.dab-cur { color:#d99a06; margin-right:2px; }
.dab-flash { animation:dab-flash .45s ease; } @keyframes dab-flash { 0% { filter:brightness(1.4); } 100% { filter:none; } }
.dab-overlay { position:fixed; inset:0; z-index:9999; display:none; align-items:center; justify-content:center;
  background:rgba(8,10,24,.45); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); }
.dab-panel { width:min(980px, 94vw); max-height:88vh; display:flex; flex-direction:column; border-radius:18px; overflow:hidden;
  background:linear-gradient(150deg, rgba(24,28,52,.92), rgba(16,19,38,.94));
  border:1px solid rgba(140,160,255,.25); box-shadow:0 24px 80px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px); color:#e6e9f5; font-family:inherit; }
.dab-head { display:flex; align-items:center; gap:14px; padding:14px 18px; border-bottom:1px solid rgba(140,160,255,.16); }
.dab-title { font-size:15px; font-weight:700; letter-spacing:.3px;
  background:linear-gradient(90deg,#8ab4ff,#6ee7ff); -webkit-background-clip:text; background-clip:text; color:transparent; }
.dab-tabs { display:flex; gap:4px; margin-left:8px; }
.dab-tab { padding:5px 14px; border-radius:9px; cursor:pointer; font-size:12.5px; color:#9aa3c0; border:1px solid transparent; background:transparent; }
.dab-tab.active { color:#e6e9f5; background:rgba(120,150,255,.14); border-color:rgba(140,160,255,.28); }
.dab-win { display:flex; gap:2px; margin-left:auto; background:rgba(10,12,28,.6); border-radius:9px; padding:2px; }
.dab-win button { padding:4px 12px; border-radius:7px; border:none; background:transparent; color:#9aa3c0; font-size:12px; cursor:pointer; }
.dab-win button.active { background:rgba(120,150,255,.22); color:#fff; }
.dab-close { margin-left:6px; width:26px; height:26px; border-radius:8px; border:1px solid rgba(140,160,255,.2);
  background:rgba(255,255,255,.04); color:#c6cbe6; cursor:pointer; font-size:13px; }
.dab-close:hover { background:rgba(248,113,113,.18); border-color:rgba(248,113,113,.4); }
.dab-body { overflow:auto; padding:16px 18px 20px; }
.dab-cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:12px; margin-bottom:16px; }
.dab-card { padding:14px 16px; border-radius:14px; background:linear-gradient(140deg, rgba(120,150,255,.10), rgba(110,231,255,.05));
  border:1px solid rgba(140,160,255,.16); }
.dab-card .k { font-size:11px; color:#9aa3c0; letter-spacing:.5px; margin-bottom:6px; }
.dab-card .v { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; font-family:ui-monospace,Menlo,monospace; }
.dab-card .s { font-size:11px; color:#8b93b5; margin-top:4px; font-family:ui-monospace,Menlo,monospace; }
.dab-spark { margin-bottom:16px; padding:14px 16px; border-radius:14px; background:rgba(10,13,30,.5); border:1px solid rgba(140,160,255,.14); }
.dab-spark .t { font-size:11px; color:#9aa3c0; margin-bottom:8px; letter-spacing:.5px; }
.dab-budget { display:flex; flex-direction:column; gap:10px; margin-bottom:16px; }
.dab-brow { display:flex; align-items:center; gap:12px; font-size:12px; color:#c6cbe6; }
.dab-brow .lbl { width:44px; color:#9aa3c0; }
.dab-btrack { flex:1; height:8px; border-radius:99px; background:rgba(120,150,255,.10); overflow:hidden; }
.dab-bfill { height:100%; border-radius:99px; background:linear-gradient(90deg,#6ee7ff,#8ab4ff); transition:width .5s ease; }
.dab-bfill.warn { background:linear-gradient(90deg,#fbbf24,#f59e0b); } .dab-bfill.over { background:linear-gradient(90deg,#f87171,#ef4444); }
.dab-bval { width:150px; text-align:right; font-family:ui-monospace,Menlo,monospace; font-size:11.5px; }
.dab-table { width:100%; border-collapse:collapse; font-size:12.5px; }
.dab-table th { text-align:left; color:#9aa3c0; font-weight:500; font-size:11px; letter-spacing:.4px; padding:8px 10px; border-bottom:1px solid rgba(140,160,255,.18); position:sticky; top:0; background:rgba(16,19,38,.97); }
.dab-table td { padding:8px 10px; border-bottom:1px solid rgba(140,160,255,.08); font-variant-numeric:tabular-nums; }
.dab-table td.num, .dab-table th.num { text-align:right; font-family:ui-monospace,Menlo,monospace; }
.dab-table tr:hover td { background:rgba(120,150,255,.06); }
.dab-sec { font-size:12px; color:#9aa3c0; margin:14px 0 8px; letter-spacing:.5px; }
.dab-form { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:10px; }
.dab-field { display:flex; flex-direction:column; gap:4px; }
.dab-field label { font-size:11px; color:#9aa3c0; }
.dab-field input, .dab-field select, .dab-field textarea { padding:7px 10px; border-radius:9px; border:1px solid rgba(140,160,255,.2);
  background:rgba(10,13,30,.6); color:#e6e9f5; font-size:12.5px; outline:none; font-family:ui-monospace,Menlo,monospace; }
.dab-field input:focus, .dab-field textarea:focus { border-color:rgba(110,231,255,.5); box-shadow:0 0 0 2px rgba(110,231,255,.12); }
.dab-field.full { grid-column:1 / -1; }
.dab-btn { padding:7px 16px; border-radius:9px; border:1px solid rgba(140,160,255,.28); cursor:pointer; font-size:12.5px;
  background:linear-gradient(135deg, rgba(120,150,255,.2), rgba(110,231,255,.12)); color:#e6e9f5; transition:filter .15s; }
.dab-btn:hover { filter:brightness(1.2); }
.dab-btn.ghost { background:transparent; border-color:rgba(140,160,255,.2); color:#9aa3c0; }
.dab-btn.danger { background:rgba(248,113,113,.12); border-color:rgba(248,113,113,.35); color:#fca5a5; }
.dab-btnrow { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; align-items:center; }
.dab-plist { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
.dab-pchip { padding:5px 12px; border-radius:99px; font-size:12px; cursor:pointer; border:1px solid rgba(140,160,255,.2);
  background:rgba(120,150,255,.08); color:#c6cbe6; }
.dab-pchip.active { background:rgba(120,150,255,.26); border-color:rgba(110,231,255,.5); color:#fff; }
.dab-toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:10000; padding:9px 18px; border-radius:11px;
  background:rgba(20,24,48,.95); border:1px solid rgba(140,160,255,.3); color:#e6e9f5; font-size:12.5px; backdrop-filter:blur(10px); }
.dab-toast.err { border-color:rgba(248,113,113,.45); color:#fca5a5; }
.dab-hint { font-size:11.5px; color:#8b93b5; line-height:1.7; }
.dab-degraded { margin-top:10px; padding:8px 12px; border-radius:9px; background:rgba(251,191,36,.08); border:1px solid rgba(251,191,36,.25);
  font-size:11.5px; color:#fcd34d; font-family:ui-monospace,Menlo,monospace; white-space:pre-wrap; }
.dab-live-badge { display:inline-block; padding:2px 8px; border-radius:99px; font-size:10.5px; background:rgba(52,211,153,.14); color:#34d399; }
/* 徽标 v3 亮金药丸自带明暗环境适应性，无需 light 主题特判 */
body:not([data-ds-dark-theme]) .dab-panel { background:linear-gradient(150deg, rgba(250,251,255,.94), rgba(238,242,255,.96)); color:#1c2242; border-color:rgba(90,110,220,.25); }
body:not([data-ds-dark-theme]) .dab-tab { color:#5a628a; }
body:not([data-ds-dark-theme]) .dab-tab.active { color:#1c2242; background:rgba(90,110,220,.12); }
body:not([data-ds-dark-theme]) .dab-card { background:linear-gradient(140deg, rgba(90,110,220,.08), rgba(110,231,255,.06)); }
body:not([data-ds-dark-theme]) .dab-card .v { color:#1c2242; }
body:not([data-ds-dark-theme]) .dab-card .k, body:not([data-ds-dark-theme]) .dab-card .s, body:not([data-ds-dark-theme]) .dab-spark .t, body:not([data-ds-dark-theme]) .dab-sec, body:not([data-ds-dark-theme]) .dab-hint { color:#5a628a; }
body:not([data-ds-dark-theme]) .dab-table th { background:rgba(248,250,255,.97); }
body:not([data-ds-dark-theme]) .dab-brow { color:#1c2242; } body:not([data-ds-dark-theme]) .dab-brow .lbl { color:#5a628a; }
body:not([data-ds-dark-theme]) .dab-field input, body:not([data-ds-dark-theme]) .dab-field select, body:not([data-ds-dark-theme]) .dab-field textarea { background:rgba(255,255,255,.8); color:#1c2242; }
body:not([data-ds-dark-theme]) .dab-btn { color:#1c2242; } body:not([data-ds-dark-theme]) .dab-btn.ghost { color:#5a628a; } body:not([data-ds-dark-theme]) .dab-pchip { color:#1c2242; }
body:not([data-ds-dark-theme]) .dab-win { background:rgba(90,110,220,.08); } body:not([data-ds-dark-theme]) .dab-win button { color:#5a628a; } body:not([data-ds-dark-theme]) .dab-win button.active { color:#fff; }
body:not([data-ds-dark-theme]) .dab-btrack { background:rgba(90,110,220,.12); }
body:not([data-ds-dark-theme]) .dab-spark { background:rgba(90,110,220,.06); border-color:rgba(90,110,220,.18); }
body:not([data-ds-dark-theme]) .dab-table td { border-bottom-color:rgba(90,110,220,.12); }
body:not([data-ds-dark-theme]) .dab-toast { background:rgba(250,251,255,.97); color:#1c2242; }
body:not([data-ds-dark-theme]) .dab-degraded { color:#b45309; }
`;
		/**
		* 样式自愈注入：DOM 是唯一真相（无模块级 flag）。
		* DSH 运行中会清理/重建 head 节点，style 标签被移除会导致 .dab-overlay 失去
		* display:none（幽灵面板可见）+ 徽标裸奔 —— 所以每次轮询/构建节点都自愈检查。
		*/
		function ensureStyle() {
			const existing = document.getElementById(`${NS}-style`);
			if (existing?.isConnected) return;
			existing?.remove();
			document.head.append(el("style", { id: `${NS}-style` }, CSS));
		}
		async function apiJson(path, init) {
			const res = await fetch(`${API}${path}`, {
				headers: { "content-type": "application/json" },
				...init
			});
			const json = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
			return json;
		}
		/** 本窗口会话 id：从面包屑节点的 React fiber 链上取会话 key（唯一 id，标题重复/改名免疫）。 */
		function currentWindowSessionId() {
			const el = document.querySelector("[class*=\"crumbCurrent\"]");
			if (!el) return null;
			for (const k of Object.keys(el)) {
				if (!k.startsWith("__reactFiber$")) continue;
				let fiber = el[k];
				for (let i = 0; i < 8 && fiber; i += 1) {
					if (typeof fiber.key === "string" && fiber.key.startsWith("session-")) return fiber.key;
					fiber = fiber.return;
				}
			}
			return null;
		}
		async function refresh() {
			try {
				ensureStyle();
				statusData = await apiJson("/status");
				const sid = currentWindowSessionId();
				if (sid) perSession = await apiJson("/status?session=" + encodeURIComponent(sid) + "&compact=1").then((r) => r?.session ?? null).catch(() => perSession);
				else {
					const crumb = document.querySelector("[class*=\"crumbCurrent\"]")?.textContent?.trim() ?? "";
					const hit = crumb.length >= 6 ? (statusData?.sessions ?? []).find((s) => typeof s.title === "string" && s.title.slice(0, 16) === crumb.slice(0, 16)) : null;
					perSession = hit ? await apiJson("/status?session=" + encodeURIComponent(hit.id) + "&compact=1").then((r) => r?.session ?? null).catch(() => perSession) : null;
				}
				renderBadges();
				if (overlayOpen && activeTab !== "settings") renderOverlayBody();
			} catch (error) {
				console.warn("[dsh-agent-billing] refresh 失败：", String(error).slice(0, 200));
			}
		}
		function onRetune() {
			const next = statusData?.settings?.refreshMs;
			if (typeof next === "number" && next !== currentRefreshMs) {
				currentRefreshMs = next;
				if (pollTimer !== null) {
					window.clearInterval(pollTimer);
					pollTimer = null;
				}
				if (pollTimer === null) pollTimer = window.setInterval(() => {
					refresh();
				}, currentRefreshMs);
			}
		}
		function startPolling(ctx) {
			if (pollTimer !== null) return;
			pollTimer = window.setInterval(() => {
				refresh();
			}, currentRefreshMs);
			window.addEventListener("dab-retune", onRetune);
			refresh();
		}
		function worstBudgetState() {
			const states = [statusData?.budgets?.daily?.state, statusData?.budgets?.monthly?.state];
			if (states.includes("over")) return "over";
			if (states.includes("warn")) return "warn";
			if (states.includes("unset")) return "unset";
			return "ok";
		}
		function fmtCny(v) {
			if (v === null) return "—";
			const abs = Math.abs(v);
			const digits = abs >= 1e3 ? 0 : abs >= 1 ? 2 : 4;
			return `¥${v.toFixed(digits)}`;
		}
		/** 今日总花费 + 本会话（最近活跃会话）今日花费，均人民币口径 */
		function badgeData() {
			const s = statusData;
			if (!s) return {
				today: "…",
				session: "…",
				sessionCredit: false
			};
			const today = s.windows?.today?.costCny ?? null;
			if (perSession) return {
				today: fmtCny(today),
				session: fmtCny(perSession.costCny),
				sessionCredit: false
			};
			const recentId = s.recentSession?.id;
			const sessRow = recentId ? (s.sessions ?? []).find((x) => x.id === recentId) : null;
			const liveRow = recentId ? (s.live ?? []).find((l) => l.id === recentId) : null;
			const isCredit = sessRow ? sessRow.costCredit > 0 : (liveRow?.costCreditEstimate ?? 0) > 0;
			const session = isCredit ? "⊙ " + fmtCny(sessRow ? sessRow.costCredit : liveRow?.costCreditEstimate ?? null).slice(1) : fmtCny(sessRow ? sessRow.costCny : liveRow?.costCnyEstimate ?? null);
			return {
				today: fmtCny(today),
				session,
				sessionCredit: isCredit
			};
		}
		const COIN_SVG = "<svg viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"dab-coin-g\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"#ffd75e\"/><stop offset=\".55\" stop-color=\"#f5b91e\"/><stop offset=\"1\" stop-color=\"#e0900a\"/></linearGradient></defs><circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"#4a3606\"/><circle cx=\"12\" cy=\"12\" r=\"9\" fill=\"url(#dab-coin-g)\" stroke=\"#8a5f04\" stroke-width=\".5\"/><circle cx=\"12\" cy=\"12\" r=\"6.4\" fill=\"none\" stroke=\"#c9930f\" stroke-width=\".6\" opacity=\".8\"/><path d=\"M5.2 8.6 a7.4 7.4 0 0 1 5.4-4.6\" stroke=\"#fff\" stroke-width=\"1.1\" stroke-linecap=\"round\" fill=\"none\" opacity=\".7\"/><text x=\"12\" y=\"15.9\" text-anchor=\"middle\" font-size=\"9.5\" font-weight=\"800\" fill=\"#ffffff\" font-family=\"ui-monospace,Menlo,monospace\">¥</text><path d=\"M4.2 2.8 l.7 1.6 1.6 .7 -1.6 .7 -.7 1.6 -.7 -1.6 -1.6 -.7 1.6 -.7 z\" fill=\"#ffffff\" opacity=\".95\"/><ellipse cx=\"8.8\" cy=\"7.4\" rx=\"2.6\" ry=\"1.3\" fill=\"#fff\" opacity=\".55\" transform=\"rotate(-32 8.8 7.4)\"/></svg>";
		function buildBadge() {
			ensureStyle();
			const initial = badgeData();
			const todayAmt = el("b", { class: "dab-amt dab-amt-today" }, initial.today);
			const sessAmt = el("b", { class: "dab-amt dab-amt-sess" }, initial.session);
			const coin = el("span", {
				class: "dab-coin",
				"aria-hidden": "true"
			});
			coin.innerHTML = COIN_SVG;
			const badge = el("div", {
				class: "dab-badge",
				role: "button",
				title: "今日 / 本会话 花费（人民币）· 点击打开计费面板",
				onclick: () => window.dispatchEvent(new CustomEvent(TOGGLE_EVENT))
			}, el("span", { class: "dab-info" }, el("span", { class: "dab-seg" }, el("span", { class: "dab-lbl" }, "今日"), todayAmt), el("span", { class: "dab-seg" }, el("span", { class: "dab-lbl" }, "本会话"), sessAmt)), coin);
			const shell = el("div", { class: "dab-anchor" }, badge);
			badgeEls.add(badge);
			shell.__dabMount = () => renderBadges();
			return shell;
		}
		function renderBadges() {
			const nodes = /* @__PURE__ */ new Set([...document.querySelectorAll(".dab-badge"), ...badgeEls]);
			for (const node of nodes) {
				if (!node.isConnected) {
					badgeEls.delete(node);
					continue;
				}
				const { today, session } = badgeData();
				const todayEl = node.querySelector(".dab-amt-today");
				const sessEl = node.querySelector(".dab-amt-sess");
				for (const [elm, text] of [[todayEl, today], [sessEl, session]]) {
					if (!elm) continue;
					const html = text.startsWith("⊙") ? "<span class=\"dab-cur\">⊙</span>" + text.slice(1) : text;
					if (elm.innerHTML !== html) {
						elm.innerHTML = html;
						elm.classList.remove("dab-flash");
						elm.offsetWidth;
						elm.classList.add("dab-flash");
					}
				}
				const state = worstBudgetState();
				node.classList.toggle("dab-warn", state === "warn");
				node.classList.toggle("dab-over", state === "over");
			}
		}
		function statCard(k, v, s) {
			const value = el("div", { class: "v" }, v());
			value.__dabGet = v;
			return el("div", { class: "dab-card" }, el("div", { class: "k" }, k), value, s ? el("div", { class: "s" }, s()) : null);
		}
		function renderStatCards(win, currency) {
			return [
				statCard("花费（人民币）", () => fmtMoney(win.costCny, "CNY"), () => `${win.calls} 次调用${win.costCredit > 0 ? " · 另计 ⊙" + win.costCredit.toFixed(1) + " 积分" : ""}`),
				statCard("Tokens", () => fmtTok(win.tokens), () => `输入 ${fmtTok(win.inTok)} · 输出 ${fmtTok(win.outTok)}`),
				statCard("缓存命中", () => fmtPct(win.cacheHitRatio), () => `读 ${fmtTok(win.cacheRead)} · 写 ${fmtTok(win.cacheWrite)}`),
				statCard("实时会话", () => {
					const top = statusData?.live?.[0];
					return top ? top.costEstimate !== null ? fmtMoney(top.costEstimate, top.currency) : fmtTok(top.totals?.outputTokens ?? 0) : "—";
				}, () => statusData?.live?.[0] ? `${statusData.live[0].model ?? "未知模型"} · ${fmtTok(statusData.live[0].totals?.outputTokens ?? 0)} out` : "当前无活跃会话")
			];
		}
		function sparkline(days) {
			const wrap = el("div", { class: "dab-spark" }, el("div", { class: "t" }, "近 14 天花费趋势"));
			const byDate = new Map(days.map((d) => [d.date, d.cost]));
			const series = [];
			for (let i = 13; i >= 0; i--) {
				const d = /* @__PURE__ */ new Date(Date.now() - i * 864e5);
				const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
				series.push({
					date: key,
					cost: byDate.get(key) ?? 0
				});
			}
			const W = 860;
			const H = 110;
			const PAD = 8;
			const max = Math.max(...series.map((d) => d.cost), 1e-9);
			const pts = series.map((d, i) => {
				return {
					x: PAD + i / (series.length - 1) * (W - PAD * 2),
					y: H - PAD - d.cost / max * (H - PAD * 2),
					...d
				};
			});
			const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
			const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${H - PAD} L${pts[0].x.toFixed(1)},${H - PAD} Z`;
			const svgNS = "http://www.w3.org/2000/svg";
			const svg = document.createElementNS(svgNS, "svg");
			svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
			svg.setAttribute("width", "100%");
			svg.setAttribute("height", String(H));
			svg.setAttribute("preserveAspectRatio", "none");
			const defs = document.createElementNS(svgNS, "defs");
			defs.innerHTML = `<linearGradient id="dab-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6ee7ff" stop-opacity=".35"/><stop offset="100%" stop-color="#6ee7ff" stop-opacity="0"/></linearGradient>`;
			const areaPath = document.createElementNS(svgNS, "path");
			areaPath.setAttribute("d", area);
			areaPath.setAttribute("fill", "url(#dab-grad)");
			const linePath = document.createElementNS(svgNS, "path");
			linePath.setAttribute("d", line);
			linePath.setAttribute("fill", "none");
			linePath.setAttribute("stroke", "#6ee7ff");
			linePath.setAttribute("stroke-width", "2");
			linePath.setAttribute("stroke-linecap", "round");
			linePath.setAttribute("stroke-linejoin", "round");
			linePath.setAttribute("vector-effect", "non-scaling-stroke");
			svg.append(defs, areaPath, linePath);
			for (const p of pts) {
				const isToday = p === pts[pts.length - 1];
				const c = document.createElementNS(svgNS, "circle");
				c.setAttribute("cx", String(p.x));
				c.setAttribute("cy", String(p.y));
				c.setAttribute("r", isToday ? "4" : "3");
				c.setAttribute("fill", isToday ? "#8ab4ff" : "#6ee7ff");
				c.setAttribute("vector-effect", "non-scaling-stroke");
				const title = document.createElementNS(svgNS, "title");
				title.textContent = `${p.date}: ${p.cost.toFixed(4)}`;
				c.append(title);
				svg.append(c);
			}
			wrap.append(svg);
			return wrap;
		}
		function budgetRows() {
			const wrap = el("div", { class: "dab-budget" });
			const budgets = statusData?.budgets;
			statusData?.windows?.[activeWindow]?.byProfile?.[0]?.currency;
			for (const [key, label] of [["daily", "今日"], ["monthly", "本月"]]) {
				const b = budgets?.[key];
				const limit = b?.limit ?? null;
				const spent = b?.spent ?? 0;
				const pct = limit !== null && limit > 0 ? Math.min(spent / limit, 1) : 0;
				const state = b?.state ?? "unset";
				const fill = el("div", { class: `dab-bfill ${state === "warn" || state === "over" ? state : ""}` });
				setTimeout(() => {
					fill.style.width = `${(pct * 100).toFixed(1)}%`;
				}, 30);
				wrap.append(el("div", { class: "dab-brow" }, el("span", { class: "lbl" }, label), el("div", { class: "dab-btrack" }, fill), el("span", { class: "dab-bval" }, limit !== null ? `${fmtMoney(spent, "CNY")} / ${fmtMoney(limit, "CNY")}` : `${fmtMoney(spent, "CNY")} · 未设预算`)));
			}
			wrap.append(el("div", { class: "dab-hint" }, "预算为各档案花费数值直加（混合币种场景请统一档案币种口径）"));
			return wrap;
		}
		function aggTable(title, rows, cols) {
			const frag = el("div", {}, el("div", { class: "dab-sec" }, title));
			if (rows.length === 0) {
				frag.append(el("div", { class: "dab-hint" }, "该窗口暂无数据"));
				return frag;
			}
			const table = el("table", { class: "dab-table" });
			table.append(el("tr", {}, ...cols.map(([h, , cls]) => el("th", { class: cls ?? "" }, h))));
			for (const r of rows) table.append(el("tr", {}, ...cols.map(([, get, cls]) => el("td", { class: cls ?? "" }, get(r)))));
			frag.append(table);
			return frag;
		}
		function overviewTab(win) {
			return [
				el("div", { class: "dab-cards" }, ...renderStatCards(win, currency)),
				sparkline(statusData?.days ?? []),
				budgetRows()
			];
		}
		function detailTab(win) {
			return [aggTable("按账号（费率档案）", win.byProfile ?? [], [
				[
					"账号",
					(r) => `${r.label}`,
					""
				],
				[
					"币种",
					(r) => r.currency,
					"num"
				],
				[
					"调用",
					(r) => String(r.calls),
					"num"
				],
				[
					"Tokens",
					(r) => fmtTok(r.tokens),
					"num"
				],
				[
					"花费",
					(r) => fmtMoney(r.cost, r.currency),
					"num"
				]
			]), aggTable("按模型", win.byModel ?? [], [
				[
					"模型",
					(r) => r.model,
					""
				],
				[
					"Provider",
					(r) => r.provider,
					""
				],
				[
					"调用",
					(r) => String(r.calls),
					"num"
				],
				[
					"输入",
					(r) => fmtTok(r.inTok),
					"num"
				],
				[
					"输出",
					(r) => fmtTok(r.outTok),
					"num"
				],
				[
					"缓存读",
					(r) => fmtTok(r.cacheRead),
					"num"
				],
				[
					"花费",
					(r) => fmtMoney(r.cost, (win.byProfile ?? []).find((p) => p.profileId === r.profileId)?.currency ?? "USD"),
					"num"
				]
			])];
		}
		function sessionsTab() {
			return [
				aggTable("今日会话（按花费排序）", statusData?.sessions ?? [], [
					[
						"会话",
						(r) => r.id.slice(0, 12),
						""
					],
					[
						"调用",
						(r) => String(r.calls),
						"num"
					],
					[
						"Tokens",
						(r) => fmtTok(r.tokens),
						"num"
					],
					[
						"花费",
						(r) => fmtMoney(r.cost, statusData?.windows.today.byProfile?.[0]?.currency ?? "USD"),
						"num"
					]
				]),
				el("div", { class: "dab-sec" }, "实时会话"),
				...(statusData?.live ?? []).map((l) => el("div", {
					class: "dab-hint",
					style: "margin-bottom:6px"
				}, `${l.id.slice(0, 12)} · ${l.model ?? "?"} @ ${l.provider ?? "?"} · 累计 ${fmtMoney(l.costEstimate, l.currency)} · 输出 ${fmtTok(l.totals?.outputTokens ?? 0)}`))
			];
		}
		function blankProfile() {
			return {
				id: `p${Date.now().toString(36)}`,
				label: "",
				providerMatch: "*",
				currency: "USD",
				rates: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0
				}
			};
		}
		function field(label, input, full = false) {
			return el("div", { class: `dab-field${full ? " full" : ""}` }, el("label", {}, label), input);
		}
		function input(value, placeholder = "") {
			const i = document.createElement("input");
			i.value = value;
			i.placeholder = placeholder;
			return i;
		}
		function profileForm(p) {
			const form = el("div", {});
			const rates = { ...p.rates };
			const byModelText = input(JSON.stringify(p.byModel ?? {}, null, 0), "{\"glm-*\":{\"input\":1,\"output\":4,\"cacheRead\":0.1,\"cacheWrite\":0}}");
			const f = (v) => String(v);
			const grid = el("div", { class: "dab-form" }, field("档案 ID（稳定，勿随意改）", input(p.id)), field("名称", input(p.label ?? "", "如 公司 API / 中转一号 / Kiro")), field("Provider 匹配（精确 / * / 前缀* / *后缀 / *含*）", input(p.providerMatch ?? "*", "如 kiro / relay-*")), field("币种", input(p.currency ?? "USD", "USD / CNY")), field("折扣（可选，1 = 原价）", input(p.discount !== void 0 ? String(p.discount) : "")), field("输入价 /Mtok", input(f(rates.input ?? 0))), field("输出价 /Mtok", input(f(rates.output ?? 0))), field("缓存读价 /Mtok", input(f(rates.cacheRead ?? 0))), field("缓存写价 /Mtok", input(f(rates.cacheWrite ?? 0))), field("按模型覆盖费率（JSON，可留空 {}）", byModelText, true));
			const bal = p.balance;
			const adapterSel = document.createElement("select");
			for (const [v, t] of [
				["", "不查询余额"],
				["deepseek", "DeepSeek 官方"],
				["openai-billing", "中转站（New API 兼容）"]
			]) {
				const o = document.createElement("option");
				o.value = v;
				o.textContent = t;
				if (bal?.adapter === v) o.selected = true;
				adapterSel.append(o);
			}
			const baseUrlInput = input(bal?.baseUrl ?? "", "https://api.deepseek.com 或中转站地址");
			const keyInput = input(bal?.apiKey ?? "", "Bearer API Key（仅存本地）");
			keyInput.type = "password";
			const balanceOut = el("div", { class: "dab-hint" }, bal ? "已配置余额查询" : "");
			grid.append(field("余额查询", adapterSel), field("Base URL", baseUrlInput), field("API Key", keyInput), field("余额查询结果", balanceOut));
			const collect = () => {
				const out = {
					...p,
					label: grid.querySelectorAll("input")[1].value,
					providerMatch: grid.querySelectorAll("input")[2].value
				};
				out.id = grid.querySelectorAll("input")[0].value.trim();
				out.currency = grid.querySelectorAll("input")[3].value.trim() || "USD";
				const discountRaw = grid.querySelectorAll("input")[4].value.trim();
				out.discount = discountRaw === "" ? void 0 : Number(discountRaw);
				const nums = [
					5,
					6,
					7,
					8
				].map((i) => Number(grid.querySelectorAll("input")[i].value || "0"));
				out.rates = {
					input: nums[0],
					output: nums[1],
					cacheRead: nums[2],
					cacheWrite: nums[3]
				};
				try {
					const parsed = JSON.parse(byModelText.value || "{}");
					out.byModel = parsed && Object.keys(parsed).length > 0 ? parsed : void 0;
				} catch {
					throw new Error("按模型覆盖费率不是合法 JSON");
				}
				if (adapterSel.value !== "") out.balance = {
					adapter: adapterSel.value,
					baseUrl: baseUrlInput.value.trim(),
					apiKey: keyInput["value"]["trim"]()
				};
				return out;
			};
			const saveBtn = el("button", { class: "dab-btn" }, "保存档案");
			saveBtn.addEventListener("click", () => {
				(async () => {
					try {
						const next = collect();
						const others = profilesData.filter((x) => x.id !== p.id);
						await apiJson("/profiles", {
							method: "PUT",
							body: JSON.stringify({ profiles: [...others, next] })
						});
						toast("档案已保存");
						editingProfileId = next.id;
						await reloadProfiles();
					} catch (e) {
						toast(String(e).slice(0, 160), true);
					}
				})();
			});
			const delBtn = el("button", { class: "dab-btn danger" }, "删除档案");
			delBtn.addEventListener("click", () => {
				(async () => {
					try {
						await apiJson("/profiles", {
							method: "PUT",
							body: JSON.stringify({ profiles: profilesData.filter((x) => x.id !== p.id) })
						});
						toast("档案已删除");
						editingProfileId = null;
						await reloadProfiles();
					} catch (e) {
						toast(String(e).slice(0, 160), true);
					}
				})();
			});
			const queryBtn = el("button", { class: "dab-btn ghost" }, "查询余额");
			queryBtn.addEventListener("click", () => {
				(async () => {
					try {
						const draft = collect();
						await apiJson("/profiles", {
							method: "PUT",
							body: JSON.stringify({ profiles: [...profilesData.filter((x) => x.id !== p.id), draft] })
						});
						const r = await apiJson("/balance", {
							method: "POST",
							body: JSON.stringify({ profileId: draft.id })
						});
						balanceOut.textContent = `余额 ${fmtMoney(Number(r.balance), String(r.currency))}`;
						await reloadProfiles();
					} catch (e) {
						balanceOut.textContent = `查询失败：${String(e).slice(0, 140)}`;
					}
				})();
			});
			form.append(grid, el("div", { class: "dab-btnrow" }, saveBtn, queryBtn, delBtn));
			return form;
		}
		function settingsTab() {
			return renderSettingsRoot();
		}
		/** 设置页根：二级页签（模型计费 / 账号档案 / 预算·汇率 / 导入导出） */
		function renderSettingsRoot() {
			const wrap = el("div", {});
			const tabs = [
				["models", "模型计费"],
				["profiles", "账号档案"],
				["budget", "预算·汇率"],
				["io", "导入导出"]
			];
			const bar = el("div", {
				class: "dab-tabs",
				style: "margin-bottom:12px"
			});
			for (const [key, label] of tabs) {
				const b = el("button", { class: `dab-tab${settingsSubTab === key ? " active" : ""}` }, label);
				b.addEventListener("click", () => {
					settingsSubTab = key;
					renderOverlayBody();
				});
				bar.append(b);
			}
			wrap.append(bar);
			if (settingsSubTab === "models") wrap.append(modelsView());
			else if (settingsSubTab === "profiles") wrap.append(profilesView());
			else if (settingsSubTab === "budget") wrap.append(budgetView());
			else wrap.append(ioView());
			return wrap;
		}
		/** Agent 模型是否支持读图：按当前 Agent（provider/model）从目录现算，不依赖持久化旧值 */
		function agentSupportsVision(sm) {
			const m = ((catalogData?.dsh ?? []).find((x) => x.id === sm?.agentProvider)?.models ?? []).find((x) => x.id === sm?.agentModel);
			if (!m) return !!sm?.supportsVision;
			return (m.inputModalities ?? []).includes("image");
		}
		async function ensureCatalog() {
			if (catalogData || catalogLoading || catalogFailed) return catalogData;
			catalogLoading = true;
			try {
				catalogData = await apiJson("/catalog");
				catalogFailed = false;
			} catch {
				catalogData = null;
				catalogFailed = true;
			}
			catalogLoading = false;
			return catalogData;
		}
		/** 模型计费视图：智能配置卡 + 官方库状态 + 搜索 + 双目录模型列表 */
		function modelsView() {
			const wrap = el("div", {});
			const sm = statusData?.settings?.smart ?? {
				enabled: false,
				agentProvider: "",
				agentModel: "",
				sources: []
			};
			const smartCard = el("div", { class: "dab-spark" }, el("div", { class: "t" }, "智能配置 · Agent 设置（在各模型详情里为本模型添加规则源并执行）"));
			const enabledCb = document.createElement("input");
			enabledCb.type = "checkbox";
			enabledCb.checked = !!sm.enabled;
			smartCard.append(el("div", { class: "dab-btnrow" }, el("label", { class: "dab-hint" }, enabledCb, " 启用智能配置（默认关闭）")));
			const agentArea = el("div", {});
			const buildAgentArea = () => {
				agentArea.replaceChildren();
				if (!enabledCb.checked) {
					agentArea.append(el("div", { class: "dab-hint" }, "开启后选择一个 DSH 已配置模型作为智能配置 Agent；规则源在各模型的「智能配置」里按模型添加。"));
					return;
				}
				const provSel = document.createElement("select");
				const modelSel = document.createElement("select");
				const dshGroups = catalogData?.dsh ?? [];
				for (const g of dshGroups) {
					const o = document.createElement("option");
					o.value = g.id;
					o.textContent = g.name;
					if (sm.agentProvider === g.id) o.selected = true;
					provSel.append(o);
				}
				const fillModels = () => {
					modelSel.replaceChildren();
					const g = dshGroups.find((x) => x.id === provSel.value);
					for (const m of g?.models ?? []) {
						const o = document.createElement("option");
						o.value = m.id;
						o.textContent = m.label + ((m.inputModalities ?? []).includes("image") ? " （可读图）" : "");
						if (sm.agentModel === m.id) o.selected = true;
						modelSel.append(o);
					}
					sm.supportsVision = agentSupportsVision(sm);
				};
				fillModels();
				provSel.addEventListener("change", () => {
					sm.agentProvider = provSel.value;
					fillModels();
				});
				modelSel.addEventListener("change", () => {
					sm.agentModel = modelSel.value;
					sm.supportsVision = agentSupportsVision(sm);
				});
				agentArea.append(el("div", { class: "dab-form" }, field("Agent Provider", provSel), field("Agent 模型（标注可读图）", modelSel)));
				agentArea.append(el("div", {
					class: "dab-hint",
					style: "margin-top:8px"
				}, "规则源是按模型配置的：在各模型详情的「⚡ 智能配置」里添加网页/描述/截图源并执行。"));
			};
			buildAgentArea();
			wrap.append(smartCard);
			const search = input(modelSearch, "搜索模型 / provider…");
			search.style.width = "100%";
			search.addEventListener("input", () => {
				modelSearch = search.value;
				renderOverlayBody();
			});
			const officialRow = el("div", {
				class: "dab-btnrow",
				style: "margin-bottom:10px"
			}, el("span", { class: "dab-hint" }, `官方库：${statusData ? catalogData?.officialGeneratedAt ? "更新于 " + catalogData.officialGeneratedAt.slice(5, 16) : "加载中" : "—"} · 覆盖 ${catalogData?.catalog?.reduce((n, g) => n + g.models.length, 0) ?? 0} 个模型`), el("button", { class: "dab-btn ghost" }, "⟳ 立即刷新官方库"));
			officialRow.querySelector("button")?.addEventListener("click", () => {
				apiJson("/official", { method: "POST" }).then((r) => {
					toast(`官方库已刷新：${r.count} 条，变更 ${r.changed}`);
					catalogData = null;
					ensureCatalog().then(() => renderOverlayBody());
				}).catch((e) => toast(String(e).slice(0, 200), true));
			});
			wrap.append(officialRow, el("div", {}, search), el("div", { style: "height:8px" }));
			const listWrap = el("div", {});
			wrap.append(listWrap);
			const kw = modelSearch.trim().toLowerCase();
			const matchQ = (t) => kw === "" || t.toLowerCase().includes(kw);
			const renderModelRow = (provId, m) => {
				const key = m.ruleKey ?? provId + "/" + m.id;
				const cur = m.currency === "credit" ? "⊙积分" : m.currency === "USD" ? "$" : m.currency === "CNY" ? "¥" : m.currency ?? "—";
				const srcLabel = m.source === "official" ? "官方" : m.source === "manual" ? "手动" : m.source === "smart" ? "智能" : "未配置";
				const row = el("div", {
					class: "dab-btnrow",
					style: "cursor:pointer; padding:6px 8px; border-radius:9px; border:1px solid transparent"
				}, el("span", {
					class: m.source === "official" ? "dab-live-badge" : m.source === "none" ? "dab-hint" : "dab-live-badge",
					style: "flex:0 0 46px; text-align:center"
				}, srcLabel), el("span", { style: "flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" }, `${m.label} `, el("span", { class: "dab-hint" }, m.id)), el("span", { class: "dab-hint" }, (m.free ? "免费 · " : "") + cur));
				if (selectedModelKey === key) row.style.borderColor = "rgba(110,231,255,.4)";
				row.addEventListener("click", () => {
					selectedModelKey = selectedModelKey === key ? null : key;
					renderOverlayBody();
				});
				return row;
			};
			const renderConfigPanel = (provId, m) => {
				const panel = el("div", {
					class: "dab-degraded",
					style: "background:rgba(90,110,220,.06); border-color:rgba(90,110,220,.25); color:inherit"
				});
				const ruleKey = m.ruleKey ?? provId + "/" + m.id;
				const userRule = rulesData.find((r) => r.key === ruleKey);
				(catalogData?.__officialBykey ?? {})[ruleKey];
				const modeRow = el("div", {
					class: "dab-btnrow",
					style: "margin-bottom:8px"
				});
				const modes = [["manual", "✎ 手动配置"], ["smart", "⚡ 智能配置"]];
				const panelMode = { v: "manual" };
				const modeViews = {};
				const modeArea = el("div", {});
				for (const [mv, ml] of modes) {
					const b = el("button", { class: "dab-btn ghost" }, ml);
					b.addEventListener("click", () => {
						panelMode.v = mv;
						for (const [mv2] of modes) modeRow.querySelector(`button[data-mode="${mv2}"]`)?.classList.toggle("active", mv2 === mv);
						modeArea.replaceChildren(modeViews[mv]);
					});
					b.setAttribute("data-mode", mv);
					modeRow.append(b);
				}
				const manualView = el("div", {});
				const dimsOrder = [
					["input", "输入"],
					["cacheRead", "缓存命中"],
					["cacheWrite5m", "5m 缓存写入"],
					["cacheWrite1h", "1h 缓存写入"],
					["output", "输出"],
					["reasoning", "思考（已含于输出，仅展示）"]
				];
				const curSel = document.createElement("select");
				for (const [v, t] of [
					["CNY", "¥ 人民币"],
					["USD", "$ 美元"],
					["credit", "⊙ credit 积分"]
				]) {
					const o = document.createElement("option");
					o.value = v;
					o.textContent = t;
					curSel.append(o);
				}
				const freeCb = document.createElement("input");
				freeCb.type = "checkbox";
				const factorIn = input("", "每 1M token ≈ x credit");
				const dimInputs = /* @__PURE__ */ new Map();
				const grid = el("div", { class: "dab-form" }, field("币种", curSel), field("免费模型", freeCb));
				for (const [k, lbl] of dimsOrder) {
					const i = input("");
					dimInputs.set(k, i);
					grid.append(field(lbl + " /Mtok", i));
				}
				grid.append(field("credit 系数（credit 币种）", factorIn));
				manualView.append(grid);
				const save = el("button", {
					class: "dab-btn",
					style: "margin-top:10px"
				}, "保存手动计费规则");
				save.addEventListener("click", () => {
					(async () => {
						const num = (i) => {
							if (!i || i.value.trim() === "") return null;
							const v = Number(i.value);
							return Number.isFinite(v) && v >= 0 ? v : null;
						};
						const dims = {};
						for (const [k] of dimsOrder) dims[k] = num(dimInputs.get(k) ?? null);
						const rule = {
							key: provId + "/" + m.id,
							match: {
								provider: provId,
								model: m.id
							},
							label: m.label,
							currency: curSel.value,
							base: dims,
							free: freeCb.checked,
							source: "manual",
							creditFactor: curSel.value === "credit" ? Number(factorIn.value || 1) : void 0,
							updatedAt: (/* @__PURE__ */ new Date()).toISOString()
						};
						validateClient(rule);
						const merged = ((await apiJson("/model-rules")).rules ?? []).filter((r) => r.key !== rule.key);
						merged.push(rule);
						await apiJson("/model-rules", {
							method: "PUT",
							body: JSON.stringify({ rules: merged })
						});
						toast("计费规则已保存");
						catalogData = null;
						await refresh();
					})().catch((e) => toast(String(e).slice(0, 200), true));
				});
				manualView.append(save);
				const smartView = el("div", {});
				const sm = statusData?.settings?.smart ?? {
					enabled: false,
					agentProvider: "",
					agentModel: "",
					sources: []
				};
				if (!sm.enabled) smartView.append(el("div", { class: "dab-hint" }, "智能配置未开启——请先在上方「智能配置」卡启用并选择 Agent 模型。"));
				else {
					const srcList = el("div", {});
					const modelSrcs = Array.isArray(userRule?.smartSources) ? userRule.smartSources : [];
					const rebuildSrcs = () => {
						srcList.replaceChildren();
						if (modelSrcs.length === 0) {
							srcList.append(el("div", { class: "dab-hint" }, "本模型暂无规则源——从下方添加，Agent 将只解析本模型的计费。"));
							return;
						}
						for (const src of modelSrcs) {
							const summary = src.type === "web" ? "🌐 " + (src.url ?? "") + (src.autoDaily ? " · 每日自动更新" : "") : src.type === "text" ? "📝 " + (src.text ?? "").slice(0, 60) : "🖼 截图×" + (src.imageRefs?.length ?? 0);
							const enCb = document.createElement("input");
							enCb.type = "checkbox";
							enCb.checked = src.enabled !== false;
							enCb.addEventListener("change", () => {
								src.enabled = enCb.checked;
							});
							const delBtn = el("button", {
								class: "dab-btn danger",
								style: "padding:3px 10px"
							}, "删");
							delBtn.addEventListener("click", () => {
								modelSrcs.splice(modelSrcs.indexOf(src), 1);
								rebuildSrcs();
							});
							srcList.append(el("div", { class: "dab-btnrow" }, enCb, el("span", {
								class: "dab-hint",
								style: "flex:1; overflow:hidden; text-overflow:ellipsis"
							}, summary), delBtn));
						}
					};
					rebuildSrcs();
					const addType = document.createElement("select");
					for (const [v, t] of [
						["web", "网页源"],
						["text", "文字描述"],
						["image", "截图（可多张）"]
					]) {
						const o = document.createElement("option");
						o.value = v;
						o.textContent = t;
						addType.append(o);
					}
					const urlIn = input("", "https://… 含本模型计费信息的页面");
					const autoDailyCb = document.createElement("input");
					autoDailyCb.type = "checkbox";
					const textTa = document.createElement("textarea");
					textTa.rows = 3;
					textTa.placeholder = "描述本模型的计费规则…";
					textTa.style.width = "100%";
					const fileIn = document.createElement("input");
					fileIn.type = "file";
					fileIn.accept = "image/*";
					fileIn.multiple = true;
					fileIn.style.display = "none";
					const pendingImgs = [];
					const imgState = el("span", { class: "dab-hint" }, "");
					const addArea = el("div", { class: "dab-form" });
					const rebuildAdd = () => {
						addArea.replaceChildren();
						if (addType.value === "web") addArea.append(field("网页 URL", urlIn), field("每日自动更新（Agent 每天解析一次）", autoDailyCb));
						else if (addType.value === "text") addArea.append(field("计费规则描述", textTa, true));
						else {
							if (!agentSupportsVision(sm)) {
								const i = document.createElement("input");
								i.disabled = true;
								i.placeholder = "当前 Agent 模型不支持读图";
								i.style.width = "100%";
								addArea.append(field("选择截图", i));
							} else addArea.append(field("选择截图（png/jpg）", fileIn));
							addArea.append(field("已上传", imgState));
						}
					};
					addType.addEventListener("change", rebuildAdd);
					rebuildAdd();
					fileIn.addEventListener("change", () => {
						(async () => {
							for (const f of [...fileIn.files ?? []]) {
								const b64 = await new Promise((resolve) => {
									const r = new FileReader();
									r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
									r.readAsDataURL(f);
								});
								const r = await apiJson("/smart/upload", {
									method: "POST",
									body: JSON.stringify({
										dataBase64: b64,
										mediaType: f.type || "image/png",
										name: f.name
									})
								});
								pendingImgs.push(r.ref);
							}
							imgState.textContent = `已上传 ${pendingImgs.length} 张`;
						})().catch((e) => toast(String(e).slice(0, 160), true));
					});
					const addBtn = el("button", { class: "dab-btn ghost" }, "＋ 添加源");
					addBtn.addEventListener("click", () => {
						try {
							if (addType.value === "web") {
								if (!urlIn.value.trim()) throw new Error("请填 URL");
								modelSrcs.push({
									id: "s" + Date.now().toString(36),
									type: "web",
									url: urlIn.value.trim(),
									autoDaily: autoDailyCb.checked,
									enabled: true
								});
							} else if (addType.value === "text") {
								if (!textTa.value.trim()) throw new Error("请填描述");
								modelSrcs.push({
									id: "s" + Date.now().toString(36),
									type: "text",
									text: textTa.value.trim(),
									enabled: true
								});
							} else {
								if (pendingImgs.length === 0) throw new Error("请先上传截图");
								modelSrcs.push({
									id: "s" + Date.now().toString(36),
									type: "image",
									imageRefs: [...pendingImgs],
									enabled: true
								});
								pendingImgs.length = 0;
								imgState.textContent = "";
							}
							rebuildSrcs();
						} catch (e) {
							toast(String(e).slice(0, 160), true);
						}
					});
					smartView.append(el("div", { class: "dab-sec" }, `本模型的规则源（${modelSrcs.length}）`), srcList, el("div", { class: "dab-sec" }, "添加源"), addType, addArea, el("div", { class: "dab-btnrow" }, addBtn));
					const runState = userRule?.smartLastRunAt ? el("div", { class: "dab-hint" }, `上次运行：${userRule.smartLastRunAt.slice(5, 16)} ${userRule.smartLastRunOk ? "✓ 成功" : "✗ " + (userRule.smartLastError ?? "").slice(0, 80)}`) : el("div", { class: "dab-hint" }, "尚未为本模型运行过智能配置");
					const runBtn = el("button", { class: "dab-btn" }, "⚡ 立即为本模型执行");
					runBtn.addEventListener("click", () => {
						(async () => {
							const existing = (await apiJson("/model-rules")).rules ?? [];
							const base = existing.find((r) => r.key === ruleKey) ?? {
								key: ruleKey,
								match: {
									provider: provId,
									model: m.id
								},
								label: m.label,
								currency: "CNY",
								base: {},
								source: "smart",
								creditFactor: 1
							};
							base.smartSources = modelSrcs;
							base.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
							const mergedRules = existing.filter((r) => r.key !== ruleKey);
							mergedRules.push(base);
							await apiJson("/model-rules", {
								method: "PUT",
								body: JSON.stringify({ rules: mergedRules })
							});
							toast("Agent 解析中…");
							const r = await apiJson("/smart/run", {
								method: "POST",
								body: JSON.stringify({ modelKey: ruleKey })
							});
							toast(r.ok ? `✓ 完成：产出 ${r.ruleCount} 条规则` : "✗ " + (r.error ?? ""), !r.ok);
							await refresh();
							catalogData = null;
							renderOverlayBody();
						})().catch((e) => toast(String(e).slice(0, 200), true));
					});
					smartView.append(el("div", { class: "dab-btnrow" }, runBtn), runState);
				}
				modeViews.manual = manualView;
				modeViews.smart = smartView;
				panel.append(modeRow, modeArea, manualView);
				return panel;
			};
			const renderList = () => {
				listWrap.replaceChildren();
				const cat = catalogData;
				if (!cat) {
					if (catalogFailed) {
						const retry = el("button", { class: "dab-btn" }, "目录加载失败，点击重试");
						retry.addEventListener("click", () => {
							catalogFailed = false;
							renderOverlayBody();
						});
						listWrap.append(retry);
					} else listWrap.append(el("div", { class: "dab-hint" }, "目录加载中…"));
					ensureCatalog().then(() => {
						if (catalogData) renderOverlayBody();
					});
					return;
				}
				listWrap.append(el("div", { class: "dab-sec" }, "本机已配置 Provider（与会话框模型选择器同源）"));
				let shown = 0;
				for (const g of cat.dsh ?? []) {
					const models = (g.models ?? []).filter((m) => kw === "" || matchQ(g.id) || matchQ(m.id) || matchQ(m.label));
					if (models.length === 0) continue;
					shown += models.length;
					listWrap.append(el("div", {
						class: "dab-sec",
						style: "margin:6px 0 4px"
					}, `${g.name}（${g.id}）`));
					for (const m of models) {
						listWrap.append(renderModelRow(g.id, m));
						if (selectedModelKey === (m.ruleKey ?? g.id + "/" + m.id)) listWrap.append(renderConfigPanel(g.id, m));
					}
				}
				if (shown === 0) listWrap.append(el("div", { class: "dab-hint" }, "无匹配模型（其它模型由内置官方规则库自动计费，无需配置）"));
			};
			renderList();
			return wrap;
		}
		/** 账号档案视图（原 provider 档案：余额实查/折扣/归属） */
		function profilesView() {
			const wrap = el("div", {});
			const chips = el("div", { class: "dab-plist" });
			const newBtn = el("button", {
				class: "dab-btn ghost",
				style: "margin-bottom:10px"
			}, "＋ 新建档案");
			newBtn.addEventListener("click", () => {
				editingProfileId = "__new__";
				renderOverlayBody();
			});
			const hitSet = new Set((statusData?.windows?.month?.byProfile ?? []).map((x) => x.profileId));
			for (const p of profilesData) {
				const hit = hitSet.has(p.id);
				const chip = el("button", { class: `dab-pchip${editingProfileId === p.id ? " active" : ""}` }, `${p.label || p.id} · ${p.providerMatch}${hit ? " · 本月在用" : ""}`);
				chip.addEventListener("click", () => {
					editingProfileId = p.id;
					renderOverlayBody();
				});
				chips.append(chip);
			}
			const hitProfiles = new Set((statusData?.windows?.month?.byProfile ?? []).map((x) => x.profileId));
			wrap.append(el("div", { class: "dab-sec" }, "账号档案（兜底计费 + 余额实查 + 折扣）"), chips, newBtn);
			const editing = editingProfileId === "__new__" ? blankProfile() : profilesData.find((p) => p.id === editingProfileId);
			if (editing) wrap.append(profileForm(editing));
			else {
				const hitHint = profilesData.length > 0 ? `本月被命中：${profilesData.filter((p) => hitProfiles.has(p.id)).map((p) => p.label).join("、") || "（无——计费已全部由模型规则承接）"}` : "尚无档案";
				wrap.append(el("div", { class: "dab-hint" }, "计费优先级：模型计费规则（官方库/手动/智能）→ 账号档案兜底 → 未计费。\n档案只在「模型规则没覆盖的 provider」出现用量时才生效，也可为档案配置余额实查。\n" + hitHint));
			}
			return wrap;
		}
		/** 预算·汇率视图 */
		function budgetView() {
			const wrap = el("div", {});
			const dailyIn = input(statusData?.budgets?.daily?.limit !== null && statusData?.budgets?.daily?.limit !== void 0 ? String(statusData.budgets.daily.limit) : "", "¥/日");
			const monthlyIn = input(statusData?.budgets?.monthly?.limit !== null && statusData?.budgets?.monthly?.limit !== void 0 ? String(statusData.budgets.monthly.limit) : "", "¥/月");
			const refreshIn = input(String(currentRefreshMs), "毫秒（500-60000）");
			const fxIn = input(String(statusData?.settings?.fxUsdToCny ?? 7.2), "如 7.2");
			const saveSettings = el("button", { class: "dab-btn" }, "保存");
			saveSettings.addEventListener("click", () => {
				(async () => {
					const num = (v) => v.trim() === "" ? void 0 : Number(v);
					await apiJson("/settings", {
						method: "PUT",
						body: JSON.stringify({
							budgets: {
								daily: num(dailyIn.value),
								monthly: num(monthlyIn.value)
							},
							refreshMs: num(refreshIn.value) ?? 1e3,
							fx: { usdToCny: num(fxIn.value) ?? 7.2 }
						})
					});
					toast("已保存");
					window.dispatchEvent(new CustomEvent("dab-retune"));
					await refresh();
				})().catch((e) => toast(String(e).slice(0, 160), true));
			});
			wrap.append(el("div", { class: "dab-sec" }, "预算（人民币口径，credit 模型不参与预算）· 刷新 · 汇率"), el("div", { class: "dab-form" }, field("日预算（¥）", dailyIn), field("月预算（¥）", monthlyIn), field("徽标/面板刷新", refreshIn), field("美元→人民币汇率", fxIn)), el("div", { class: "dab-btnrow" }, saveSettings));
			return wrap;
		}
		/** 导入导出视图 */
		function ioView() {
			const wrap = el("div", {});
			const exportBtn = el("button", { class: "dab-btn ghost" }, "导出全部（JSON）");
			exportBtn.addEventListener("click", () => {
				(async () => {
					const data = await apiJson("/export");
					const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
					const a = document.createElement("a");
					a.href = URL.createObjectURL(blob);
					a.download = `dsh-agent-billing-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`;
					a.click();
					URL.revokeObjectURL(a.href);
				})().catch((e) => toast(String(e).slice(0, 160), true));
			});
			const fileIn = document.createElement("input");
			fileIn.type = "file";
			fileIn.accept = "application/json";
			fileIn.style.display = "none";
			fileIn.addEventListener("change", () => {
				(async () => {
					const file = fileIn.files?.[0];
					if (!file) return;
					const data = JSON.parse(await file.text());
					await apiJson("/import", {
						method: "POST",
						body: JSON.stringify({
							profiles: data.profiles,
							replaceSamples: data.samples ? { samples: data.samples } : void 0
						})
					});
					toast("导入完成");
					await reloadProfiles();
					await refresh();
				})().catch((e) => toast(String(e).slice(0, 160), true));
			});
			const importBtn = el("button", { class: "dab-btn ghost" }, "导入（合并档案/替换账本）");
			importBtn.addEventListener("click", () => fileIn.click());
			wrap.append(el("div", { class: "dab-sec" }, "导入 / 导出"), el("div", { class: "dab-btnrow" }, exportBtn, importBtn, fileIn));
			if ((statusData?.degraded ?? []).length > 0) wrap.append(el("div", { class: "dab-degraded" }, `诊断：
${(statusData?.degraded ?? []).join("\n")}`));
			wrap.append(el("div", {
				class: "dab-hint",
				style: "margin-top:14px"
			}, `账本与配置存储在 DSH_HOME/dsh-agent-billing/（ledger.sqlite / profiles.json / settings.json / model-rules.json）。卸载插件不删数据，重装即恢复。dsh-agent-billing v${statusData?.version ?? "?"}`));
			return wrap;
		}
		function validateClient(rule) {
			if (!rule.key || typeof rule.key !== "string") throw new Error("规则 key 缺失");
			if (![
				"CNY",
				"USD",
				"credit"
			].includes(rule.currency)) throw new Error("币种非法：" + rule.currency);
			if (rule.currency === "credit" && !(Number(rule.creditFactor) > 0)) throw new Error("credit 币种必须填写 credit 系数");
		}
		async function loadRules() {
			try {
				rulesData = (await apiJson("/model-rules")).rules ?? [];
			} catch {
				rulesData = [];
			}
		}
		async function reloadProfiles() {
			try {
				profilesData = (await apiJson("/profiles")).profiles ?? [];
			} catch {
				profilesData = [];
			}
		}
		let overlayRendering = false;
		function renderOverlayBody() {
			if (overlayRendering) return;
			overlayRendering = true;
			try {
				for (const overlay of [...overlayEls]) {
					if (!overlay.isConnected) {
						overlayEls.delete(overlay);
						continue;
					}
					const body = overlay.querySelector(".dab-body");
					if (!body) continue;
					const win = statusData?.windows?.[activeWindow];
					body.replaceChildren();
					if (!statusData) {
						body.append(el("div", { class: "dab-hint" }, "连接 Host 中…"));
						continue;
					}
					if (activeTab === "overview" && win) body.append(...overviewTab(win));
					else if (activeTab === "detail" && win) body.append(...detailTab(win));
					else if (activeTab === "sessions") body.append(...sessionsTab());
					else if (activeTab === "settings") body.append(settingsTab());
				}
			} finally {
				overlayRendering = false;
			}
		}
		function buildOverlay() {
			ensureStyle();
			const root = el("div", { class: "dab-overlay" });
			root.style.cssText = "position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;";
			const setOpen = (open) => {
				overlayOpen = open;
				root.classList.toggle("open", open);
				root.style.display = open ? "flex" : "none";
			};
			const body = el("div", { class: "dab-body" });
			const winSwitch = el("div", { class: "dab-win" });
			const tabbar = el("div", { class: "dab-tabs" });
			const tabs = [
				["overview", "概览"],
				["detail", "明细"],
				["sessions", "会话"],
				["settings", "设置"]
			];
			const wins = [
				["today", "今日"],
				["month", "本月"],
				["total", "累计"]
			];
			const rebuild = () => {
				tabbar.replaceChildren(...tabs.map(([key, label]) => {
					const b = el("button", { class: `dab-tab${activeTab === key ? " active" : ""}` }, label);
					b.addEventListener("click", () => {
						activeTab = key;
						if (key === "settings") reloadProfiles().then(renderOverlayBody);
						rebuild();
						renderOverlayBody();
					});
					return b;
				}));
				winSwitch.replaceChildren(...wins.map(([key, label]) => {
					const b = el("button", { class: `dab-win-item${activeWindow === key ? " active" : ""}` }, label);
					if (activeWindow === key) b.classList.add("active");
					b.addEventListener("click", () => {
						activeWindow = key;
						rebuild();
						renderOverlayBody();
					});
					return b;
				}));
			};
			rebuild();
			root.addEventListener("click", (e) => {
				if (e.target === root) setOpen(false);
			});
			const onToggle = () => {
				setOpen(!overlayOpen);
				if (overlayOpen) {
					if (activeTab === "settings") reloadProfiles();
					refresh();
				}
			};
			const onKey = (e) => {
				if (e.key === "Escape" && overlayOpen) setOpen(false);
			};
			window.addEventListener(TOGGLE_EVENT, onToggle);
			window.addEventListener("keydown", onKey);
			root.__dabDispose = () => {
				window.removeEventListener(TOGGLE_EVENT, onToggle);
				window.removeEventListener("keydown", onKey);
			};
			const panel = el("div", { class: "dab-panel" }, el("div", { class: "dab-head" }, el("span", { class: "dab-title" }, "◈ AGENT BILLING"), tabbar, winSwitch, el("button", {
				class: "dab-close",
				onclick: () => setOpen(false)
			}, "✕")), body);
			root.append(panel);
			overlayEls.add(root);
			root.__dabMount = () => renderOverlayBody();
			return root;
		}
		function toast(message, isError = false) {
			document.getElementById("dab-toast")?.remove();
			const node = el("div", {
				class: `dab-toast${isError ? " err" : ""}`,
				id: "dab-toast"
			}, message);
			document.body.append(node);
			if (toastTimer !== null) clearTimeout(toastTimer);
			toastTimer = setTimeout(() => node.remove(), 3200);
		}
		function apply(ctx) {
			ensureStyle();
			ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: `${NS}:badge`,
				order: -2
			}, function BillingBadge() {
				return react.default.createElement(VanillaSlot, { build: buildBadge });
			})), `${NS}:badge`);
			ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: `${NS}:overlay`,
				order: 100
			}, function BillingOverlay() {
				return react.default.createElement(VanillaSlot, { build: buildOverlay });
			})), `${NS}:overlay`);
			startPolling(ctx);
			reloadProfiles();
			loadRules();
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map