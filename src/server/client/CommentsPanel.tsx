/**
 * Aba "Comentários": threads de revisão e comentários gerais da PR da run.
 *
 * O componente só é montado quando a aba é acessada — o carregamento (e a
 * chamada ao `gh`) acontece no mount, nunca no carregamento da página.
 */

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { Clock, CodeIcon, ExternalLink, GitHub, MessageSquare, Refresh } from "./icons";
import { MarkdownText } from "./MarkdownText";
import { api } from "./utils/api";
import { editorFileLink, editorLabel, formatRunTime } from "./utils/format";
import type {
	EditorContext,
	PrCommentsResponse,
	PrCommentThread,
	PrCommentView,
} from "./utils/types";

function CommentCard({
	comment,
	editor,
	reply,
}: {
	comment: PrCommentView;
	editor: EditorContext;
	reply: boolean;
}) {
	const location = comment.path
		? comment.line
			? `${comment.path}:${comment.line}`
			: comment.path
		: null;
	const href = comment.absFile
		? editorFileLink(comment.absFile, comment.line, editor)
		: null;
	return (
		<article class={`pr-comment${reply ? " reply" : ""}`}>
			<header class="pr-comment-head">
				<span class="pr-comment-author">{comment.author}</span>
				{comment.authorType === "Bot" && <span class="tag">bot</span>}
				<span class="run-when">
					<Clock size={12} />
					{formatRunTime(comment.createdAt)}
				</span>
				<span class="spacer" />
				{comment.url && (
					<a
						class="pr-comment-link"
						href={comment.url}
						target="_blank"
						rel="noreferrer"
						title="Abrir o comentário no GitHub"
					>
						<GitHub size={12} /> GitHub
					</a>
				)}
			</header>
			<div class="pr-comment-body">
				<MarkdownText text={comment.body} />
			</div>
			{location &&
				(href ? (
					<a
						class="loc"
						href={href}
						title={`Abrir ${location} no ${editorLabel(editor)}`}
					>
						<CodeIcon size={13} />
						{location}
						<ExternalLink size={12} class="ext" />
					</a>
				) : (
					<code class="loc static">
						<CodeIcon size={13} />
						{location}
					</code>
				))}
		</article>
	);
}

function ThreadCard({
	thread,
	editor,
}: {
	thread: PrCommentThread;
	editor: EditorContext;
}) {
	const location = thread.line
		? `${thread.path}:${thread.line}`
		: thread.path || "arquivo";
	const href = thread.absFile
		? editorFileLink(thread.absFile, thread.line, editor)
		: null;
	return (
		<section class="comment-thread">
			<header class="comment-thread-head">
				<CodeIcon size={13} />
				<span class="comment-file">{location}</span>
				<span class="spacer" />
				{href && (
					<a
						class="icon-btn"
						href={href}
						title={`Abrir ${location} no ${editorLabel(editor)}`}
					>
						<ExternalLink size={13} />
					</a>
				)}
				<span class="count">{thread.comments.length}</span>
			</header>
			{thread.comments.map((comment, index) => (
				<CommentCard
					key={comment.id}
					comment={comment}
					editor={editor}
					reply={index > 0}
				/>
			))}
		</section>
	);
}

export function CommentsPanel({ slug, editor }: { slug: string; editor: EditorContext }) {
	const [data, setData] = useState<PrCommentsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	const load = useCallback(
		async (refresh = false) => {
			setLoading(true);
			setError("");
			try {
				const result = await api<PrCommentsResponse>(
					`/api/runs/${slug}/comments${refresh ? "?refresh=1" : ""}`,
				);
				setData(result);
			} catch (err) {
				setError(String(err));
			} finally {
				setLoading(false);
			}
		},
		[slug],
	);

	useEffect(() => {
		setData(null);
		void load();
	}, [load]);

	const groups = useMemo(() => {
		const map = new Map<string, PrCommentThread[]>();
		for (const thread of data?.threads ?? []) {
			const key = thread.path || "(sem arquivo)";
			const list = map.get(key) ?? [];
			list.push(thread);
			map.set(key, list);
		}
		return [...map.entries()];
	}, [data]);

	const empty =
		data?.available && data.threads.length === 0 && data.issueComments.length === 0;

	return (
		<div class="comments">
			<div class="comments-toolbar">
				<div class="comments-counts">
					<MessageSquare size={14} />
					{data?.available ? (
						<>
							<span>
								<b>{data.counts.threads}</b> threads
							</span>
							<span>
								<b>{data.counts.inline}</b> inline
							</span>
							<span>
								<b>{data.counts.issue}</b> gerais
							</span>
						</>
					) : (
						<span>Comentários da PR</span>
					)}
					{data?.target?.url && (
						<a
							class="pr-comment-link"
							href={data.target.url}
							target="_blank"
							rel="noreferrer"
						>
							<GitHub size={12} /> PR #{data.target.number}
						</a>
					)}
				</div>
				<button
					type="button"
					class="btn"
					disabled={loading}
					title="Recarrega os comentários ignorando o cache de 60s"
					onClick={() => void load(true)}
				>
					<Refresh size={14} class={loading ? "icon spin" : undefined} />
					Atualizar
				</button>
			</div>

			{loading && !data && <p class="empty">Carregando comentários da PR…</p>}
			{error && <p class="error">{error}</p>}
			{data && !data.available && (
				<p class="empty">
					Comentários indisponíveis
					{data.reason ? `: ${data.reason}` : "."}
				</p>
			)}
			{empty && <p class="empty">Nenhum comentário nesta PR.</p>}

			{data?.available && groups.length > 0 && (
				<section class="comment-group">
					<h2 class="comment-group-title">Comentários de revisão</h2>
					{groups.map(([path, threads]) => (
						<div class="comment-file-group" key={path}>
							<p class="comment-group-label">
								{path} <span class="count">{threads.length}</span>
							</p>
							{threads.map((thread) => (
								<ThreadCard
									key={thread.id}
									thread={thread}
									editor={editor}
								/>
							))}
						</div>
					))}
				</section>
			)}

			{data?.available && data.issueComments.length > 0 && (
				<section class="comment-group">
					<h2 class="comment-group-title">Comentários gerais</h2>
					{data.issueComments.map((comment) => (
						<CommentCard
							key={comment.id}
							comment={comment}
							editor={editor}
							reply={false}
						/>
					))}
				</section>
			)}
		</div>
	);
}
