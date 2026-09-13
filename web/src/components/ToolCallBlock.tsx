import { memo, useState } from "react";
import {
	FiArrowRight,
	FiCheck,
	FiCheckCircle,
	FiChevronDown,
	FiChevronRight,
	FiClock,
	FiCopy,
	FiLoader,
	FiMinus,
	FiSquare,
	FiTerminal,
	FiX,
} from "react-icons/fi";
import type { ToolStatus, UiMessage, UiToolCallBlock } from "../types";
import { useT } from "../i18n";
import { parseDelegateArgs, shortenPath, toolArgHints, type DelegateField } from "../tool-args";

export interface ToolView {
	/** Tool result message if the tool already finished. */
	result?: UiMessage;
	/** Live output accumulated from tool_delta while running. */
	liveOutput?: string;
	/** True when the session is streaming (tool may still be running). */
	streaming: boolean;
	/** Set the moment tool_execution_end fires (tool_status) — the command
	 *  exited but the model hasn't responded yet. */
	status?: ToolStatus;
}

/** Kill just the running bash command(s) — the agent run itself continues. */
export type KillBashHandler = () => void;

const TOOL_ICONS: Record<string, string> = {
	bash: "$",
	delegate_task: "◈",
	read: "📄",
	write: "✍️",
	edit: "✏️",
	edit_soft: "✏️",
	grep: "🔍",
	find: "🧭",
	ls: "📂",
};

function toolIcon(name: string): string {
	return TOOL_ICONS[name] ?? "🛠";
}

export const ToolCallBlock = memo(function ToolCallBlock({
	block,
	view,
	onKillBash,
	wrap = true,
	forceOpen = false,
}: {
	block: UiToolCallBlock;
	view: ToolView;
	/** Kill the running bash command (bash cards only, while running). */
	onKillBash?: KillBashHandler;
	/** 设置面板「完整显示工具」开关：true（开）→ 工具始终完整展开；
	 *  false（关）→ 默认折叠，点击展开。 */
	wrap?: boolean;
	/** 会话内搜索打开时强制展开（折叠内容不在 DOM，搜索索引搜到的词会
	 *  “展开后看不到”——见 ThinkingBlock.forceOpen）。 */
	forceOpen?: boolean;
}) {
	const t = useT();
	// null = 未手动点过 → 跟随开关：wrap=true（开）→ 全部展开；wrap=false（关）→ 全部折叠。
	// 与 ThinkingBlock 一致——开关切换时自动折叠/展开所有未手动点过的工具。
	const [open, setOpen] = useState<boolean | null>(null);
	const expanded = open ?? wrap;
	// 搜索期间 forceOpen 只是“视口展开”，用户 open 状态不受影响
	const shown = expanded || forceOpen;
	const [copied, setCopied] = useState(false);

	const running = !view.result && view.streaming && !view.status;
	const isBashRunning = block.name === "bash" && running;
	const done = view.result !== undefined;
	/** Command finished (tool_status fired) but the authoritative toolResult
	 *  message hasn't landed in a snapshot yet — the model is still chewing on
	 *  the result. */
	const waitingModel = !view.result && !!view.status;
	const isError = view.result?.isError ?? view.status?.isError ?? false;

	const rawOutput = view.result
		? view.result.content.map((b) => (b.type === "text" ? b.text : "")).join("")
		: (view.liveOutput ?? "");
	const output = rawOutput.replace(/…\[LIVE_OMIT:(\d+)\]…\n/, (_, n) => t("liveOutputOmitted", { n }));
	const isDelegate = block.name === "delegate_task";
	const delegateArgs = isDelegate ? parseDelegateArgs(block.argumentsText) : {};
	// 跳到子代理对话：首选结果 details 里的 convId（服务端拼装时写入），
	// 老快照没有 details 时从结果文本里认 sa-<8hex>（与 spawn 文案格式对应）。
	const detailsConv =
		isDelegate && view.result && typeof view.result.details === "object" && view.result.details !== null
			? ((view.result.details as Record<string, unknown>).convId as string | undefined)
			: undefined;
	const delegateConvId =
		typeof detailsConv === "string" && detailsConv ? detailsConv : /sa-[0-9a-f]{8}/.exec(rawOutput)?.[0];

	const statusClass = isError ? "err" : done ? "ok" : running || waitingModel ? "run" : "idle";
	let statusLabel = isError
		? t("error")
		: done
			? t("done")
			: running
				? t("running")
				: waitingModel
					? t("toolDoneWaitingModel")
					: t("toolQueued");
	const duration = waitingModel && view.status?.durationMs !== undefined ? formatDuration(view.status.durationMs) : "";
	if (waitingModel && duration) statusLabel = `${statusLabel} · ${duration}`;

	// tool_status doesn't carry the exit code for successful bash runs (only
	// failures embed "exited with code N" in the error text); show it when known.
	const exitHint = waitingModel && view.status?.exitCode !== undefined ? `exit ${view.status.exitCode}` : "";

	// 卡头右侧提示：任何工具都从参数里安全取路径/超时（AI 填错也只是不显示，见
	// tool-args.ts）；bash 类的命令行给正文的终端行，折叠时卡头跟一小段预览。
	// delegate_task 额外取 agent 名。
	const hints = toolArgHints(block.argumentsText);
	const bashCommand = block.name === "bash" ? hints.command : undefined;
	// 折叠预览：只取首行（空白压成单空格），80 字截断；多行折成 +N 后缀。
	// 完整命令放 title 悬浮里；展开时正文有完整终端行，这里不再显示。
	const collapsedCmd = !shown && bashCommand ? collapsedBashPreview(bashCommand) : undefined;

	const copyArgs = () => {
		if (block.argumentsText) {
			void navigator.clipboard.writeText(block.argumentsText);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		}
	};

	return (
		<div className={`toolcall ${statusClass}`}>
			<div
				className="chead toolcall-head"
				role="button"
				tabIndex={0}
				aria-expanded={shown}
				title={shown ? t("collapseMsg") : t("expandMsg")}
				onClick={() => setOpen(!expanded)}
				onKeyDown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen(!expanded);
					}
				}}
			>
				<button
					type="button"
					className="chead-toggle toolcall-toggle"
					title={shown ? t("collapseMsg") : t("expandMsg")}
					aria-label={shown ? t("collapseMsg") : t("expandMsg")}
					aria-expanded={shown}
					onClick={(e) => {
						e.stopPropagation();
						setOpen(!expanded);
					}}
				>
					{shown ? <FiChevronDown /> : <FiChevronRight />}
				</button>
				<span className="chead-icon toolcall-icon">{toolIcon(block.name)}</span>
				<span className="chead-title toolcall-name">{block.name}</span>
				<span
					className="toolcall-status"
					title={exitHint ? `${statusLabel} · ${exitHint}` : statusLabel}
					aria-label={exitHint ? `${statusLabel} · ${exitHint}` : statusLabel}
				>
					{isError ? <FiX /> : done ? <FiCheck /> : running ? <FiLoader /> : waitingModel ? <FiClock /> : <FiMinus />}
				</span>
				{collapsedCmd && (
					<span className="toolcall-cmd" title={bashCommand}>
						$ {collapsedCmd}
					</span>
				)}
				{hints.path && (
					<span className="toolcall-path" title={hints.path}>
						{shortenPath(hints.path)}
					</span>
				)}
				{hints.timeout && <span className="toolcall-timeout">⏱ {hints.timeout}</span>}
				{isDelegate && hints.agent && (
					<span className="toolcall-agent" title={hints.agent}>
						◈ {hints.agent}
					</span>
				)}
				<span className="toolcall-spacer" />
				{isBashRunning && onKillBash && (
					<button
						type="button"
						className="toolcall-kill"
						title={t("stopBashTip")}
						onClick={(e) => {
							e.stopPropagation();
							onKillBash?.();
						}}
					>
						<FiSquare />
						<span>{t("stopBash")}</span>
					</button>
				)}
				{isDelegate && done && delegateConvId && (
					<button
						type="button"
						className="toolcall-open"
						title={t("delegateOpenSubagent")}
						onClick={(e) => {
							e.stopPropagation();
							window.dispatchEvent(
								new CustomEvent<string>("pi-web-ui:switch-conversation", { detail: delegateConvId }),
							);
						}}
					>
						<FiArrowRight />
						<span>{t("delegateOpenSubagent")}</span>
					</button>
				)}
				<button
					type="button"
					className="chead-copy toolcall-copy"
					title={t("copyArgs")}
					onClick={(e) => {
						e.stopPropagation();
						copyArgs();
					}}
				>
					{copied ? <FiCheckCircle /> : <FiCopy />}
				</button>
			</div>
			{shown && (
				<div className="toolcall-body">
					{isDelegate ? (
						<DelegateBrief args={delegateArgs} />
					) : (
						block.argumentsText && (
							<div className="toolcall-args">
								{bashCommand ? <TerminalCommand command={bashCommand} /> : <pre>{block.argumentsText}</pre>}
							</div>
						)
					)}
					{output.length > 0 && (
						<div className="toolcall-output">
							<div className="toolcall-output-label">
								{isError ? t("errorOutput") : t("output")}
								{(running || waitingModel) && <span className="cursor" />}
							</div>
							<pre>{output}</pre>
						</div>
					)}
					{running && output.length === 0 && (
						<div className="toolcall-waiting">
							<span className="cursor" /> {t("waitingOutput")}
						</div>
					)}
					{waitingModel && output.length === 0 && (
						<div className="toolcall-waiting">
							<span className="cursor" /> {t("waitingModel")}
						</div>
					)}
				</div>
			)}
		</div>
	);
});

/** Pretty-print a bash tool call's command line as a terminal row. */
function TerminalCommand({ command }: { command: string }) {
	return (
		<div className="termline">
			<FiTerminal className="termline-icon" />
			<code>{command}</code>
		</div>
	);
}

/** 派单卡片正文：六段式结构化展示（只渲染非空段；脏参数解析出空对象时回落原文）。 */
function DelegateBrief({ args }: { args: Partial<Record<DelegateField | "agent" | "model", string>> }) {
	const t = useT();
	const sections: { field: DelegateField; label: string }[] = [
		{ field: "task", label: t("delegateSecTask") },
		{ field: "expected_outcome", label: t("delegateSecExpected") },
		{ field: "required_tools", label: t("delegateSecTools") },
		{ field: "must_do", label: t("delegateSecMustDo") },
		{ field: "must_not_do", label: t("delegateSecMustNotDo") },
		{ field: "context", label: t("delegateSecContext") },
	];
	const shown = sections.filter(({ field }) => args[field]?.trim());
	if (shown.length === 0) return null;
	return (
		<div className="delegate-brief">
			{shown.map(({ field, label }) => (
				<div className="delegate-sec" key={field}>
					<div className="delegate-sec-label">{label}</div>
					<div className="delegate-sec-text">{args[field]}</div>
				</div>
			))}
		</div>
	);
}

/** 折叠态 bash 命令预览：首行空白归一后取 80 字，多行追加 `+N` 后缀。
 *  输入脏（空串/全空白）返回 undefined——卡头不显示。 */
export function collapsedBashPreview(command: string): string | undefined {
	const lines = command.split("\n");
	const first = lines[0].replace(/\s+/g, " ").trim();
	if (!first) return undefined;
	const rest = lines.length - 1;
	const short = first.length > 80 ? `${first.slice(0, 80)}…` : first;
	return rest > 0 ? `${short} +${rest}` : short;
}

/** "0.3s" / "12.0s" / "1m 05s" — for the tool_status duration hint. */
function formatDuration(ms?: number): string {
	if (ms === undefined) return "";
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const m = Math.floor(totalSec / 60);
	const s = Math.round(totalSec % 60);
	return `${m}m ${String(s).padStart(2, "0")}s`;
}
