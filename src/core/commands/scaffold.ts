/**
 * Scaffold da camada de projeto (`.houndsman/`) — templates e helpers.
 *
 * Separa o que é **auto-gerado** (sincronizável com `houndsman update`) do que é
 * **do usuário**:
 *
 *   .houndsman/
 *   ├── .gitignore          AUTO — ignora core/ (gerado)
 *   ├── core/types.ts       AUTO — snapshot dos tipos + helpers
 *   ├── core/skill/*.md     AUTO — docs do skill (com {{projectName}} resolvido)
 *   ├── core/grammars/*.wasm AUTO — runtime + grammars do AST
 *   ├── watchdogs/*.ts      USUÁRIO
 *   ├── doc-mappings.ts     USUÁRIO
 *   └── exclusions.ts       USUÁRIO
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { GRAMMAR_FILES, grammarPath, SKILL_DIR, SKILL_FILE } from "../assets";
import { CORE_DIR, CORE_SKILL_DIR, OUTPUT_FORMAT_PATH, PROJECT_DIR } from "../paths";

export type Harness = "agents" | "claude";

export type ScaffoldContext = {
	cwd: string;
	projectName: string;
	harnesses: Harness[];
	/** Sobrescreve também os arquivos do usuário (só o `setup --force`). */
	force: boolean;
	/** Arquivos do usuário criados/sobrescritos. */
	created: string[];
	/** Arquivos auto-gerados (re)escritos. */
	generated: string[];
	/** Arquivos do usuário mantidos (já existiam). */
	skipped: string[];
};

function readFlag(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

/** Resolve os harnesses a configurar a partir de `--harness`. */
export function resolveHarnesses(args: string[]): Harness[] {
	const raw = readFlag(args, "--harness");
	if (!raw || raw === "both") return ["agents", "claude"];
	if (raw === "none") return [];
	return raw
		.split(",")
		.map((value) => value.trim())
		.filter((value): value is Harness => value === "agents" || value === "claude");
}

/** Monta o contexto do scaffold (nome do projeto, harnesses, flags). */
export function createScaffoldContext(
	cwd: string,
	args: string[],
	force: boolean,
): ScaffoldContext {
	return {
		cwd,
		projectName: readFlag(args, "--name") ?? basename(cwd),
		harnesses: resolveHarnesses(args),
		force,
		created: [],
		generated: [],
		skipped: [],
	};
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const CONFIG_TEMPLATE = (
	projectName: string,
): string => `import { DOC_MAPPINGS } from "./${PROJECT_DIR}/doc-mappings";
import { EXCLUSION_PATTERNS } from "./${PROJECT_DIR}/exclusions";
import { WATCHDOG_DEFINITIONS } from "./${PROJECT_DIR}/watchdogs";
import type { HoundsmanConfig } from "./${CORE_DIR}/types";

/**
 * Configuração do houndsman para ${projectName}.
 *
 * Runs, findings e artefatos vivem no storage global (SQLite por default) —
 * fora do projeto. O schema de output fica em ${OUTPUT_FORMAT_PATH}. Ajuste
 * watchdogs, exclusões e mapeamentos de docs conforme o projeto.
 */
export const houndsmanConfig = {
	projectName: "${projectName}",
	watchdogs: WATCHDOG_DEFINITIONS,
	exclusions: EXCLUSION_PATTERNS,
	docMappings: DOC_MAPPINGS,
} satisfies HoundsmanConfig;

export default houndsmanConfig;
`;

const TYPES_TEMPLATE = `/**
 * Tipos e helpers locais do houndsman (GERADO — não edite).
 *
 * Snapshot do contrato público, para tipar a camada de projeto sem depender de um
 * install local do pacote. Sincronize com \`houndsman update\`.
 */

export type Severity = "blocking" | "attention" | "suggestion" | "nit";

/** Tipo de pergunta aceito pela API Jev. */
export type JevQuestionType = "noul" | "choice" | "score";

/**
 * Spec de pré-análise Jev (opcional) — sempre um objeto; \`kind\` é obrigatório.
 * \`criteria\`: objeto para \`choice\`, lista para \`score\`.
 */
export type JevRuleSpec = {
	kind: JevQuestionType;
	instructions?: string;
	criteria?: string[] | Record<string, string>;
};

/** Regra do watchdog: severidade + texto — o texto declara a polaridade
 *  (\`Promover:\` = deve acontecer; \`Evitar:\`/\`Não\`/\`Nunca\` = não deve acontecer). */
export type Rule = {
	severity: Severity;
	text: string;
	jev?: JevRuleSpec;
	hints?: RuleHints;
};

/** Sinais opcionais de uma regra (símbolos, imports, decorators, paths, checks). */
export type RuleHints = {
	symbols?: string[];
	imports?: string[];
	decorators?: string[];
	paths?: string[];
	checks?: string[];
};

/** Como o watchdog casa um arquivo alterado. \`value\` é sempre regex. */
export type ClassifyRule = {
	type?: "filename" | "content" | "symbol" | "import" | "export" | "decorator";
	value: string;
};

export type WatchdogMeta = {
	name: string;
	scope: string;
	classify?: readonly ClassifyRule[];
	rules: readonly Rule[];
	contextFiles: string[];
};

/** Definição completa de um watchdog — 1 por arquivo em \`${PROJECT_DIR}/watchdogs/\`. */
export type WatchdogDefinition = WatchdogMeta & {
	id: string;
	description: string;
	breakingChange?: boolean;
	/** Só assume arquivos que nenhum outro watchdog casou. */
	fallback?: boolean;
	/** Permite findings emergentes (Lógica:/Domínio:) fora das regras. */
	allowEmergentFindings?: boolean;
	reviewFocus?: readonly string[];
	exclude?: readonly string[];
};

export type FileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "unknown";

export type FileStatusMap = Record<string, { status: FileStatus; oldPath?: string }>;

/** Linhas adicionadas/removidas de um arquivo no diff (churn). */
export type FileChurn = { additions: number; deletions: number };

/** Churn por caminho de arquivo. */
export type ChurnMap = Record<string, FileChurn>;

/** Limites de triage para PRs grandes. */
export type HoundsmanBudgets = {
	/** Máx. de arquivos por brief (default: 40). Excedente vai para "fora do orçamento". */
	maxFilesPerBrief?: number;
};

/** Concorrência das fases paralelas internas. */
export type HoundsmanConcurrency = {
	/** Chamadas Jev simultâneas (default: 5). */
	jev?: number;
};

/** Backend de persistência (reviews, findings e artefatos). */
export type HoundsmanStorage = {
	provider?: "sqlite" | "file";
	path?: string;
};

/** Linguagens suportadas pelo AST na primeira fase. */
export type AstLanguage = "typescript" | "tsx" | "javascript";

/** Configuração do AST determinístico (classificação estrutural, brief e impacto). */
export type HoundsmanAst = {
	enabled?: boolean;
	maxFileBytes?: number;
	maxImpactFiles?: number;
	languages?: Record<string, AstLanguage>;
	aliases?: Record<string, string>;
};

/** Providers suportados pela camada de IA. */
export type AiProviderKind = "deepseek" | "openai" | "anthropic";

/** Features de IA do fluxo normal (todas fail-open). */
export type HoundsmanAiFeatures = {
	context?: boolean;
	brief?: boolean;
	classification?: boolean;
	preAnalysis?: boolean;
	verify?: boolean;
};

/** Overrides de IA por watchdog. */
export type HoundsmanAiWatchdog = {
	model?: string;
	maxSteps?: number;
	maxOutputTokens?: number;
};

/** Configuração da camada de IA (briefs, contexto, classificação e hunt nativo). */
export type HoundsmanAi = {
	enabled?: boolean;
	provider?: AiProviderKind;
	model?: string;
	baseURL?: string;
	concurrency?: number;
	maxSteps?: number;
	maxOutputTokens?: number;
	temperature?: number;
	timeoutMs?: number;
	maxCallsPerReview?: number;
	maxTokensPerReview?: number;
	features?: HoundsmanAiFeatures;
	watchdogs?: Record<string, HoundsmanAiWatchdog>;
};

/** Contrato de configuração do motor. */
export type HoundsmanConfig<TId extends string = string> = {
	projectName: string;
	storage?: HoundsmanStorage;
	watchdogIds?: readonly TId[];
	watchdogs: Record<TId, WatchdogDefinition>;
	exclusions: readonly RegExp[];
	docMappings: readonly (readonly [RegExp, readonly string[]])[];
	alwaysIncludeDocs?: readonly string[];
	budgets?: HoundsmanBudgets;
	concurrency?: HoundsmanConcurrency;
	ast?: HoundsmanAst;
	ai?: HoundsmanAi;
};

/** Helper de autoria (identidade) — apenas tipagem. */
export function defineWatchdog(definition: WatchdogDefinition): WatchdogDefinition {
	return definition;
}

/** Helper de autoria — deriva \`watchdogIds\` das chaves de \`watchdogs\`. */
export function defineHoundsmanConfig<TId extends string>(
	input: Omit<HoundsmanConfig<TId>, "watchdogIds">,
): HoundsmanConfig<TId> {
	return { ...input, watchdogIds: Object.keys(input.watchdogs) as TId[] };
}
`;

const WATCHDOG_EXAMPLE = `import { defineWatchdog } from "../core/types";

/**
 * Watchdog de exemplo — substitua pelas regras reais do projeto.
 * Um watchdog declara seus arquivos via \`classify\` (regex de path, conteúdo ou
 * fatos AST: \`symbol\`/\`import\`/\`export\`/\`decorator\`).
 * O texto de cada regra começa com a polaridade: \`Promover:\` (DEVE acontecer)
 * ou \`Evitar:\`/\`Não\`/\`Nunca\` (NÃO DEVE acontecer).
 */
export const exampleWatchdog = defineWatchdog({
	id: "example",
	name: "Exemplo",
	description: "Watchdog de exemplo — descreva o propósito em uma frase.",
	scope: "src/example/** (ajuste o escopo)",
	classify: [{ value: "^src/example/" }],
	rules: [
		{
			severity: "attention",
			text: "Promover: descreva aqui um padrão do projeto (algo que DEVE acontecer).",
			jev: { kind: "noul" },
		},
		{
			severity: "nit",
			text: "Evitar: descreva aqui um anti-padrão (algo que NÃO DEVE acontecer).",
		},
	],
	contextFiles: ["AGENTS.md"],
});
`;

const DEFAULT_WATCHDOG = `import { defineWatchdog } from "../core/types";

/**
 * Watchdog de padrões gerais e lógica (fallback).
 *
 * Só assume arquivos que nenhum outro watchdog casou. Cobre consistência
 * lógica, invariantes de domínio e defeitos genéricos que não pertencem a um
 * domínio específico. Findings fora das regras abaixo podem ser reportados com
 * os prefixos reservados "Lógica:" e "Domínio:" (opt-in abaixo).
 */
export const defaultWatchdog = defineWatchdog({
	id: "default",
	name: "Padrões gerais e lógica",
	description:
		"Cobre arquivos sem domínio específico: consistência lógica, domínio e defeitos genéricos.",
	scope: "Arquivos não classificados por outros watchdogs",
	fallback: true,
	allowEmergentFindings: true,
	rules: [
		{
			severity: "attention",
			text: "Promover: nome, contrato e documentação do símbolo correspondem ao comportamento real.",
			hints: { checks: ["symbol_context"] },
		},
		{
			severity: "attention",
			text: "Evitar: engolir erros/exceções sem propagar, logar ou tratar.",
		},
		{
			severity: "attention",
			text: "Promover: transições de estado e efeitos colaterais do domínio são explícitos, ordenados e idempotentes.",
		},
		{
			severity: "suggestion",
			text: "Evitar: lógica de negócio duplicada ou divergente entre camadas.",
			hints: { checks: ["find_references"] },
		},
		{
			severity: "suggestion",
			text: "Promover: casos de borda do domínio (vazio, zero, negativo, timezone, arredondamento) são tratados.",
		},
		{
			severity: "suggestion",
			text: "Promover: a lógica do domínio respeita as invariantes e contratos documentados.",
		},
	],
	contextFiles: ["AGENTS.md"],
});
`;

const WATCHDOGS_INDEX = `import { defaultWatchdog } from "./default";
import { exampleWatchdog } from "./example";

/**
 * Definições dos watchdogs — as chaves definem o union \`WatchdogId\`.
 * Adicionar um watchdog = criar \`<id>.ts\` e registrá-lo aqui.
 */
export const WATCHDOG_DEFINITIONS = {
	default: defaultWatchdog,
	example: exampleWatchdog,
};

export type WatchdogId = keyof typeof WATCHDOG_DEFINITIONS;
`;

const EXCLUSIONS_TEMPLATE = `/** Arquivos que nunca entram na revisão — gerados, locks, builds. */
export const EXCLUSION_PATTERNS: readonly RegExp[] = [
	/bun\\.lockb?$/,
	/^package-lock\\.json$/,
	/^dist\\//,
	/^build\\//,
];

/** \`true\` se o caminho é excluído da revisão. */
export function isExcluded(filePath: string): boolean {
	return EXCLUSION_PATTERNS.some((pattern) => pattern.test(filePath));
}
`;

const DOC_MAPPINGS_TEMPLATE = `/**
 * Mapeamento de padrões nos paths → documentação relevante.
 * Consumido pelo motor via \`HoundsmanConfig.docMappings\`.
 *
 * Exemplo: [/^src\\//, ["README.md"]]
 */
export const DOC_MAPPINGS: readonly (readonly [RegExp, readonly string[]])[] = [];
`;

const PROJECT_GITIGNORE = `# Diretórios gerados pelo houndsman — \`core/\` é regenerado por \`houndsman update\`.
# \`work/\` e \`worktrees/\` são runtime de revisão (staging e worktrees).
core/
.runs/
work/
worktrees/
`;

// ---------------------------------------------------------------------------
// Templates (arquivo → conteúdo)
// ---------------------------------------------------------------------------

/** Contexto de render de um template. */
type TemplateContext = { projectName: string };

/** Um arquivo da camada (caminho relativo + conteúdo). */
interface ScaffoldTemplate {
	readonly path: string;
	render(context: TemplateContext): string;
}

class ConfigTemplate implements ScaffoldTemplate {
	readonly path = "houndsman.config.ts";

	render(context: TemplateContext): string {
		return CONFIG_TEMPLATE(context.projectName);
	}
}

class WatchdogExampleTemplate implements ScaffoldTemplate {
	readonly path = join(PROJECT_DIR, "watchdogs", "example.ts");

	render(): string {
		return WATCHDOG_EXAMPLE;
	}
}

class DefaultWatchdogTemplate implements ScaffoldTemplate {
	readonly path = join(PROJECT_DIR, "watchdogs", "default.ts");

	render(): string {
		return DEFAULT_WATCHDOG;
	}
}

class WatchdogsIndexTemplate implements ScaffoldTemplate {
	readonly path = join(PROJECT_DIR, "watchdogs", "index.ts");

	render(): string {
		return WATCHDOGS_INDEX;
	}
}

class ExclusionsTemplate implements ScaffoldTemplate {
	readonly path = join(PROJECT_DIR, "exclusions.ts");

	render(): string {
		return EXCLUSIONS_TEMPLATE;
	}
}

class DocMappingsTemplate implements ScaffoldTemplate {
	readonly path = join(PROJECT_DIR, "doc-mappings.ts");

	render(): string {
		return DOC_MAPPINGS_TEMPLATE;
	}
}

class TypesTemplate implements ScaffoldTemplate {
	readonly path = join(CORE_DIR, "types.ts");

	render(): string {
		return TYPES_TEMPLATE;
	}
}

class GitignoreTemplate implements ScaffoldTemplate {
	readonly path = join(PROJECT_DIR, ".gitignore");

	render(): string {
		return PROJECT_GITIGNORE;
	}
}

class SkillDocTemplate implements ScaffoldTemplate {
	private readonly fileName: string;

	constructor(fileName: string) {
		this.fileName = fileName;
	}

	get path(): string {
		return join(CORE_SKILL_DIR, this.fileName);
	}

	render(context: TemplateContext): string {
		return readFileSync(join(SKILL_DIR, this.fileName), "utf8").replaceAll(
			"{{projectName}}",
			context.projectName,
		);
	}
}

class HarnessPointerTemplate implements ScaffoldTemplate {
	private readonly harness: Harness;

	constructor(harness: Harness) {
		this.harness = harness;
	}

	get path(): string {
		return join(`.${this.harness}`, "skills", "houndsman", SKILL_FILE);
	}

	render(context: TemplateContext): string {
		return readFileSync(join(SKILL_DIR, SKILL_FILE), "utf8").replaceAll(
			"{{projectName}}",
			context.projectName,
		);
	}
}

// ---------------------------------------------------------------------------
// Scaffolder
// ---------------------------------------------------------------------------

/** Escreve as camadas do projeto (`setup`) e sincroniza os auto-gerados (`update`). */
export class ProjectScaffolder {
	private readonly ctx: ScaffoldContext;

	constructor(ctx: ScaffoldContext) {
		this.ctx = ctx;
	}

	/** Arquivos do usuário: config, watchdogs, exclusões e mapeamentos. */
	writeUserLayer(): void {
		const context = this.context();
		const templates: ScaffoldTemplate[] = [
			new ConfigTemplate(),
			new DefaultWatchdogTemplate(),
			new WatchdogExampleTemplate(),
			new WatchdogsIndexTemplate(),
			new ExclusionsTemplate(),
			new DocMappingsTemplate(),
		];
		for (const template of templates) this.writeUserFile(template, context);
	}

	/** Arquivos auto-gerados (sempre sobrescritos). */
	syncGenerated(): void {
		const context = this.context();
		this.writeGeneratedFile(new TypesTemplate(), context);
		this.writeGeneratedFile(new GitignoreTemplate(), context);
		this.syncGrammars();

		// Docs do skill vão para `.houndsman/core/skill/`. O `SKILL.md` é o entry
		// point dos harnesses, não um doc da camada.
		for (const name of readdirSync(SKILL_DIR)) {
			if (!name.endsWith(".md") || name === SKILL_FILE) continue;
			this.writeGeneratedFile(new SkillDocTemplate(name), context);
		}

		for (const harness of this.ctx.harnesses) {
			this.writeGeneratedFile(new HarnessPointerTemplate(harness), context);
		}
	}

	/**
	 * Copia as grammars wasm para a camada. O consumidor não precisa rodar nada:
	 * `setup` e `update` sincronizam os binários junto dos demais auto-gerados.
	 */
	private syncGrammars(): void {
		const directory = join(this.ctx.cwd, CORE_DIR, "grammars");
		mkdirSync(directory, { recursive: true });
		for (const name of GRAMMAR_FILES) {
			copyFileSync(grammarPath(name), join(directory, name));
		}
		this.ctx.generated.push(join(CORE_DIR, "grammars", "*.wasm"));
	}

	private context(): TemplateContext {
		return { projectName: this.ctx.projectName };
	}

	/** Usuário: só escreve se ausente (ou `force`). */
	private writeUserFile(template: ScaffoldTemplate, context: TemplateContext): void {
		const full = join(this.ctx.cwd, template.path);
		if (existsSync(full) && !this.ctx.force) {
			this.ctx.skipped.push(template.path);
			return;
		}
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, template.render(context));
		this.ctx.created.push(template.path);
	}

	/** Auto-gerado: sempre sobrescreve. */
	private writeGeneratedFile(
		template: ScaffoldTemplate,
		context: TemplateContext,
	): void {
		const full = join(this.ctx.cwd, template.path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, template.render(context));
		this.ctx.generated.push(template.path);
	}
}

// ---------------------------------------------------------------------------
// Fachada (compatibilidade)
// ---------------------------------------------------------------------------

/** Arquivos do usuário (setup). */
export function writeUserLayer(ctx: ScaffoldContext): void {
	new ProjectScaffolder(ctx).writeUserLayer();
}

/** Arquivos auto-gerados (setup/update). */
export function syncGeneratedFiles(ctx: ScaffoldContext): void {
	new ProjectScaffolder(ctx).syncGenerated();
}
