/**
 * Scaffold da camada de projeto (`.houndsman/`) — templates e helpers.
 *
 * Separa o que é **auto-gerado** (sincronizável com `houndsman update`) do que é
 * **do usuário**:
 *
 *   .houndsman/
 *   ├── .gitignore          AUTO — ignora core/ e .runs/ (gerados/temporários)
 *   ├── core/types.ts       AUTO — snapshot dos tipos + helpers
 *   ├── core/skill/*.md     AUTO — docs do skill (com {{projectName}} resolvido)
 *   ├── watchdogs/*.ts      USUÁRIO
 *   ├── doc-mappings.ts     USUÁRIO
 *   └── exclusions.ts       USUÁRIO
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SKILL_DIR } from "../assets";
import {
	ARTIFACT_DIR,
	CORE_DIR,
	CORE_SKILL_DIR,
	OUTPUT_FORMAT_PATH,
	PROJECT_DIR,
} from "../paths";

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
 * Caminhos são resolvidos pela camada: artefatos em ${ARTIFACT_DIR} e schema de
 * output em ${OUTPUT_FORMAT_PATH}. Ajuste watchdogs, exclusões e mapeamentos de
 * docs conforme o projeto.
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
};

/** Como o watchdog casa um arquivo alterado. \`value\` é sempre regex. */
export type ClassifyRule = {
	type?: "filename" | "content";
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

/** Contrato de configuração do motor. */
export type HoundsmanConfig<TId extends string = string> = {
	projectName: string;
	artifactDir?: string;
	watchdogIds?: readonly TId[];
	watchdogs: Record<TId, WatchdogDefinition>;
	exclusions: readonly RegExp[];
	docMappings: readonly (readonly [RegExp, readonly string[]])[];
	alwaysIncludeDocs?: readonly string[];
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
 * Um watchdog declara seus arquivos via \`classify\` (regex de path ou conteúdo).
 * O texto de cada regra começa com a polaridade: \`Promover:\` (DEVE acontecer)
 * ou \`Evitar:\`/\`Não\`/\`Nunca\` (NÃO DEVE acontecer).
 */
export const exampleWatchdog = defineWatchdog({
	id: "example",
	name: "Exemplo",
	description: "Watchdog de exemplo — descreva o propósito em uma frase.",
	scope: "Todo o repositório (ajuste o escopo)",
	classify: [{ value: "^src/" }],
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

const WATCHDOGS_INDEX = `import { exampleWatchdog } from "./example";

/**
 * Definições dos watchdogs — as chaves definem o union \`WatchdogId\`.
 * Adicionar um watchdog = criar \`<id>.ts\` e registrá-lo aqui.
 */
export const WATCHDOG_DEFINITIONS = {
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
 */
export const DOC_MAPPINGS: readonly (readonly [RegExp, readonly string[]])[] = [
	[/^src\\//, ["AGENTS.md"]],
];
`;

const PROJECT_GITIGNORE = `# Diretórios gerados pelo houndsman — \`core/\` é regenerado por \`houndsman update\`
# e \`.runs/\` guarda os artefatos de revisão.
core/
.runs/
`;

const SKILL_POINTER = (
	name: string,
	projectName: string,
	canonical: string,
	description: string,
	argumentHint: string,
): string => `---
name: ${name}
description: '${description}'
argument-hint: '${argumentHint}'
---

# ${name} — ${projectName}

> **Ponteiro.** O conteúdo canônico está em \`${canonical}\`.

Leia e siga \`${canonical}\`.
`;

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

/** Escreve um arquivo do usuário somente se ausente (ou se `force`). */
function writeUserFile(
	ctx: ScaffoldContext,
	relativePath: string,
	content: string,
): void {
	const full = join(ctx.cwd, relativePath);
	if (existsSync(full) && !ctx.force) {
		ctx.skipped.push(relativePath);
		return;
	}
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
	ctx.created.push(relativePath);
}

/** Escreve/sobrescreve um arquivo auto-gerado. */
function writeGeneratedFile(
	ctx: ScaffoldContext,
	relativePath: string,
	content: string,
): void {
	const full = join(ctx.cwd, relativePath);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
	ctx.generated.push(relativePath);
}

// ---------------------------------------------------------------------------
// Camadas
// ---------------------------------------------------------------------------

/** Arquivos do usuário: config, watchdogs, exclusões e mapeamentos. */
export function writeUserLayer(ctx: ScaffoldContext): void {
	writeUserFile(ctx, "houndsman.config.ts", CONFIG_TEMPLATE(ctx.projectName));
	writeUserFile(ctx, join(PROJECT_DIR, "watchdogs", "example.ts"), WATCHDOG_EXAMPLE);
	writeUserFile(ctx, join(PROJECT_DIR, "watchdogs", "index.ts"), WATCHDOGS_INDEX);
	writeUserFile(ctx, join(PROJECT_DIR, "exclusions.ts"), EXCLUSIONS_TEMPLATE);
	writeUserFile(ctx, join(PROJECT_DIR, "doc-mappings.ts"), DOC_MAPPINGS_TEMPLATE);
}

/**
 * Arquivos auto-gerados: tipos, docs do skill, `.gitignore` (ignora `core/` e
 * `.runs/`) e os ponteiros de skill dos harnesses. Sempre sobrescritos (é o
 * alvo do `update`).
 */
export function syncGeneratedFiles(ctx: ScaffoldContext): void {
	writeGeneratedFile(ctx, join(CORE_DIR, "types.ts"), TYPES_TEMPLATE);
	writeGeneratedFile(ctx, join(PROJECT_DIR, ".gitignore"), PROJECT_GITIGNORE);

	for (const name of readdirSync(SKILL_DIR)) {
		if (!name.endsWith(".md")) continue;
		const raw = readFileSync(join(SKILL_DIR, name), "utf8");
		writeGeneratedFile(
			ctx,
			join(CORE_SKILL_DIR, name),
			raw.replaceAll("{{projectName}}", ctx.projectName),
		);
	}

	for (const harness of ctx.harnesses) writeHarnessPointers(ctx, harness);
}

/** Escreve os ponteiros de skill de um harness. */
function writeHarnessPointers(ctx: ScaffoldContext, harness: Harness): void {
	const pointerDir = `.${harness}/skills`;
	writeGeneratedFile(
		ctx,
		join(pointerDir, "houndsman", "SKILL.md"),
		SKILL_POINTER(
			"houndsman",
			ctx.projectName,
			`${CORE_SKILL_DIR}/houndsman.md`,
			"Revisa Pull Requests com watchdogs especializados por domínio. Orquestra `bun run houndsman context` → `bun run houndsman` → subagentes → `bun run houndsman --finalize`. Config em `houndsman.config.ts`; regras em `.houndsman/`; relatório em `.houndsman/.runs/<branch-slug>/review.md`.",
			"Nome da branch (opcional, detecta automaticamente se omitido)",
		),
	);
	writeGeneratedFile(
		ctx,
		join(pointerDir, "houndsman-update", "SKILL.md"),
		SKILL_POINTER(
			"houndsman-update",
			ctx.projectName,
			`${CORE_SKILL_DIR}/houndsman-update.md`,
			"Atualiza as regras e protocolos do skill houndsman (watchdogs, exclusões, mapeamentos de docs).",
			"Watchdog alvo (opcional)",
		),
	);
}
