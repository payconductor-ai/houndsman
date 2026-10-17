/**
 * Servidor local do houndsman (`Bun.serve`) — UI de triagem + artefatos.
 *
 * Serve um SPA Preact (bundle em memória) + uma API JSON sobre o storage global
 * (SQLite por default), escopada ao repositório do cwd. Sem dependências além do
 * Bun e do Preact. Bind padrão em `127.0.0.1` — ferramenta local, sem autenticação.
 */

import { mediaPath } from "../core/assets";
import type { HoundsmanConfig } from "../core/config";
import type { FindingUpdate } from "../core/findings-state";
import {
	defaultGhRunner,
	type GhRunner,
	type SubmitSelection,
} from "../core/github-review";
import { createStorage } from "../core/storage/factory";
import { resolveRepoIdentity } from "../core/storage/repo-identity";
import type { RepoIdentity, StorageProvider } from "../core/storage/types";
import { buildClientBundle } from "./client-build";
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
	storage?: StorageProvider;
	repo?: RepoIdentity;
};

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

async function route(
	request: Request,
	runs: RunRepository,
	ghRunner: GhRunner,
): Promise<Response> {
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
		return json({ runs: runs.list() });
	}

	const match = path.match(API_RUN);
	if (!match) return notFound();
	const slug = decodeURIComponent(match[1]);
	const rest = match[2] ?? "";
	if (!runs.exists(slug)) return notFound(`run '${slug}' não encontrada`);

	if (rest === "" || rest === "/") return json(runs.detail(slug));

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

	constructor(config: HoundsmanConfig, deps: ServerDeps = {}) {
		this.runs = new RunRepository(
			deps.storage ?? createStorage(config),
			deps.repo ?? resolveRepoIdentity(),
		);
		this.ghRunner = deps.ghRunner ?? defaultGhRunner;
	}

	/** Handler de requisições (testável sem abrir porta). */
	readonly handler = async (request: Request): Promise<Response> => {
		try {
			return await route(request, this.runs, this.ghRunner);
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
			console.warn(
				`[houndsman] VACUUM falhou (seguindo sem compactar): ${
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
	/** Provider/storage injetável (testes). */
	storage?: StorageProvider;
	repo?: RepoIdentity;
};

/** Sobe o servidor e devolve a instância + URL. */
export function startServer(options: ServerOptions): { server: BunServer; url: string } {
	return new HoundsmanServer(options.config, {
		ghRunner: options.ghRunner,
		storage: options.storage,
		repo: options.repo,
	}).start({
		port: options.port,
		host: options.host,
	});
}

// ---------------------------------------------------------------------------
// Shell (HTML + CSS)
// ---------------------------------------------------------------------------

const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&display=swap');

:root {
  color-scheme: dark;
  --bg:#0a0a0c; --surface:#101014; --surface-2:#17171c; --card:#131318;
  --border:rgba(255,255,255,.07); --border-strong:rgba(255,255,255,.14);
  --fg:#ece9e4; --muted:#9d978e; --muted-2:#6d6862;
  --accent:#f0a52c; --accent-strong:#ffc247; --accent-soft:rgba(240,165,44,.07); --accent-line:rgba(240,165,44,.25);
  --blocking:#f2595e; --attention:#eda13a; --suggestion:#5aa4f0; --nit:#8d8a85; --success:#45c07a;
  --radius:16px; --radius-lg:18px;
  --font-sans:"Poppins","Space Grotesk","Geist Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
* { box-sizing:border-box; }
html, body { height:100%; }
body { margin:0; font-size:14px; background:var(--bg); color:var(--fg); font-family:var(--font-sans); -webkit-font-smoothing:antialiased; }
body::before { content:""; position:fixed; inset:0; pointer-events:none; z-index:0;
  background:radial-gradient(820px 420px at 8% -12%, rgba(240,165,44,.08), transparent 62%); }
code, pre, .mono { font-family:var(--font-mono); }
::-webkit-scrollbar { width:10px; height:10px; }
::-webkit-scrollbar-thumb { background:rgba(255,255,255,.1); border:2px solid transparent; border-radius:999px; background-clip:padding-box; }
::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,.18); background-clip:padding-box; }
.app { position:relative; z-index:1; display:flex; height:100vh; overflow:hidden; }
.sidebar { width:292px; flex:0 0 292px; display:flex; flex-direction:column; gap:14px; padding:18px 14px;
  background:var(--surface); border-right:1px solid var(--border); overflow-y:auto; }
.brand { display:flex; align-items:center; gap:12px; }
.brand .logo { width:42px; height:42px; object-fit:contain; border-radius:12px; background:var(--surface-2); border:1px solid var(--border); }
.sidebar h1 { font-size:15.5px; font-weight:700; letter-spacing:-.01em; margin:0; }
.sub { color:var(--muted); font-size:11.5px; margin:0; }
.section-label { margin:4px 0 0; font-size:10px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:var(--muted-2); }
.runs { display:flex; flex-direction:column; gap:6px; }
.run { display:flex; flex-direction:column; gap:8px; text-align:left; cursor:pointer; font:inherit; color:inherit; padding:11px 13px;
  background:transparent; border:1px solid transparent; border-radius:var(--radius); transition:background .15s ease, border-color .15s ease; }
.run:hover { background:var(--surface-2); border-color:var(--border); }
.run.active { background:var(--accent-soft); border-color:var(--accent-line); }
.run-top { display:flex; align-items:flex-start; gap:8px; }
.run-icon { flex:none; margin-top:2px; color:var(--muted-2); }
.run.active .run-icon { color:var(--accent); }
.run-branch { font-size:13.5px; font-weight:600; line-height:1.35; word-break:break-word; }
.run-meta { display:flex; align-items:center; gap:10px; font-family:var(--font-mono); font-size:11px; color:var(--muted); }
.run-when { display:inline-flex; align-items:center; gap:6px; }
.run-count { margin-left:auto; color:var(--muted-2); }
.run-badge { align-self:flex-start; display:inline-flex; align-items:center; gap:6px; padding:4px 9px; border-radius:999px;
  font-size:10px; font-weight:700; letter-spacing:.07em; text-transform:uppercase;
  color:var(--success); background:rgba(69,192,122,.12); border:1px solid rgba(69,192,122,.32); }
.run-status { font-size:10px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--muted-2); }
.status-reviewing, .status-fixing { color:var(--accent); }
.status-review_done { color:var(--suggestion); }
.status-fix_done { color:var(--success); }
.status-timeout { color:var(--blocking); }
.main { flex:1; min-width:0; display:flex; flex-direction:column; overflow-y:auto; }
.topbar { position:sticky; top:0; z-index:10; display:flex; align-items:center; justify-content:space-between; gap:16px;
  padding:13px 24px; border-bottom:1px solid var(--border); background:rgba(16,16,20,.74);
  backdrop-filter:blur(16px) saturate(140%); -webkit-backdrop-filter:blur(16px) saturate(140%); }
.segmented { display:inline-flex; gap:4px; padding:4px; background:var(--surface-2); border:1px solid var(--border); border-radius:999px; }
.seg-btn { display:inline-flex; align-items:center; gap:8px; font:inherit; font-size:12.5px; font-weight:600; cursor:pointer;
  color:var(--muted); background:transparent; border:1px solid transparent; border-radius:999px; padding:7px 16px;
  transition:color .15s ease, background .15s ease; }
.seg-btn:hover { color:var(--fg); }
.seg-btn.active { color:#1b1305; background:linear-gradient(180deg, var(--accent-strong), var(--accent)); box-shadow:0 4px 14px rgba(240,165,44,.24); }
.topbar-right { display:flex; align-items:center; gap:14px; }
.auto-refresh { display:inline-flex; align-items:center; gap:8px; white-space:nowrap; font-family:var(--font-mono); font-size:11.5px; color:var(--muted); }
.dot { width:8px; height:8px; border-radius:50%; background:var(--success); box-shadow:0 0 0 3px rgba(69,192,122,.14); }
.dot.busy { background:var(--accent); box-shadow:0 0 0 3px rgba(240,165,44,.18); animation:pulse 1.1s ease-in-out infinite; }
.btn { display:inline-flex; align-items:center; gap:8px; font:inherit; font-size:12.5px; font-weight:500; cursor:pointer; color:var(--fg);
  padding:8px 15px; background:var(--surface-2); border:1px solid var(--border-strong); border-radius:999px;
  transition:background .15s ease, border-color .15s ease, color .15s ease; }
.btn:hover { background:#202027; border-color:var(--accent-line); }
.btn:disabled { opacity:.55; cursor:not-allowed; }
.icon.spin { animation:spin .8s linear infinite; }
.content { width:100%; max-width:1180px; margin:0 auto; padding:22px 24px 64px; }
.page-header { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; }
.page-header-text { min-width:0; }
.page-header-actions { display:flex; align-items:center; gap:10px; flex:none; }
.btn.submit-review { color:#1b1305; background:linear-gradient(180deg, var(--accent-strong), var(--accent)); border-color:transparent; box-shadow:0 4px 14px rgba(240,165,44,.22); }
.btn.submit-review:hover { background:linear-gradient(180deg, var(--accent-strong), var(--accent)); border-color:transparent; filter:brightness(1.07); }
.page-title { margin:0 0 8px; font-size:26px; font-weight:700; letter-spacing:-.02em; word-break:break-word; }
.page-sub { margin:0; max-width:78ch; color:var(--muted); font-size:12.5px; line-height:1.55; }
.page-sub code { color:var(--fg); background:rgba(255,255,255,.06); border-radius:6px; padding:1px 6px; font-size:11.5px; }
.error { color:#ff8b8f; font-size:12.5px; }
.empty { color:var(--muted); font-size:13px; }
.kpis { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; margin:20px 0 18px; }
.kpi { display:flex; flex-direction:column; gap:8px; padding:15px 16px; background:var(--card);
  border:1px solid var(--border); border-radius:var(--radius-lg); }
.kpi-label { font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted-2); }
.kpi-value { font-size:30px; font-weight:700; line-height:1; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
.kpi-hint { font-family:var(--font-mono); font-size:11px; color:var(--muted-2); }
.kpi-execute .kpi-value { color:var(--accent); }
.kpi-ignore .kpi-value { color:var(--muted); }
.kpi-done .kpi-value { color:var(--success); }
.progress { margin:0 0 22px; }
.progress-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; font-size:11.5px; color:var(--muted); }
.progress-head .pct { color:var(--fg); font-family:var(--font-mono); }
.progress-track { height:8px; border-radius:999px; background:var(--surface-2); border:1px solid var(--border); overflow:hidden; }
.progress-fill { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg, #2c8f57, var(--success)); transition:width .35s ease; }
.filters { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:20px; }
.search { display:flex; align-items:center; gap:8px; flex:1 1 240px; max-width:330px; padding:8px 14px; color:var(--muted);
  background:var(--surface-2); border:1px solid var(--border-strong); border-radius:999px; }
.search:focus-within { color:var(--accent); border-color:var(--accent-line); }
.search input { flex:1; min-width:0; font:inherit; font-size:12.5px; color:var(--fg); background:transparent; border:0; outline:0; }
.search input::placeholder { color:var(--muted-2); }
.search-clear { padding:0 2px; font-size:15px; line-height:1; color:var(--muted); background:transparent; border:0; cursor:pointer; }
.chips { display:inline-flex; gap:3px; padding:4px; background:var(--surface-2); border:1px solid var(--border); border-radius:999px; }
.chip { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:12px; font-weight:600; cursor:pointer; color:var(--muted);
  padding:6px 13px; background:transparent; border:1px solid transparent; border-radius:999px; transition:color .15s ease, background .15s ease; }
.chip:hover { color:var(--fg); }
.chip.active { color:#14100a; background:#e9e5df!important; }
.sev-group { margin-bottom:24px; }
.sev-head { display:flex; align-items:center; gap:8px; margin:0 0 10px; font-size:11px; font-weight:700;
  letter-spacing:.16em; text-transform:uppercase; color:var(--muted-2); }
.sev-head .n { font-family:var(--font-mono); letter-spacing:0; }
.sev-group.sev-blocking .sev-head { color:var(--blocking); }
.sev-group.sev-attention .sev-head { color:var(--attention); }
.sev-group.sev-suggestion .sev-head { color:var(--suggestion); }
.sev-group.sev-nit .sev-head { color:var(--nit); }
.card { position:relative; margin-bottom:20px; overflow:hidden; background:var(--card);
  border:1px solid var(--border); border-left:4px solid var(--border-strong); border-radius:var(--radius-lg);
  transition:background .15s ease, border-color .15s ease, opacity .2s ease; }
.card:hover { background:#16161b; }
.card.sev-blocking { border-left-color:var(--blocking); }
.card.sev-attention { border-left-color:var(--attention); }
.card.sev-suggestion { border-left-color:var(--suggestion); }
.card.sev-nit { border-left-color:var(--nit); }
.card.absent { opacity:.5; }
.card.done { opacity:.6; }
.card-head { display:flex; align-items:center; gap:10px; padding:12px 14px 0; }
.chev { display:grid; place-items:center; flex:none; width:22px; height:22px; cursor:pointer; color:var(--muted-2);
  background:transparent; border:1px solid transparent; border-radius:7px; }
.chev:hover { color:var(--fg); background:rgba(255,255,255,.06); }
.chev:focus-visible { color:var(--fg); border-color:var(--accent-line); outline:none; }
.chev svg { transition:transform .18s ease; }
.chev.open svg { transform:rotate(90deg); }
.sev-badge { display:inline-flex; align-items:center; flex:none; padding:3px 9px; border-radius:999px;
  font-size:10px; letter-spacing:.08em; text-transform:uppercase; }
.card.sev-blocking .sev-badge { color:var(--blocking); background:rgba(242,89,94,.12); }
.card.sev-attention .sev-badge { color:var(--attention); background:rgba(237,161,58,.12); }
.card.sev-suggestion .sev-badge { color:var(--suggestion); background:rgba(90,164,240,.12); }
.card.sev-nit .sev-badge { color:var(--nit); background:rgba(255,255,255,.06); }
.loc { display:inline-flex; align-items:center; gap:7px; max-width: 406ch; overflow:hidden; white-space:break-spaces; text-overflow:ellipsis;
  padding:4px 9px; font-family:var(--font-mono); font-size:11.5px; color:#aba7a1; text-decoration:none; }
.loc:hover { color:#fff; }
.loc .ext { flex:none; opacity:0; transition:opacity .15s ease; }
.loc:hover .ext { opacity:1; }
.loc.static { color:var(--muted); }
.count { padding:2px 7px; font-family:var(--font-mono); font-size:11px; color:var(--muted);
  background:var(--surface-2); border:1px solid var(--border); border-radius:999px; }
.spacer { flex:1; }
.done-btn { display:inline-flex; align-items:center; gap:7px; flex:none; font:inherit; font-size:12px; font-weight:600; cursor:pointer;
  padding:7px 13px; color:var(--muted); background:transparent; border:1px solid var(--border-strong); border-radius:999px;
  transition:color .15s ease, background .15s ease, border-color .15s ease; }
.done-btn:hover { color:var(--fg); border-color:rgba(69,192,122,.55); }
.done-btn:disabled { opacity:.55; cursor:not-allowed; }
.done-btn.is-done { color:var(--success); background:rgba(69,192,122,.14); border-color:rgba(69,192,122,.5); }
.card-title { margin:9px 0 0; padding:0 16px 20px; font-size:14px; font-weight:400; }
.card.done .card-title { color:#b7b7b7; text-decoration:line-through; text-decoration-color:rgba(255,255,255,.15); }
.card-body { display:flex; flex-direction:column; gap:12px; padding:20px 16px 15px; background:rgba(255,255,255,.012); border-top:1px solid var(--border); }
.meta-row { display:flex; flex-wrap:wrap; gap:14px; font-size:11.5px; color:var(--muted); }
.meta { display:inline-flex; align-items:center; gap:7px; }
.meta-k { font-size:10px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--muted-2); }
.meta code { padding:2px 6px; font-size:11.5px; color:var(--fg); background:rgba(255,255,255,.04); border:1px solid var(--border); border-radius:6px; }
.action-block { display:flex; gap:11px; padding:16px; background:var(--accent-soft); border:1px solid var(--accent-line); border-radius:var(--radius); }
.action-icon { flex:none; display:inline-block; margin-right:5px; margin-bottom:-5px; color:var(--accent); }
.action-label { display:inline-block; font-size:10px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); margin-right:5px; }
.action-block p { margin:0; font-size:13px; color:#f0ece6; }
.decision-tags-block { display:flex; align-items:center; gap:8px; }
.evidence { margin:0; padding: 16px; white-space:break-spaces; font-size:12px; line-height:1.6; color:#cdc7bf;
  background:#0b0b0e; border:1px solid var(--border); border-radius:var(--radius); }
.tags { display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin-left: auto; }
.tags-label { display:inline-flex; align-items:center; gap:6px; font-size:10px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--muted-2); }
.tag { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; font-family:var(--font-mono); font-size:11px; color:var(--muted);
  background:var(--surface-2); border:1px solid var(--border); border-radius:999px; }
.decisions { display:inline-flex; gap:3px; align-self:flex-start; padding:4px; background:var(--surface-2); border:1px solid var(--border); border-radius:999px; }
.dec-btn { font:inherit; font-size:12px; font-weight:600; cursor:pointer; color:var(--muted); padding:6px 15px;
  background:transparent; border:1px solid transparent; border-radius:999px; transition:color .15s ease, background .15s ease; }
.dec-btn:hover { color:var(--fg); }
.dec-btn:disabled { opacity:.55; cursor:not-allowed; }
.dec-btn.dec-execute.active { color:#1b1305; background:linear-gradient(180deg, var(--accent-strong), var(--accent)); }
.dec-btn.dec-ignore.active { color:#ffd2d3; background:rgba(242,89,94,.18); box-shadow:inset 0 0 0 1px rgba(242,89,94,.45); }
.dec-btn.dec-pending.active { color:var(--fg); background:rgba(255,255,255,.08); box-shadow:inset 0 0 0 1px var(--border-strong); }
.comment { position:relative; }
.comment textarea { width:100%; min-height:58px; padding:11px 13px 26px; resize:vertical; font:inherit; font-size:12.5px; line-height:1.5;
  color:var(--fg); background:var(--surface-2); border:1px solid var(--border-strong); border-radius:var(--radius); outline:none;
  transition:border-color .15s ease, box-shadow .15s ease; }
.comment textarea::placeholder { color:var(--muted-2); }
.comment textarea:focus { border-color:var(--accent-line); box-shadow:0 0 0 3px rgba(240,165,44,.12); }
.comment-status { position:absolute; right:12px; bottom:9px; display:inline-flex; align-items:center; gap:6px;
  font-family:var(--font-mono); font-size:11px; color:var(--muted); }
.comment-status.saved { color:var(--success); }
.artifacts { display:flex; flex-direction:column; }
.artifact-layout { display:grid; grid-template-columns:minmax(190px,250px) minmax(0,1fr); gap:16px; align-items:start; }
.artifact-list { display:flex; flex-direction:column; gap:14px; max-height:72vh; overflow:auto; padding:2px 4px 2px 0; }
.artifact-group { display:flex; flex-direction:column; gap:4px; }
.artifact-group-label { margin:0 0 2px; font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
.artifact-item { display:flex; flex-direction:column; gap:2px; text-align:left; cursor:pointer; font:inherit; color:var(--muted);
  padding:8px 10px; background:transparent; border:1px solid transparent; border-radius:10px;
  transition:background .15s ease, border-color .15s ease, color .15s ease; }
.artifact-item:hover { color:var(--fg); background:var(--surface-2); border-color:var(--border); }
.artifact-item.active { color:var(--fg); background:var(--accent-soft); border-color:var(--accent-line); }
.artifact-item-name { font-family:var(--font-mono); font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.artifact-item-kind { font-size:9.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--muted-2); }
.artifact-item.active .artifact-item-kind { color:var(--accent); }
.artifact-pane { min-width:0; }
.artifact-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; margin-bottom:12px; }
.artifact-title { margin:0 0 5px; font-family:var(--font-mono); font-size:13px; font-weight:600; word-break:break-word; }
.artifact-desc { margin:0; max-width:78ch; color:var(--muted); font-size:12.5px; line-height:1.55; }
.artifact-kind-badge { flex:none; display:inline-flex; align-items:center; padding:3px 9px; font-size:10px; font-weight:700;
  letter-spacing:.08em; text-transform:uppercase; color:var(--accent); background:var(--accent-soft);
  border:1px solid var(--accent-line); border-radius:999px; }
.artifact-view { margin:0; padding:14px 16px; max-height:70vh; overflow:auto; font-size:12px; line-height:1.6; color:#cdc7bf;
  background:#0b0b0e; border:1px solid var(--border); border-radius:var(--radius); }
.json-view { white-space:pre; }
.json-key { color:var(--accent-strong); }
.json-string { color:#9ddc8a; }
.json-number { color:#8fc7ff; }
.json-literal { color:#d7a6ff; }
.json-punct { color:#8d8a85; }
@media (max-width:900px) { .artifact-layout { grid-template-columns:1fr; } .artifact-list { max-height:240px; } }
.sent-tag { display:inline-flex; align-items:center; gap:5px; padding:2px 8px; font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase;
  color:var(--success); background:rgba(69,192,122,.12); border:1px solid rgba(69,192,122,.32); border-radius:999px; text-decoration:none; }
.sent-tag:hover { color:#fff; }
.modal-layer { position:fixed; inset:0; z-index:50; display:grid; place-items:center; padding:24px; }
.modal-backdrop { position:absolute; inset:0; width:100%; padding:0; background:rgba(5,5,7,.66); border:0; cursor:default; backdrop-filter:blur(5px); -webkit-backdrop-filter:blur(5px); }
.modal { position:relative; width:min(640px, 100%); max-height:min(78vh, 780px); display:flex; flex-direction:column; overflow:hidden;
  background:var(--surface); border:1px solid var(--border-strong); border-radius:var(--radius-lg); box-shadow:0 24px 70px rgba(0,0,0,.5); }
.modal-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:18px 20px 14px; border-bottom:1px solid var(--border); }
.modal-title { margin:0; font-size:17px; font-weight:700; letter-spacing:-.01em; }
.modal-sub { margin:5px 0 0; font-size:12px; color:var(--muted); line-height:1.5; }
.modal-close { flex:none; display:grid; place-items:center; width:30px; height:30px; font:inherit; font-size:19px; line-height:1; color:var(--muted); background:transparent; border:1px solid var(--border); border-radius:9px; cursor:pointer; }
.modal-close:hover { color:var(--fg); border-color:var(--border-strong); }
.modal-body { display:flex; flex-direction:column; gap:16px; padding:16px 20px; overflow-y:auto; }
.modal-foot { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 20px; background:var(--surface-2); border-top:1px solid var(--border); }
.submit-field { display:flex; flex-direction:column; gap:8px; }
.submit-label { font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted-2); }
.submit-summary { padding:13px 15px; font-size:12.5px; color:var(--fg); background:var(--accent-soft); border:1px solid var(--accent-line); border-radius:var(--radius); }
.submit-summary b { font-family:var(--font-mono); }
.submit-list { display:flex; flex-direction:column; gap:6px; max-height:240px; overflow-y:auto; padding-right:2px; }
.submit-item { display:flex; align-items:center; gap:10px; padding:8px 11px; font-size:12px; background:var(--surface-2); border:1px solid var(--border); border-radius:10px; }
.submit-item.sent { opacity:.7; }
.submit-item .rule { flex:1; min-width:0; color:var(--muted); overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.submit-empty { color:var(--muted); font-size:12.5px; }
.submit-field .chips { flex-wrap:wrap; }
.submit-check { display:inline-flex; align-items:center; gap:8px; font-size:12.5px; color:var(--muted); cursor:pointer; }
.submit-check input { accent-color:var(--accent); }
.submit-actions { display:flex; align-items:center; gap:8px; }
.sev-badge.sev-blocking { color:var(--blocking); background:rgba(242,89,94,.12); }
.sev-badge.sev-attention { color:var(--attention); background:rgba(237,161,58,.12); }
.sev-badge.sev-suggestion { color:var(--suggestion); background:rgba(90,164,240,.12); }
.sev-badge.sev-nit { color:var(--nit); background:rgba(255,255,255,.06); }
@keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.4; transform:scale(.8); } }
@keyframes spin { to { transform:rotate(360deg); } }
@media (max-width:980px) { .kpis { grid-template-columns:repeat(2, minmax(0,1fr)); } }
@media (max-width:820px) {
  .sidebar { width:232px; flex-basis:232px; }
  .topbar { padding:12px 16px; }
  .content { padding:18px 16px 56px; }
  .auto-refresh { display:none; }
}
`;

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
<style>${STYLES}</style>
</head>
<body>
<div id="app"></div>
<script type="module" src="/assets/app.js?v=${BUILD_ID}"></script>
</body>
</html>`;
}
