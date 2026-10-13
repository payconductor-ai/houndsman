/**
 * Servidor local do houndsman (`Bun.serve`) — UI de triagem + artefatos.
 *
 * Serve um SPA Preact (bundle em memória) + uma API JSON sobre o `state.json`
 * das runs em `.houndsman/.runs/`. Sem dependências além do Bun e do Preact.
 * Bind padrão em `127.0.0.1` — ferramenta local, sem autenticação.
 */

import { join } from "node:path";
import { mediaPath } from "../core/assets";
import { type HoundsmanConfig, resolveArtifactDir } from "../core/config";
import {
	applyFindingUpdate,
	buildStateFromRunDir,
	emptyState,
	type FindingDecision,
	type FindingExecState,
	type FindingsFilter,
	type FindingsStateFile,
	FindingsStateStore,
	type FindingUpdate,
	fileReader,
	filterFindings,
	reorder,
	type SyncResult,
	summarize,
	syncState,
} from "../core/findings-state";
import { STATE_FILE } from "../core/paths";
import { pingFindingsStatus, readRunStatus } from "../core/run-status";
import type { Severity } from "../core/types";
import { listRunSlugs, readRunFile, readRunJson, runDirForSlug } from "./artifacts";
import { buildClientBundle } from "./client-build";

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

function buildForRun(dir: string, slug: string): FindingsStateFile | null {
	const manifest = readRunJson<{ branch?: string }>(dir, "manifest.json");
	return buildStateFromRunDir(dir, manifest?.branch ?? slug, fileReader(process.cwd()));
}

/**
 * Lê o estado da run. Se ausente, reconstrói dos artefatos e PERSISTE — os ids
 * são aleatórios, então precisam ser estáveis entre requisições.
 */
function loadState(dir: string, slug: string): FindingsStateFile {
	const store = new FindingsStateStore(join(dir, STATE_FILE), slug);
	const existing = store.read();
	if (existing) return existing;
	const built = buildForRun(dir, slug);
	if (built) {
		store.write(built);
		return built;
	}
	return emptyState(slug);
}

function listRuns(artifactDir: string): unknown[] {
	return listRunSlugs(artifactDir).map((slug) => {
		const dir = join(artifactDir, slug);
		const state = loadState(dir, slug);
		const manifest = readRunJson<{ branch?: string; generatedAt?: string }>(
			dir,
			"manifest.json",
		);
		const status = readRunStatus(dir);
		return {
			slug,
			branch: state.branch || manifest?.branch || slug,
			updatedAt: status?.updatedAt ?? state.updatedAt,
			status: status?.status ?? null,
			summary: summarize(state),
		};
	});
}

function runDetail(dir: string, slug: string): unknown {
	const state = loadState(dir, slug);
	const classification = readRunJson<{
		watchdogs?: Record<string, string[]>;
		unclassified?: string[];
		deleted?: string[];
	}>(dir, "classification.json");
	return {
		slug,
		branch: state.branch || slug,
		status: readRunStatus(dir),
		manifest: readRunJson(dir, "manifest.json"),
		summary: summarize(state),
		watchdogs: Object.keys(classification?.watchdogs ?? {}),
		unclassified: classification?.unclassified ?? [],
		deleted: classification?.deleted ?? [],
	};
}

function findingsFor(dir: string, slug: string, params: URLSearchParams): unknown {
	const state = loadState(dir, slug);
	const filter: FindingsFilter = {
		decision: (params.get("decision") as FindingDecision) || undefined,
		execState: (params.get("exec") as FindingExecState) || undefined,
		severity: (params.get("severity") as Severity) || undefined,
		watchdog: params.get("watchdog") || undefined,
		file: params.get("file") || undefined,
		includeAbsent: params.get("all") === "1",
	};
	return {
		branch: state.branch,
		findings: filterFindings(state, filter),
		summary: summarize(state),
	};
}

async function updateFinding(
	dir: string,
	slug: string,
	id: string,
	request: Request,
): Promise<Response> {
	const body = (await request.json().catch(() => ({}))) as FindingUpdate;
	const store = new FindingsStateStore(join(dir, STATE_FILE), slug);
	const state = store.read() ?? buildForRun(dir, slug) ?? emptyState(slug);
	const finding = state.findings[id];
	if (!finding) return notFound(`finding '${id}' não encontrado`);
	applyFindingUpdate(finding, body);
	reorder(state);
	store.write(state);
	pingFindingsStatus(dir, state);
	return json({ finding });
}

function syncRun(dir: string, slug: string): Response {
	const store = new FindingsStateStore(join(dir, STATE_FILE), slug);
	const state = store.read() ?? buildForRun(dir, slug) ?? emptyState(slug);
	const result: SyncResult = syncState(state, fileReader(process.cwd()));
	store.write(state);
	pingFindingsStatus(dir, state);
	return json({ result, summary: summarize(state) });
}

function serveArtifact(dir: string, name: string): Response {
	if (!/\.(json|md)$/i.test(name)) return notFound("tipo de artefato não servido");
	const content = readRunFile(dir, name);
	if (content === null) return notFound(`artefato '${name}' não encontrado`);
	const type = name.toLowerCase().endsWith(".json")
		? "application/json; charset=utf-8"
		: "text/markdown; charset=utf-8";
	return text(content, type);
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

const API_RUN = /^\/api\/runs\/([^/]+)(\/.*)?$/;
const LOGO_FILE = "logo.png";

/** Serve a logo do pacote (`assets/logo.png`). */
async function serveLogo(): Promise<Response> {
	const file = Bun.file(mediaPath(LOGO_FILE));
	if (!(await file.exists())) return notFound("logo não encontrada");
	return new Response(file, {
		headers: { "cache-control": "no-store" },
	});
}

async function route(request: Request, artifactDir: string): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === "/" || path === "/index.html") {
		return noStore(renderShell(), "text/html; charset=utf-8");
	}
	if (path === "/assets/app.js") {
		return noStore(await buildClientBundle(), "text/javascript; charset=utf-8");
	}
	if (path === `/assets/${LOGO_FILE}`) return serveLogo();
	if (path === "/api/health") return json({ ok: true });

	if (path === "/api/runs" && request.method === "GET") {
		return json({ runs: listRuns(artifactDir) });
	}

	const match = path.match(API_RUN);
	if (!match) return notFound();
	const slug = decodeURIComponent(match[1]);
	const rest = match[2] ?? "";
	const dir = runDirForSlug(artifactDir, slug);
	if (!dir) return notFound(`run '${slug}' não encontrada`);

	if (rest === "" || rest === "/") return json(runDetail(dir, slug));

	if (rest === "/findings" && request.method === "GET") {
		return json(findingsFor(dir, slug, url.searchParams));
	}
	if (rest === "/sync" && request.method === "POST") return syncRun(dir, slug);

	const findingMatch = rest.match(/^\/findings\/([^/]+)$/);
	if (findingMatch) {
		const id = decodeURIComponent(findingMatch[1]);
		if (request.method === "GET") {
			const state = loadState(dir, slug);
			const finding = state.findings[id];
			return finding
				? json({ finding })
				: notFound(`finding '${id}' não encontrado`);
		}
		if (request.method === "PATCH" || request.method === "POST") {
			return updateFinding(dir, slug, id, request);
		}
	}

	const artifactMatch = rest.match(/^\/artifacts\/(.+)$/);
	if (artifactMatch && request.method === "GET") {
		return serveArtifact(dir, decodeURIComponent(artifactMatch[1]));
	}

	return notFound();
}

/** Cria o handler de requisições (testável sem abrir porta). */
export function createRequestHandler(
	config: HoundsmanConfig,
): (request: Request) => Promise<Response> {
	const artifactDir = resolveArtifactDir(config);
	return async (request) => {
		try {
			return await route(request, artifactDir);
		} catch (error) {
			return json(
				{ error: error instanceof Error ? error.message : String(error) },
				500,
			);
		}
	};
}

export type ServerOptions = {
	config: HoundsmanConfig;
	port?: number;
	host?: string;
};

/** Sobe o servidor e devolve a instância + URL. */
export function startServer(options: ServerOptions): { server: BunServer; url: string } {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 7331;
	const server = Bun.serve({
		hostname: host,
		port,
		fetch: createRequestHandler(options.config),
	});
	return { server, url: `http://${host}:${server.port}` };
}

// ---------------------------------------------------------------------------
// Shell (HTML + CSS)
// ---------------------------------------------------------------------------

const STYLES = `
:root { color-scheme: dark; --bg:#161616; --panel:#1e1e1e; --border:#2f2f2f; --fg:#e6e6e6; --muted:#9aa0a6; --accent:#4c8dff; }
* { box-sizing: border-box; }
body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.app { display:flex; min-height:100vh; }
.sidebar { width:240px; border-right:1px solid var(--border); background:var(--panel); padding:16px; }
.brand { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
.brand .logo { width:40px; height:40px; object-fit:contain; border-radius:8px; background:#111; border:1px solid var(--border); }
.sidebar h1 { font-size:16px; margin:0; }
.sub { color:var(--muted); font-size:12px; margin:2px 0 12px; }
.brand .sub { margin:0; }
.runs { display:flex; flex-direction:column; gap:4px; }
.run { text-align:left; background:transparent; border:1px solid transparent; border-radius:6px; color:var(--fg); padding:8px; cursor:pointer; display:flex; flex-direction:column; gap:2px; }
.run:hover { background:#262626; }
.run.active { border-color:var(--accent); background:#22304d; }
.run-branch { font-weight:600; font-size:13px; }
.run-meta { color:var(--muted); font-size:11px; }
.run-status { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.status-reviewing, .status-fixing { color:#e3a008; }
.status-review_done { color:#4c8dff; }
.status-fix_done { color:#3fb950; }
.status-timeout { color:#e5484d; }
.main { flex:1; padding:16px 20px; max-width:980px; }
.topbar { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
.tabs { display:flex; gap:6px; flex-wrap:wrap; }
.btn { background:#262626; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:5px 10px; font-size:12px; cursor:pointer; }
.btn:hover { border-color:var(--accent); }
.btn.active { background:#22304d; border-color:var(--accent); }
.btn:disabled { opacity:.5; cursor:not-allowed; }
.summary-bar { display:flex; gap:14px; flex-wrap:wrap; color:var(--muted); font-size:12px; border:1px solid var(--border); border-radius:6px; padding:8px 10px; margin-bottom:10px; }
.filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
.filters input[type=text], .filters input:not([type]), .filters select { background:#1b1b1b; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:6px 8px; font-size:12px; }
.filters input:not([type]) { min-width:240px; }
.toggle { color:var(--muted); font-size:12px; display:flex; align-items:center; gap:6px; }
.caption { color:var(--muted); font-size:12px; line-height:1.5; margin:0 0 12px; }
.caption code { background:#242424; padding:1px 5px; border-radius:4px; }
.sev-group h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.sev-group h2 .n { color:#666; }
.card { background:var(--panel); border:1px solid var(--border); border-left:3px solid var(--border); border-radius:8px; padding:12px 14px; margin-bottom:10px; }
.card.sev-blocking { border-left-color:#e5484d; }
.card.sev-attention { border-left-color:#e3a008; }
.card.sev-suggestion { border-left-color:#4c8dff; }
.card.sev-nit { border-left-color:#666; }
.card.absent { opacity:.55; }
.card-head { display:flex; align-items:center; gap:10px; font-size:12px; color:var(--muted); }
.card-head .loc { color:var(--fg); }
.card-head .spacer { flex:1; }
.card-head .id { color:#7c7c7c; }
.rule { font-size:14px; margin:8px 0 4px; }
.msg { margin:2px 0; font-size:13px; }
.action { margin:2px 0; font-size:13px; color:#cfcfcf; }
.evidence { background:#111; border:1px solid var(--border); border-radius:6px; padding:8px; font-size:12px; overflow:auto; }
.card-foot { display:flex; gap:12px; color:var(--muted); font-size:11px; margin:6px 0; }
.decisions { display:flex; gap:6px; flex-wrap:wrap; margin:6px 0; }
.dec-execute.active { background:#153b21; border-color:#2ea043; }
.dec-ignore.active { background:#3a2323; border-color:#e5484d; }
.comment-row textarea { width:100%; min-height:44px; background:#1b1b1b; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:6px 8px; font-size:12px; }
.comment-actions { display:flex; gap:6px; margin-top:6px; }
.btn.done.active { background:#153b21; border-color:#2ea043; }
.artifacts .tabs { margin-bottom:10px; }
.artifact-desc { color:var(--muted); font-size:12px; line-height:1.5; margin:0 0 10px; }
.artifact-view { background:#111; border:1px solid var(--border); border-radius:6px; padding:12px; font-size:12px; overflow:auto; max-height:70vh; }
.error { color:#ff7b72; font-size:13px; }
.empty { color:var(--muted); font-size:13px; }
`;

/** Id de build por processo — muda a URL do bundle a cada reinício do servidor. */
const BUILD_ID = Date.now().toString(36);

function renderShell(): string {
	return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Houndsman — Revisões</title>
<style>${STYLES}</style>
</head>
<body>
<div id="app"></div>
<script type="module" src="/assets/app.js?v=${BUILD_ID}"></script>
</body>
</html>`;
}
