import { memo, useEffect, useState, useCallback, useRef } from "react";
import {
	FiCheck,
	FiChevronDown,
	FiChevronUp,
	FiChevronsLeft,
	FiEdit2,
	FiFolder,
	FiMessageSquare,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import type { ConversationSummary, ProjectSummary, SessionSummary } from "../types";
import { useT } from "../i18n";
import { useAppField } from "../app-globals";
import { applySashDrag, parseWeights } from "../panel-sash";
import { groupConversations } from "../conv-groups";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  this entire panel during streaming instead of re-reconciling the file tree
 *  and conversation lists on every delta. Add a prop here when adding a chat
 *  field usage — TypeScript enforces it at the call site. */
interface LeftPanelProps {
	sessionFile: string | null;
	conversations: ConversationSummary[];
	sessions: SessionSummary[];
	projects: ProjectSummary[];
	activeConversationId: string;
	panelSend: (
		msg:
			| { type: "new_chat" }
			| { type: "list_sessions" }
			| { type: "list_projects" }
			| { type: "switch_session"; path: string }
			| { type: "switch_conversation"; id: string }
			| { type: "set_cwd"; path: string }
			| { type: "remove_project"; path: string }
			| { type: "delete_session"; path: string }
			| { type: "rename_session"; path: string; name: string }
			| { type: "rename_conversation"; id: string; name: string }
			| { type: "dismiss_conversation"; id: string; withFinishedSubagents?: boolean; force?: boolean }
			| { type: "dismiss_finished_subagents"; parentId?: string },
	) => boolean;
	/** True while the panel is actually on screen (desktop: always; mobile:
	 *  only while the drawer is open). Drives lazy loading of the session
	 *  list + recent projects — both scan session files on disk. */
	active: boolean;
	/** Desktop: show the collapse button (mobile drawers close via the topbar). */
	collapsible?: boolean;
	/** Fired when the user clicks the collapse button. */
	onToggleCollapse?: () => void;
}

function formatModified(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	if (sameDay) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

const LS_COLLAPSE_PROJECTS = "pi-web-ui:lp-collapse-projects";
const LS_COLLAPSE_CONVS = "pi-web-ui:lp-collapse-convs";
const LS_COLLAPSE_SESSIONS = "pi-web-ui:lp-collapse-sessions";

function useCollapsed(key: string, defaultCollapsed = false): [boolean, () => void] {
	const [collapsed, setCollapsed] = useState(() => {
		try {
			const v = localStorage.getItem(key);
			if (v === "1") return true;
			if (v === "0") return false;
		} catch {}
		return defaultCollapsed;
	});
	const toggle = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(key, next ? "1" : "0");
			} catch {}
			return next;
		});
	}, [key]);
	return [collapsed, toggle];
}

/* VSCode 风格可拖拽分割：展开区的 flex-grow 权重持久化，折叠区不占空间 */
const LS_LP_SIZES = "pi-web-ui:lp-sizes";
type LpWeights = { projects: number; convs: number; sessions: number };
const DEFAULT_LP_WEIGHTS: LpWeights = { projects: 1, convs: 1, sessions: 1 };
/** 折叠区仅留标题高度（与 styles.css 的 .lp-section.collapsed 对齐）。 */
const LP_COLLAPSED_HEADER_PX = 32;
/** 展开区最小高度（≈3 行，与 styles.css 的 .lp-section min-height 对齐）。 */
const LP_MIN_SECTION_PX = 72;
/** 存档解析与拖动换算都是纯函数，与右栏共用（见 `../panel-sash`）。 */
function loadLpWeights(): LpWeights {
	try {
		return parseWeights(localStorage.getItem(LS_LP_SIZES), DEFAULT_LP_WEIGHTS);
	} catch {
		// localStorage 不可用（隐私模式/SSR）→ 默认权重
		return { ...DEFAULT_LP_WEIGHTS };
	}
}

export const LeftPanel = memo(function LeftPanel({
	sessionFile,
	conversations,
	sessions,
	projects,
	activeConversationId,
	panelSend,
	active,
	collapsible,
	onToggleCollapse,
}: LeftPanelProps) {
	const t = useT();
	const currentFile = sessionFile;
	// 连接态与当前工作目录走全局（web/src/app-globals.ts），不再从 App 传
	// —— 这三个值整棵树都要，传参只会越传越漏。
	const ready = useAppField("ready");
	const status = useAppField("status");
	const cwd = useAppField("cwd");
	const currentCwd = cwd;
	const [confirmDel, setConfirmDel] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [collapseProjects, toggleProjects] = useCollapsed(LS_COLLAPSE_PROJECTS, false);
	const [collapseConvs, toggleConvs] = useCollapsed(LS_COLLAPSE_CONVS, false);
	const [collapseSessions, toggleSessions] = useCollapsed(LS_COLLAPSE_SESSIONS, false);
	/** 运行对话区右键菜单：scopeId 缺省 = 全部已结束子代理；否则 = 该对话下
	 *  的子代理子树（含自身是子代理时）——递归延伸到子代的子代。 */
	const [convCtx, setConvCtx] = useState<{ x: number; y: number; scopeId?: string } | null>(null);
	/** 右键菜单强行关闭项的两段确认：存已 arm 的 scopeId。 */
	const [forceArmed, setForceArmed] = useState<string | null>(null);
	const closeConvCtx = useCallback(() => {
		setForceArmed(null);
		setConvCtx(null);
	}, []);
	const openConvCtx = useCallback((e: React.MouseEvent, scopeId?: string) => {
		e.preventDefault();
		e.stopPropagation();
		setConvCtx({
			x: Math.min(e.clientX, window.innerWidth - 260),
			y: Math.min(e.clientY, window.innerHeight - 120),
			scopeId,
		});
	}, []);
	useEffect(() => {
		if (!convCtx) return;
		const onDown = (e: MouseEvent) => {
			if ((e.target as Element | null)?.closest(".ctx-menu")) return;
			closeConvCtx();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeConvCtx();
		};
		window.addEventListener("mousedown", onDown, true);
		window.addEventListener("keydown", onKey);
		window.addEventListener("blur", closeConvCtx);
		return () => {
			window.removeEventListener("mousedown", onDown, true);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("blur", closeConvCtx);
		};
	}, [convCtx, closeConvCtx]);
	/** scope 内已结束（非 streaming、非当前）的子代理数量——后端按同样口径
	 *  批量移出；为 0 时菜单项禁用。 */
	const finishedSubagentCount = useCallback(
		(list: ConversationSummary[], scopeId?: string): number => {
			if (!scopeId) return list.filter((c) => c.isSubagent && !c.isStreaming && c.id !== activeConversationId).length;
			const byId = new Map(list.map((c) => [c.id, c]));
			const inScope = (c: ConversationSummary): boolean => {
				if (c.id === scopeId)
					return (byId.get(scopeId)?.isSubagent ?? false) && !c.isStreaming && c.id !== activeConversationId;
				let cur: ConversationSummary | undefined = c;
				const seen = new Set<string>();
				while (cur?.parentId) {
					if (cur.parentId === scopeId) return true;
					if (seen.has(cur.parentId)) return false;
					seen.add(cur.parentId);
					cur = byId.get(cur.parentId);
					if (!cur) return false;
				}
				return false;
			};
			return list.filter((c) => c.isSubagent && !c.isStreaming && c.id !== activeConversationId && inScope(c)).length;
		},
		[activeConversationId],
	);

	/** scope 内全部子代理后代数量（不限状态：运行中/已结束/保留中都算）——
	 *  强行全关按钮的计数口径；口径与 finishedSubagentCount 的 inScope 一致。 */
	const countScopeSubagents = useCallback((list: ConversationSummary[], scopeId?: string): number => {
		if (!scopeId) return list.filter((c) => c.isSubagent).length;
		const byId = new Map(list.map((c) => [c.id, c]));
		const inScope = (c: ConversationSummary): boolean => {
			if (c.id === scopeId) return byId.get(scopeId)?.isSubagent ?? false;
			let cur: ConversationSummary | undefined = c;
			const seen = new Set<string>();
			while (cur?.parentId) {
				if (cur.parentId === scopeId) return true;
				if (seen.has(cur.parentId)) return false;
				seen.add(cur.parentId);
				cur = byId.get(cur.parentId);
				if (!cur) return false;
			}
			return false;
		};
		return list.filter((c) => c.isSubagent && inScope(c)).length;
	}, []);

	/** scope 下运行中（streaming）的子代理后代数量——混合情况
	 *  （有运行、也有已结束）同样提示连带关闭，但只关不运行的：
	 *  运行中的不受影响、父对话暂留。口径与 finishedSubagentCount 的 inScope 一致。 */
	const countRunningSubagentDescendants = useCallback((list: ConversationSummary[], scopeId?: string): number => {
		if (!scopeId) return 0;
		const byId = new Map(list.map((c) => [c.id, c]));
		const inScope = (c: ConversationSummary): boolean => {
			let cur: ConversationSummary | undefined = c;
			const seen = new Set<string>();
			while (cur?.parentId) {
				if (cur.parentId === scopeId) return true;
				if (seen.has(cur.parentId)) return false;
				seen.add(cur.parentId);
				cur = byId.get(cur.parentId);
				if (!cur) return false;
			}
			return false;
		};
		return list.filter((c) => c.isSubagent && c.isStreaming && inScope(c)).length;
	}, []);

	const panelRef = useRef<HTMLElement>(null);
	const [weights, setWeights] = useState<LpWeights>(() => loadLpWeights());
	useEffect(() => {
		try {
			localStorage.setItem(LS_LP_SIZES, JSON.stringify(weights));
		} catch {}
	}, [weights]);

	const createSashHandler = useCallback(
		(aboveKey: keyof LpWeights, belowKey: keyof LpWeights) => (e: React.PointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const target = e.currentTarget;
			const startY = e.clientY;
			const start = { ...weights };
			const panel = panelRef.current;
			if (!panel) return;
			const visibleMeta = [
				{ key: "projects" as const, visible: projects.length > 0, collapsed: collapseProjects },
				{ key: "convs" as const, visible: conversations.length > 0, collapsed: collapseConvs },
				{ key: "sessions" as const, visible: true, collapsed: collapseSessions },
			].filter((s) => s.visible);
			const collapsedCount = visibleMeta.filter((s) => s.collapsed).length;
			const expandedKeys = visibleMeta.filter((s) => !s.collapsed).map((s) => s.key);
			const totalWeight = expandedKeys.reduce((sum, k) => sum + (start[k] ?? 1), 0) || 1;
			const available = Math.max(120, panel.clientHeight - collapsedCount * LP_COLLAPSED_HEADER_PX);
			target.classList.add("dragging");
			document.body.classList.add("lp-resizing");
			const onMove = (ev: PointerEvent) => {
				const { above, below } = applySashDrag({
					start: { above: start[aboveKey] ?? 1, below: start[belowKey] ?? 1 },
					deltaPx: ev.clientY - startY,
					availablePx: available,
					totalWeight,
					minAbovePx: LP_MIN_SECTION_PX,
					minBelowPx: LP_MIN_SECTION_PX,
				});
				setWeights((prev) => ({ ...prev, [aboveKey]: above, [belowKey]: below }));
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				target.classList.remove("dragging");
				document.body.classList.remove("lp-resizing");
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[weights, projects.length, conversations.length, collapseProjects, collapseConvs, collapseSessions],
	);

	useEffect(() => {
		if (!active || !ready || status !== "open") return;
		if (!cwd) return;
		panelSend({ type: "list_sessions" });
		panelSend({ type: "list_projects" });
	}, [active, ready, status, cwd, panelSend]);

	const displayName = (s: SessionSummary): string => {
		const title = s.name || s.firstMessage.trim();
		return title.length > 0 ? title : t("emptyChat");
	};

	const projectName = (path: string): string => path.split(/[\\/]/).pop() || path;

	const delButton = (key: string, hint: string, confirmHint: string, onConfirm: () => void, icon?: React.ReactNode) => {
		const armed = confirmDel === key;
		return (
			<button
				type="button"
				className={`lp-del ${armed ? "confirm" : ""}`}
				title={armed ? confirmHint : hint}
				onClick={(e) => {
					e.stopPropagation();
					if (armed) {
						setConfirmDel(null);
						onConfirm();
					} else {
						setConfirmDel(key);
					}
				}}
			>
				{armed ? <FiCheck /> : (icon ?? <FiTrash2 />)}
			</button>
		);
	};

	const sectionHeader = (title: string, collapsed: boolean, onToggle: () => void, count?: number) => (
		<button
			type="button"
			className="lp-section-title panel-section-title"
			onClick={onToggle}
			title={collapsed ? t("expandSection") : t("collapseSection")}
		>
			<span className="lp-section-title-text">
				{title}
				{count !== undefined ? ` (${count})` : ""}
			</span>
			<span className="lp-section-chevron">{collapsed ? <FiChevronDown /> : <FiChevronUp />}</span>
		</button>
	);

	// 归一化权重：单展开时强制 flex=1 填满；多展开时按权重比例均值归一，避免 0.539 这类小数导致容器留空
	const visibleMetaForFlex = [
		{ key: "projects" as const, visible: projects.length > 0, collapsed: collapseProjects },
		{ key: "convs" as const, visible: conversations.length > 0, collapsed: collapseConvs },
		{ key: "sessions" as const, visible: true, collapsed: collapseSessions },
	].filter((s) => s.visible);
	const expandedForFlex = visibleMetaForFlex.filter((s) => !s.collapsed);
	const totalWeightForFlex = expandedForFlex.reduce((sum, k) => sum + (weights[k.key] ?? 1), 0) || 1;
	const effFlex = (k: keyof LpWeights) => {
		if (expandedForFlex.length <= 1) return 1;
		const w = weights[k] ?? 1;
		return (w / totalWeightForFlex) * expandedForFlex.length;
	};

	return (
		<aside ref={panelRef as React.RefObject<HTMLDivElement>} className="panel panel-left lp-panel">
			{collapsible && onToggleCollapse && (
				<button type="button" className="panel-collapse-btn" title={t("collapsePanel")} onClick={onToggleCollapse}>
					<FiChevronsLeft />
				</button>
			)}
			{/* Recent projects — collapsible, flex share */}
			{projects.length > 0 && (
				<div
					className={`lp-section panel-projects ${collapseProjects ? "collapsed" : ""}`}
					style={!collapseProjects ? { flex: `${effFlex("projects")} 1 0px` } : undefined}
				>
					{sectionHeader(t("recentProjects"), collapseProjects, toggleProjects, projects.length)}
					{!collapseProjects && (
						<div className="lp-section-body projects-scroll">
							{projects.map((p) => {
								const active = currentCwd === p.path;
								return (
									<div
										className="lp-row"
										key={p.path}
										onMouseLeave={() => setConfirmDel((k) => (k === `proj:${p.path}` ? null : k))}
									>
										<button
											type="button"
											className={`project-item ${active ? "active" : ""}`}
											title={p.path}
											onClick={() => {
												if (!active) panelSend({ type: "set_cwd", path: p.path });
											}}
										>
											<FiFolder className="project-icon" />
											<span className="project-info">
												<span className="project-name">{projectName(p.path)}</span>
												<span className="project-path">{p.path}</span>
											</span>
											<span className="project-time">{formatModified(p.lastUsed)}</span>
										</button>
										{delButton(`proj:${p.path}`, t("deleteProject"), t("deleteProjectConfirm"), () =>
											panelSend({ type: "remove_project", path: p.path }),
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			)}
			{/* sash: projects ↔ next */}
			{projects.length > 0 && !collapseProjects && (conversations.length > 0 ? !collapseConvs : !collapseSessions) && (
				<div
					className="lp-sash"
					onPointerDown={createSashHandler("projects", conversations.length > 0 ? "convs" : "sessions")}
					onDoubleClick={() => setWeights({ ...DEFAULT_LP_WEIGHTS })}
					title={t("dragToResize")}
				/>
			)}

			{/* Running conversations — collapsible, flex share. Hidden when empty to keep old layout expectations. */}
			{conversations.length > 0 && (
				<div
					className={`lp-section lp-section-convs panel-convs ${collapseConvs ? "collapsed" : ""}`}
					style={!collapseConvs ? { flex: `${effFlex("convs")} 1 0px` } : undefined}
					onContextMenu={(e) => openConvCtx(e)}
				>
					{sectionHeader(t("runningConversations"), collapseConvs, toggleConvs, conversations.length)}
					{!collapseConvs && (
						<div className="lp-section-body convs-scroll">
							{groupConversations(conversations, cwd, activeConversationId).map((g) => (
								<div key={g.cwd} className="panel-conv-group">
									{!g.isCurrent && (
										<div className="panel-conv-group-title" title={g.cwd}>
											{projectName(g.cwd)}
										</div>
									)}
									{(() => {
										const byId = new Map(g.convs.map((x) => [x.id, x]));
										const kids = new Map<string, ConversationSummary[]>();
										const roots: ConversationSummary[] = [];
										for (const x of g.convs) {
											if (x.parentId && byId.has(x.parentId)) {
												const arr = kids.get(x.parentId) ?? [];
												arr.push(x);
												kids.set(x.parentId, arr);
											} else roots.push(x);
										}
										const rows: { c: ConversationSummary; depth: number }[] = [];
										const seen = new Set<string>();
										const append = (c: ConversationSummary, depth: number) => {
											if (seen.has(c.id)) return;
											seen.add(c.id);
											rows.push({ c, depth });
											for (const child of kids.get(c.id) ?? []) append(child, depth + 1);
										};
										for (const root of roots) append(root, 0);
										for (const orphan of g.convs) append(orphan, 0);
										return rows.map(({ c, depth }) => {
											const active = activeConversationId === c.id;
											return (
												<div
													className={`lp-row${depth > 0 ? " lp-sub" : ""}`}
													key={c.id}
													style={depth > 0 ? { marginLeft: depth * 18 } : undefined}
													onMouseLeave={() => setConfirmDel((k) => (k === `conv:${c.id}` ? null : k))}
													onContextMenu={(e) => openConvCtx(e, c.id)}
												>
													<button
														type="button"
														className={`session-item ${active ? "active" : ""}`}
														title={`${c.title}${g.isCurrent ? "" : ` — ${g.cwd}`}`}
														onClick={() => {
															if (!active) panelSend({ type: "switch_conversation", id: c.id });
														}}
													>
														<FiMessageSquare className="session-icon" />
														<span className="session-info">
															{renaming === `conv:${c.id}` ? (
																<input
																	autoFocus
																	className="session-rename-input"
																	value={renameDraft}
																	placeholder={t("renameSessionPlaceholder")}
																	onClick={(e) => e.stopPropagation()}
																	onChange={(e) => setRenameDraft(e.target.value)}
																	onKeyDown={(e) => {
																		e.stopPropagation();
																		if (e.key === "Enter" && !e.nativeEvent.isComposing) {
																			const name = renameDraft.trim();
																			if (name) panelSend({ type: "rename_conversation", id: c.id, name });
																			setRenaming(null);
																		} else if (e.key === "Escape") {
																			setRenaming(null);
																		}
																	}}
																	onBlur={() => setRenaming(null)}
																/>
															) : (
																<span className="session-title">
																	{c.isSubagent && <span className="subagent-badge">{t("subagentBadge")}</span>}
																	{c.title}
																	{c.error && (
																		<span
																			className="conv-error-badge"
																			title={t("convErrorBadge", { error: c.error })}
																		/>
																	)}
																</span>
															)}
															{renaming === `conv:${c.id}` ? null : (
																<span className="session-sub">
																	{active ? t("current") : t("messageCount", { n: c.messageCount })}
																</span>
															)}
														</span>
														{c.isStreaming && <span className="conv-streaming" title={t("streaming")} />}
													</button>
													<button
														type="button"
														className="lp-del lp-rename"
														title={t("renameSession")}
														onClick={(e) => {
															e.stopPropagation();
															setConfirmDel(null);
															setRenameDraft(c.title);
															setRenaming(`conv:${c.id}`);
														}}
													>
														<FiEdit2 />
													</button>
													{(() => {
														const key = `conv:${c.id}`;
														const armed = confirmDel === key;
														const nFinished = finishedSubagentCount(conversations, c.id);
														const nRunning = countRunningSubagentDescendants(conversations, c.id);
														const nAll = countScopeSubagents(conversations, c.id);
														// 无子代理 + 空闲：两段确认直接移出（active 也可，后端自动让出）。
														if (nAll === 0 && !c.isStreaming) {
															return delButton(
																key,
																t("dismissConversation"),
																t("dismissConversationConfirm"),
																() => panelSend({ type: "dismiss_conversation", id: c.id }),
																<FiX />,
															);
														}
														// 无子代理 + 运行中：两段确认强行关闭（中止本轮）。
														if (nAll === 0) {
															return delButton(
																key,
																t("dismissConversation"),
																t("dismissStreamingConfirm"),
																() => panelSend({ type: "dismiss_conversation", id: c.id, force: true }),
																<FiX />,
															);
														}
														// 有子代理后代：点 X 展开两个选项（只关已结束 / 强行全关）。
														if (!armed) {
															return (
																<button
																	type="button"
																	className="lp-del"
																	title={t("dismissConversation")}
																	onClick={(e) => {
																		e.stopPropagation();
																		setConfirmDel(key);
																	}}
																>
																	<FiX />
																</button>
															);
														}
														return (
															<span className="lp-del-group">
																{nFinished > 0 && (
																	<button
																		type="button"
																		className="lp-del-opt"
																		title={t("dismissFinishedSubagentsScoped", { n: nFinished })}
																		onClick={(e) => {
																			e.stopPropagation();
																			setConfirmDel(null);
																			panelSend({ type: "dismiss_finished_subagents", parentId: c.id });
																		}}
																	>
																		{t("dismissFinishedOnly", { n: nFinished })}
																	</button>
																)}
																<button
																	type="button"
																	className="lp-del-opt danger"
																	title={t("forceDismissTitle", { n: nAll, m: nRunning })}
																	onClick={(e) => {
																		e.stopPropagation();
																		setConfirmDel(null);
																		panelSend({ type: "dismiss_conversation", id: c.id, force: true });
																	}}
																>
																	{t("dismissForceAll", { n: nAll })}
																</button>
															</span>
														);
													})()}
													{c.isStreaming && (
														<span
															className="lp-row-stalled"
															title={t("streaming")}
															style={{ position: "absolute", right: 28, top: "50%", transform: "translateY(-50%)" }}
														/>
													)}
												</div>
											);
										});
									})()}
								</div>
							))}
						</div>
					)}
				</div>
			)}
			{/* sash: convs ↔ sessions */}
			{conversations.length > 0 && !collapseConvs && !collapseSessions && (
				<div
					className="lp-sash"
					onPointerDown={createSashHandler("convs", "sessions")}
					onDoubleClick={() => setWeights({ ...DEFAULT_LP_WEIGHTS })}
					title={t("dragToResize")}
				/>
			)}

			{/* History sessions — collapsible, flex share, takes remaining */}
			<div
				className={`lp-section lp-section-sessions panel-sessions ${collapseSessions ? "collapsed" : ""}`}
				style={!collapseSessions ? { flex: `${effFlex("sessions")} 1 0px` } : undefined}
			>
				{sectionHeader(t("historySessions"), collapseSessions, toggleSessions, sessions.length)}
				{!collapseSessions && (
					<div className="lp-section-body sessions-scroll">
						{sessions.length === 0 && <div className="panel-empty">{t("noHistory")}</div>}
						{sessions.map((s) => {
							const active = currentFile === s.path;
							return (
								<div
									className="lp-row"
									key={s.path}
									onMouseLeave={() => setConfirmDel((k) => (k === `sess:${s.path}` ? null : k))}
								>
									<button
										type="button"
										className={`session-item ${active ? "active" : ""}`}
										title={s.path}
										onClick={() => {
											if (renaming) return;
											if (!active) panelSend({ type: "switch_session", path: s.path });
										}}
									>
										<FiMessageSquare className="session-icon" />
										<span className="session-info">
											{renaming === s.path ? (
												<input
													autoFocus
													className="session-rename-input"
													value={renameDraft}
													placeholder={t("renameSessionPlaceholder")}
													onClick={(e) => e.stopPropagation()}
													onChange={(e) => setRenameDraft(e.target.value)}
													onKeyDown={(e) => {
														e.stopPropagation();
														if (e.key === "Enter" && !e.nativeEvent.isComposing) {
															const name = renameDraft.trim();
															if (name) panelSend({ type: "rename_session", path: s.path, name });
															setRenaming(null);
														} else if (e.key === "Escape") {
															setRenaming(null);
														}
													}}
													onBlur={() => setRenaming(null)}
												/>
											) : (
												<span className="session-title">{displayName(s)}</span>
											)}
											{renaming === s.path ? null : (
												<span className="session-sub">
													{active ? t("current") : t("messageCount", { n: s.messageCount })}
													{s.source === "tui" && (
														<span className="session-src" title={t("tuiTip")}>
															TUI
														</span>
													)}
												</span>
											)}
										</span>
										<span className="session-time">{formatModified(s.modified)}</span>
									</button>
									<button
										type="button"
										className="lp-del lp-rename"
										title={t("renameSession")}
										onClick={(e) => {
											e.stopPropagation();
											setConfirmDel(null);
											setRenameDraft(s.name ?? "");
											setRenaming(s.path);
										}}
									>
										<FiEdit2 />
									</button>
									{delButton(`sess:${s.path}`, t("deleteSession"), t("deleteSessionConfirm"), () =>
										panelSend({ type: "delete_session", path: s.path }),
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
			{convCtx && (
				<div
					className="ctx-menu"
					style={{ left: convCtx.x, top: convCtx.y }}
					onContextMenu={(e) => {
						e.preventDefault();
						e.stopPropagation();
					}}
				>
					<button
						type="button"
						className="ctx-item"
						title={finishedSubagentCount(conversations, convCtx.scopeId) === 0 ? t("noFinishedSubagents") : undefined}
						disabled={finishedSubagentCount(conversations, convCtx.scopeId) === 0}
						onClick={() => {
							if (convCtx.scopeId) panelSend({ type: "dismiss_finished_subagents", parentId: convCtx.scopeId });
							else panelSend({ type: "dismiss_finished_subagents" });
							closeConvCtx();
						}}
					>
						<FiX />
						<span>
							{finishedSubagentCount(conversations, convCtx.scopeId) === 0
								? t("noFinishedSubagents")
								: convCtx.scopeId
									? t("dismissFinishedSubagentsScoped", { n: finishedSubagentCount(conversations, convCtx.scopeId) })
									: t("dismissFinishedSubagents", { n: finishedSubagentCount(conversations, convCtx.scopeId) })}
						</span>
					</button>
					{convCtx.scopeId && (
						<button
							type="button"
							className={forceArmed === convCtx.scopeId ? "ctx-item danger armed" : "ctx-item danger"}
							title={forceArmed === convCtx.scopeId ? t("forceDismissConfirm") : t("forceDismissConversation")}
							onClick={() => {
								const scope = convCtx.scopeId as string;
								if (forceArmed === scope) {
									panelSend({ type: "dismiss_conversation", id: scope, force: true });
									setForceArmed(null);
									closeConvCtx();
								} else {
									setForceArmed(scope);
								}
							}}
						>
							<FiX />
							<span>{forceArmed === convCtx.scopeId ? t("forceDismissConfirm") : t("forceDismissConversation")}</span>
						</button>
					)}
				</div>
			)}
		</aside>
	);
});
