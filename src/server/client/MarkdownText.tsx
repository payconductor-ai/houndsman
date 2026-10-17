/**
 * Render de markdown mínimo para o campo `action` do finding.
 *
 * Sem HTML cru: tudo vira nós do Preact. Blocos de código reutilizam o
 * highlight de código; links passam por `safeUrl`.
 */

import { useMemo } from "preact/hooks";
import { highlightCode, languageFromName } from "./utils/code-highlight";
import { type InlineToken, parseInline, parseMarkdown, safeUrl } from "./utils/markdown";

function renderInlineToken(token: InlineToken) {
	switch (token.type) {
		case "code":
			return <code class="md-code">{token.text}</code>;
		case "strong":
			return <strong>{token.text}</strong>;
		case "em":
			return <em>{token.text}</em>;
		case "link": {
			const url = safeUrl(token.url);
			return url ? (
				<a href={url} target="_blank" rel="noreferrer">
					{token.text}
				</a>
			) : (
				token.text
			);
		}
		default:
			return token.text;
	}
}

function InlineTokens({ text }: { text: string }) {
	const tokens = useMemo(() => parseInline(text), [text]);
	return <>{tokens.map((token) => renderInlineToken(token))}</>;
}

function CodeBlock({ code, language }: { code: string; language: string | null }) {
	const highlighted = useMemo(
		() => highlightCode(code, languageFromName(language)),
		[code, language],
	);
	return (
		<pre class="md-code-block">
			{highlighted
				? highlighted.tokens.map((token) => (
						<span
							class={
								token.type === "plain" ? undefined : `tok-${token.type}`
							}
						>
							{token.text}
						</span>
					))
				: code}
		</pre>
	);
}

/** Renderiza o markdown do action/artefato preservando blocos e listas. */
export function MarkdownText({ text }: { text: string }) {
	const blocks = useMemo(() => parseMarkdown(text), [text]);
	return (
		<>
			{blocks.map((block) => {
				switch (block.type) {
					case "paragraph":
						return (
							<p class="md-p">
								<InlineTokens text={block.text} />
							</p>
						);
					case "heading": {
						const level = Math.min(Math.max(block.level, 1), 6);
						const Tag = `h${level}` as
							| "h1"
							| "h2"
							| "h3"
							| "h4"
							| "h5"
							| "h6";
						return (
							<Tag class={`md-h md-h${level}`}>
								<InlineTokens text={block.text} />
							</Tag>
						);
					}
					case "list": {
						const items = block.items.map((item) => (
							<li>
								<InlineTokens text={item} />
							</li>
						));
						return block.ordered ? (
							<ol class="md-list">{items}</ol>
						) : (
							<ul class="md-list">{items}</ul>
						);
					}
					case "table":
						return (
							<div class="md-table-wrap">
								<table class="md-table">
									<thead>
										<tr>
											{block.header.map((cell, column) => (
												<th
													style={{
														textAlign: block.align[column],
													}}
												>
													<InlineTokens text={cell} />
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{block.rows.map((row) => (
											<tr key={row.join("|")}>
												{block.header.map((_, column) => (
													<td
														style={{
															textAlign:
																block.align[column],
														}}
													>
														<InlineTokens
															text={row[column] ?? ""}
														/>
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						);
					case "code":
						return <CodeBlock code={block.code} language={block.language} />;
					case "quote":
						return (
							<blockquote class="md-quote">
								<InlineTokens text={block.text} />
							</blockquote>
						);
					case "hr":
						return <hr class="md-hr" />;
					default:
						return null;
				}
			})}
		</>
	);
}
