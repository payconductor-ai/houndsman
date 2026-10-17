/**
 * Render de markdown mínimo para o campo `action` do finding.
 *
 * Sem HTML cru: tudo vira nós do Preact. Blocos de código reutilizam o
 * highlight de código; links passam por `safeUrl`.
 */

import { useMemo } from "preact/hooks";
import { highlightCode, languageFromName } from "./code-highlight";
import { type InlineToken, parseInline, parseMarkdown, safeUrl } from "./markdown";

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

/** Renderiza o markdown do action preservando quebras de linha e listas. */
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
					case "code":
						return <CodeBlock code={block.code} language={block.language} />;
					case "quote":
						return (
							<blockquote class="md-quote">
								<InlineTokens text={block.text} />
							</blockquote>
						);
					default:
						return null;
				}
			})}
		</>
	);
}
