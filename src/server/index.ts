/**
 * Servidor local do houndsman (`Bun.serve`) — UI de triagem + artefatos.
 *
 * Serve um SPA Preact (bundle em memória) + uma API JSON sobre o storage global
 * (SQLite por default), escopada ao repositório do cwd. Sem dependências além do
 * Bun e do Preact. Bind padrão em `127.0.0.1` — ferramenta local, sem autenticação.
 */

import { join } from "node:path";
import { mediaPath } from "../core/assets";
import type { HoundsmanConfig } from "../core/config";
import type { FindingUpdate } from "../core/findings-state";
import { createGitRunner, type GitRunner } from "../core/git-runner";
import {
	defaultGhRunner,
	type GhRunner,
	type SubmitSelection,
} from "../core/github-review";
import { logger } from "../core/logging";
import { GitRepository } from "../core/services/git-repository";
import { PrResolver } from "../core/services/pr-resolver";
import { WorktreeManager } from "../core/services/worktree-manager";
import { createStorage } from "../core/storage/factory";
import { resolveWorktreesRoot } from "../core/storage/paths";
import { resolveRepoIdentity } from "../core/storage/repo-identity";
import type { RepoIdentity, StorageProvider } from "../core/storage/types";
import { buildClientBundle } from "./client-build";
import { type EditorContext, resolveEditor } from "./editor";
import { PrInbox } from "./pr-inbox";
import { RunRepository } from "./run-repository";

type BunServer = ReturnType<typeof Bun.serve>;

// ---------------------------------------------------------------------------
// Helpers de resposta
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function text(body: string, contentType: string, status = 200): Response {
	return new Response(body, { status, headers: { "content-type": contentType } });
}

/** Resposta sem cache — o servidor é local; o navegador sempre pega a versão nova. */
function noStore(body: string, contentType: string): Response {
	return new Response(body, {
		headers: {
			"content-type": contentType,
			"cache-control": "no-store, no-cache, must-revalidate",
		},
	});
}

function notFound(detail = "não encontrado"): Response {
	return json({ error: detail }, 404);
}

// ---------------------------------------------------------------------------
// Estado / dados
// ---------------------------------------------------------------------------

/** Repositório das runs (dados) — ver `run-repository.ts`. */
type ServerDeps = {
	ghRunner?: GhRunner;
	gitRunner?: GitRunner;
	storage?: StorageProvider;
	repo?: RepoIdentity;
	/** Contexto do editor injetado (testes). */
	editor?: EditorContext;
	/** Preferência do `--editor` (CLI). */
	editorPreference?: string;
};

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

const API_RUN = /^\/api\/runs\/([^/]+)(\/.*)?$/;
const LOGO_FILE = "logo.png";
const STYLES_FILE = "styles.css";

/** Serve a logo do pacote (`assets/logo.png`). */
async function serveLogo(): Promise<Response> {
	const file = Bun.file(mediaPath(LOGO_FILE));
	if (!(await file.exists())) return notFound("logo não encontrada");
	return new Response(file, {
		headers: { "cache-control": "no-store" },
	});
}

/**
 * Serve o CSS da UI (`styles.css`, ao lado deste módulo) direto do disco.
 *
 * Ler a cada request mantém o hot reload: editar o CSS só exige recarregar a
 * página — igual ao bundle do cliente.
 */
async function serveStyles(): Promise<Response> {
	const file = Bun.file(join(import.meta.dir, STYLES_FILE));
	if (!(await file.exists())) return notFound("styles não encontrado");
	return new Response(file, {
		headers: {
			"content-type": "text/css; charset=utf-8",
			"cache-control": "no-store, no-cache, must-revalidate",
		},
	});
}

async function route(
	request: Request,
	runs: RunRepository,
	ghRunner: GhRunner,
	prs: PrInbox,
	editor: EditorContext,
	worktrees: WorktreeManager,
	git: GitRepository,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === "/" || path === "/index.html") {
		return noStore(renderShell(), "text/html; charset=utf-8");
	}
	if (path === "/assets/app.js") {
		return noStore(await buildClientBundle(), "text/javascript; charset=utf-8");
	}
	if (path === `/assets/${STYLES_FILE}`) return serveStyles();
	if (path === `/assets/${LOGO_FILE}`) return serveLogo();
	if (path === "/api/health") return json({ ok: true });
	if (path === "/api/editor" && request.method === "GET") return json(editor);
	if (path === "/api/prs" && request.method === "GET") {
		return json(prs.list(runs.workspaceIndex()));
	}
	if (path === "/api/worktrees" && request.method === "GET") {
		return json({
			worktrees: worktrees.managed().map((entry) => ({
				path: entry.path,
				branch: entry.branch?.replace(/^refs\/heads\//, "") ?? null,
				head: entry.head ?? null,
				prunable: entry.prunable,
			})),
		});
	}
	if (path === "/api/prs/worktree" && request.method === "POST") {
		const body = (await request.json().catch(() => ({}))) as { number?: unknown };
		const number = Number(body.number);
		if (!Number.isInteger(number) || number <= 0) {
			return json(
				{ ok: false, reason: "invalid", detail: "Número de PR inválido." },
				400,
			);
		}
		const resolver = new PrResolver(ghRunner, git);
		const resolved = resolver.resolve(number);
		if (!resolved.ok) {
			return json({ ok: false, reason: resolved.reason, detail: resolved.detail });
		}
		const refs = resolver.prepareRefs(resolved.pr);
		try {
			const worktree = worktrees.ensure({
				branch: resolved.pr.headRefName,
				ref: refs.head,
			});
			return json({
				ok: true,
				number,
				branch: resolved.pr.headRefName,
				path: worktree.path,
				head: worktree.head,
				created: worktree.created,
				warning: refs.warning,
			});
		} catch (error) {
			return json({
				ok: false,
				reason: "git",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const worktreeMatch = path.match(/^\/api\/worktrees\/(.+)$/);
	if (worktreeMatch && request.method === "DELETE") {
		const branch = decodeURIComponent(worktreeMatch[1]);
		const force = url.searchParams.get("force") === "1";
		const result = worktrees.remove(branch, { force });
		return json(result, result.removed ? 200 : 409);
	}
	if (path === "/api/prs/checkout" && request.method === "POST") {
		const body = (await request.json().catch(() => ({}))) as { number?: unknown };
		const number = Number(body.number);
		if (!Number.isInteger(number) || number <= 0) {
			return json(
				{ ok: false, reason: "invalid", detail: "Número de PR inválido." },
				400,
			);
		}
		return json(prs.checkout(number));
	}

	if (path === "/api/runs" && request.method === "GET") {
		return json({ runs: runs.list() });
	}

	const match = path.match(API_RUN);
	if (!match) return notFound();
	const slug = decodeURIComponent(match[1]);
	const rest = match[2] ?? "";
	if (!runs.exists(slug)) return notFound(`run '${slug}' não encontrada`);

	if (rest === "" && request.method === "DELETE") {
		const removeWorktree = ["1", "true"].includes(
			url.searchParams.get("worktree") ?? "",
		);
		const result = runs.delete(slug, { removeWorktree });
		return result ? json(result) : notFound(`run '${slug}' não encontrada`);
	}

	if (rest === "" || rest === "/") return json(runs.detail(slug));

	if (rest === "/comments" && request.method === "GET") {
		return json(
			runs.comments(slug, { refresh: url.searchParams.get("refresh") === "1" }),
		);
	}
	if (rest === "/findings" && request.method === "GET") {
		return json(runs.findings(slug, url.searchParams));
	}
	if (rest === "/sync" && request.method === "POST") return json(runs.sync(slug));
	if (rest === "/submit-preview" && request.method === "GET") {
		return json(runs.submitPreview(slug, ghRunner));
	}
	if (rest === "/submit" && request.method === "POST") {
		const body = (await request.json().catch(() => ({}))) as SubmitSelection;
		const selection: SubmitSelection = {
			severities: body.severities,
			decisions: body.decisions,
			execStates: body.execStates,
			includeSent: body.includeSent,
		};
		return json(runs.submit(slug, selection, ghRunner));
	}

	const findingMatch = rest.match(/^\/findings\/([^/]+)$/);
	if (findingMatch) {
		const id = decodeURIComponent(findingMatch[1]);
		if (request.method === "GET") {
			const finding = runs.finding(slug, id);
			return finding
				? json({ finding })
				: notFound(`finding '${id}' não encontrado`);
		}
		if (request.method === "PATCH" || request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as FindingUpdate;
			const finding = runs.update(slug, id, body);
			return finding
				? json({ finding })
				: notFound(`finding '${id}' não encontrado`);
		}
	}

	const artifactMatch = rest.match(/^\/artifacts\/(.+)$/);
	if (artifactMatch && request.method === "GET") {
		const name = decodeURIComponent(artifactMatch[1]);
		const artifact = runs.artifact(slug, name);
		if (!artifact) return notFound(`artefato '${name}' não encontrado`);
		return text(artifact.content, artifact.type);
	}
	if (rest === "/artifacts" && request.method === "GET") {
		return json({ artifacts: runs.artifacts(slug) ?? [] });
	}

	return notFound();
}

/** Servidor local do houndsman (rotas + shell). */
export class HoundsmanServer {
	private readonly runs: RunRepository;
	private readonly ghRunner: GhRunner;
	private readonly prs: PrInbox;
	private readonly editor: EditorContext;
	private readonly worktrees: WorktreeManager;
	private readonly git: GitRepository;

	constructor(config: HoundsmanConfig, deps: ServerDeps = {}) {
		const repo = deps.repo ?? resolveRepoIdentity();
		this.ghRunner = deps.ghRunner ?? defaultGhRunner;
		this.git = new GitRepository(deps.gitRunner ?? createGitRunner(repo.root));
		this.prs = new PrInbox(this.ghRunner, this.git);
		this.worktrees = new WorktreeManager(
			new GitRepository(createGitRunner(repo.root)),
			{
				repoKey: repo.key,
				repoRoot: repo.root,
				baseDir: resolveWorktreesRoot(config.worktrees?.location, repo.root),
			},
		);
		this.runs = new RunRepository(
			deps.storage ?? createStorage(config),
			repo,
			this.ghRunner,
			this.worktrees,
		);
		this.editor =
			deps.editor ?? resolveEditor(deps.editorPreference, process.env, repo.root);
	}

	/** Handler de requisições (testável sem abrir porta). */
	readonly handler = async (request: Request): Promise<Response> => {
		try {
			return await route(
				request,
				this.runs,
				this.ghRunner,
				this.prs,
				this.editor,
				this.worktrees,
				this.git,
			);
		} catch (error) {
			return json(
				{ error: error instanceof Error ? error.message : String(error) },
				500,
			);
		}
	};

	/** Sobe o servidor e devolve a instância + URL. */
	start(options: { port?: number; host?: string } = {}): {
		server: BunServer;
		url: string;
	} {
		// Manutenção do banco no start: compacta o que sobrou de runs antigas.
		try {
			this.runs.maintain();
		} catch (error) {
			logger.warn(
				`VACUUM falhou (seguindo sem compactar): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const host = options.host ?? "127.0.0.1";
		const port = options.port ?? 7331;
		const server = Bun.serve({ hostname: host, port, fetch: this.handler });
		return { server, url: `http://${host}:${server.port}` };
	}

	/** Fecha o provider (após `server.stop()`). */
	dispose(): void {
		this.runs.dispose();
	}
}

/** Cria o handler de requisições (testável sem abrir porta). */
export function createRequestHandler(
	config: HoundsmanConfig,
	deps: ServerDeps = {},
): (request: Request) => Promise<Response> {
	return new HoundsmanServer(config, deps).handler;
}

export type ServerOptions = {
	config: HoundsmanConfig;
	port?: number;
	host?: string;
	/** Runner do `gh` (injetável nos testes). */
	ghRunner?: GhRunner;
	/** Runner do git (injetável nos testes). */
	gitRunner?: GitRunner;
	/** Provider/storage injetável (testes). */
	storage?: StorageProvider;
	repo?: RepoIdentity;
	/** Contexto de editor injetado (testes). */
	editor?: EditorContext;
	/** Preferência do `--editor` (auto|vscode|jetbrains|none). */
	editorPreference?: string;
};

/** Sobe o servidor e devolve a instância + URL. */
export function startServer(options: ServerOptions): { server: BunServer; url: string } {
	return new HoundsmanServer(options.config, {
		ghRunner: options.ghRunner,
		gitRunner: options.gitRunner,
		storage: options.storage,
		repo: options.repo,
		editor: options.editor,
		editorPreference: options.editorPreference,
	}).start({
		port: options.port,
		host: options.host,
	});
}

// ---------------------------------------------------------------------------
// Shell (HTML)
// ---------------------------------------------------------------------------

/** Id de build por processo — muda a URL do bundle a cada reinício do servidor. */
const BUILD_ID = Date.now().toString(36);

function renderShell(): string {
	return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Houndsman — Revisões</title>
<!-- Fontes de CDN: se estiver offline, o CSS cai para a pilha de sistema. -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" />
<link rel="stylesheet" href="/assets/${STYLES_FILE}?v=${BUILD_ID}" />
</head>
<body>
<div id="app"></div>
<script type="module" src="/assets/app.js?v=${BUILD_ID}"></script>
</body>
</html>`;
}
