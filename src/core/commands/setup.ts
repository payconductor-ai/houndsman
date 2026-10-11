/**
 * Subcomando `setup` — cria a configuração inicial do houndsman no projeto.
 *
 * A camada gerada é **autocontida**: não importa o pacote `houndsman` em runtime
 * nem em tipos. Isso permite que o CLI seja instalado **globalmente** e usado com
 * `bun run houndsman` sem nenhuma dependência local.
 *
 * Gera:
 *   houndsman.config.ts           objeto de configuração (dados, sem imports do pacote)
 *   .houndsman/types.ts           snapshot dos tipos + helpers locais (tipagem sem install)
 *   .houndsman/reviewers/*.ts     revisores (objetos de dados)
 *   .houndsman/exclusions.ts      filtros
 *   .houndsman/doc-mappings.ts    path → docs
 *   .houndsman/skill/*.md         assets markdown do pacote (com {{projectName}})
 *   .{agents,claude}/skills/**    ponteiros de skill
 *   .houndsman/.gitignore         ignora `.runs/` (artefatos de revisão)
 *
 * Idempotente: não sobrescreve arquivos existentes sem `--force`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SKILL_DIR } from "../assets";

export type SetupOptions = {
	cwd: string;
	args: string[];
};

type Harness = "agents" | "claude";

/** Diretório da camada de projeto no repositório do consumidor. */
const PROJECT_DIR = ".houndsman";

const CONFIG_TEMPLATE = (
	projectName: string,
): string => `import { DOC_MAPPINGS } from "./${PROJECT_DIR}/doc-mappings";
import { EXCLUSION_PATTERNS } from "./${PROJECT_DIR}/exclusions";
import { REVIEWER_DEFINITIONS } from "./${PROJECT_DIR}/reviewers";
import type { ReviewConfig } from "./${PROJECT_DIR}/types";

/**
 * Configuração do houndsman para ${projectName}. Ajuste revisores, exclusões e
 * mapeamentos de docs conforme o projeto.
 *
 * \`reviewerIds\` é derivado das chaves de \`reviewers\` pelo CLI.
 */
export const reviewConfig = {
	projectName: "${projectName}",
	artifactDir: "${PROJECT_DIR}/.runs",
	outputFormatPath: "${PROJECT_DIR}/skill/OUTPUT-FORMAT.md",
	reviewers: REVIEWER_DEFINITIONS,
	exclusions: EXCLUSION_PATTERNS,
	docMappings: DOC_MAPPINGS,
} satisfies ReviewConfig;

export default reviewConfig;
`;

const TYPES_TEMPLATE = `/**
 * Tipos e helpers locais do houndsman (GERADO por \`houndsman setup\`).
 *
 * Snapshot do contrato público — permite tipar a camada de projeto sem depender
 * de um install local do pacote. Regenere com \`houndsman setup --force\`.
 */

export type Severity = "blocking" | "attention" | "suggestion";

/** Spec de pré-análise Jev (opcional, 3º item de uma regra). */
export type JevRuleSpec = boolean | string | Record<string, unknown>;

/** Regra anotada com severidade padrão: \`[severidade, descrição, jev?]\`. */
export type Rule = readonly [severity: Severity, description: string, jev?: JevRuleSpec];

/** Como o revisor casa um arquivo alterado. \`value\` é sempre regex. */
export type ClassifyRule = {
	type?: "filename" | "content";
	value: string;
};

export type ReviewerMeta = {
	name: string;
	scope: string;
	classify?: readonly ClassifyRule[];
	criticalRules: readonly Rule[];
	antiPatterns: readonly Rule[];
	contextFiles: string[];
};

/** Definição completa de um revisor — 1 por arquivo em \`${PROJECT_DIR}/reviewers/\`. */
export type ReviewerDefinition = ReviewerMeta & {
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
export type ReviewConfig<TId extends string = string> = {
	projectName: string;
	artifactDir: string;
	outputFormatPath?: string;
	reviewerIds?: readonly TId[];
	reviewers: Record<TId, ReviewerDefinition>;
	exclusions: readonly RegExp[];
	docMappings: readonly (readonly [RegExp, readonly string[]])[];
	alwaysIncludeDocs?: readonly string[];
};

/** Helper de autoria (identidade) — apenas tipagem. */
export function defineReviewer(definition: ReviewerDefinition): ReviewerDefinition {
	return definition;
}

/** Helper de autoria — deriva \`reviewerIds\` das chaves de \`reviewers\`. */
export function defineReviewConfig<TId extends string>(
	input: Omit<ReviewConfig<TId>, "reviewerIds">,
): ReviewConfig<TId> {
	return { ...input, reviewerIds: Object.keys(input.reviewers) as TId[] };
}
`;

const REVIEWER_EXAMPLE = `import { defineReviewer } from "../types";

/**
 * Revisor de exemplo — substitua pelas regras reais do projeto.
 * Um revisor declara seus arquivos via \`classify\` (regex de path ou conteúdo).
 */
export const exampleReviewer = defineReviewer({
	id: "example",
	name: "Exemplo",
	description: "Revisor de exemplo — descreva o propósito em uma frase.",
	scope: "Todo o repositório (ajuste o escopo)",
	classify: [{ value: "^src/" }],
	criticalRules: [["attention", "Descreva aqui uma regra crítica do projeto.", true]],
	antiPatterns: [["suggestion", "Descreva um anti-padrão a evitar."]],
	contextFiles: ["AGENTS.md"],
});
`;

const REVIEWERS_INDEX = `import { exampleReviewer } from "./example";

/**
 * Definições dos revisores — as chaves definem o union \`ReviewerId\`.
 * Adicionar um revisor = criar \`<id>.ts\` e registrá-lo aqui.
 */
export const REVIEWER_DEFINITIONS = {
	example: exampleReviewer,
};

export type ReviewerId = keyof typeof REVIEWER_DEFINITIONS;
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
 * Consumido pelo motor via \`ReviewConfig.docMappings\`.
 */
export const DOC_MAPPINGS: readonly (readonly [RegExp, readonly string[]])[] = [
	[/^src\\//, ["AGENTS.md"]],
];
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

type SetupContext = {
	cwd: string;
	projectName: string;
	harnesses: Harness[];
	force: boolean;
	created: string[];
	skipped: string[];
};

/** Escreve o arquivo somente se ausente (ou se `force`). */
function writeFile(target: SetupContext, relativePath: string, content: string): void {
	const full = join(target.cwd, relativePath);
	if (existsSync(full) && !target.force) {
		target.skipped.push(relativePath);
		return;
	}
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
	target.created.push(relativePath);
}

/** Copia os assets markdown do pacote, substituindo `{{projectName}}`. */
function copySkillAssets(target: SetupContext): void {
	for (const name of readdirSync(SKILL_DIR)) {
		if (!name.endsWith(".md")) continue;
		const raw = readFileSync(join(SKILL_DIR, name), "utf8");
		const rendered = raw.replaceAll("{{projectName}}", target.projectName);
		writeFile(target, join(PROJECT_DIR, "skill", name), rendered);
	}
}

/** Escreve os ponteiros de skill de um harness. */
function writeHarnessPointers(target: SetupContext, harness: Harness): void {
	const pointerDir = `.${harness}/skills`;
	writeFile(
		target,
		join(pointerDir, "houndsman", "SKILL.md"),
		SKILL_POINTER(
			"houndsman",
			target.projectName,
			".houndsman/skill/houndsman.md",
			"Revisa Pull Requests com revisores especializados por domínio. Orquestra `bun run houndsman context` → `bun run houndsman` → subagentes → `bun run houndsman --finalize`. Config em `houndsman.config.ts`; relatório em `.houndsman/runs/<branch>/review.md`.",
			"Nome da branch (opcional, detecta automaticamente se omitido)",
		),
	);
	writeFile(
		target,
		join(pointerDir, "update-houndsman", "SKILL.md"),
		SKILL_POINTER(
			"update-houndsman",
			target.projectName,
			".houndsman/skill/update-houndsman.md",
			"Atualiza as regras e protocolos do skill houndsman (revisores, exclusões, mapeamentos de docs).",
			"Revisor alvo (opcional)",
		),
	);
}

/**
 * Garante o script `houndsman` no `package.json` do projeto (para
 * `bun run houndsman [...]`), sem reformatar o restante do arquivo.
 */
function ensurePackageScript(target: SetupContext): void {
	const pkgPath = join(target.cwd, "package.json");
	if (!existsSync(pkgPath)) return;

	const key = "package.json#scripts.houndsman";
	const raw = readFileSync(pkgPath, "utf8");
	if (raw.includes('"houndsman"')) {
		target.skipped.push(key);
		return;
	}
	const scriptsBlock = /"scripts"\s*:\s*\{/;
	if (!scriptsBlock.test(raw)) return;

	writeFileSync(
		pkgPath,
		raw.replace(scriptsBlock, (match) => `${match}\n\t\t"houndsman": "houndsman",`),
	);
	target.created.push(key);
}

/**
 * Cria/atualiza `.houndsman/.gitignore` ignorando os artefatos de revisão (`.runs/`).
 * Fica dentro da camada de projeto — nada a adicionar no `.gitignore` da raiz.
 */
function ensureRunsGitignore(target: SetupContext): void {
	const relativePath = join(PROJECT_DIR, ".gitignore");
	const full = join(target.cwd, relativePath);
	const entry = ".runs/";
	const content = `# Artefatos de revisão (temporários) gerados pelo houndsman\n${entry}\n`;

	const existing = existsSync(full) ? readFileSync(full, "utf8") : null;
	const alreadyIgnored =
		existing?.split(/\r?\n/).some((line) => line.trim() === entry) ?? false;
	if (alreadyIgnored) {
		target.skipped.push(relativePath);
		return;
	}

	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, existing ? `${existing.trimEnd()}\n${content}` : content);
	target.created.push(relativePath);
}

function readFlag(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

/** Resolve os harnesses a configurar a partir de `--harness`. */
function resolveHarnesses(args: string[]): Harness[] {
	const raw = readFlag(args, "--harness");
	if (!raw || raw === "both") return ["agents", "claude"];
	if (raw === "none") return [];
	return raw
		.split(",")
		.map((value) => value.trim())
		.filter((value): value is Harness => value === "agents" || value === "claude");
}

/** Cria a configuração inicial do projeto. */
export async function runSetupCommand(options: SetupOptions): Promise<void> {
	const { args } = options;
	const projectName = readFlag(args, "--name") ?? basename(options.cwd);
	const target: SetupContext = {
		cwd: options.cwd,
		projectName,
		harnesses: resolveHarnesses(args),
		force: args.includes("--force"),
		created: [],
		skipped: [],
	};

	console.log(`→ Configurando houndsman em ${target.cwd} (projeto: ${projectName})`);

	writeFile(target, "houndsman.config.ts", CONFIG_TEMPLATE(projectName));
	writeFile(target, join(PROJECT_DIR, "types.ts"), TYPES_TEMPLATE);
	writeFile(target, join(PROJECT_DIR, "reviewers", "example.ts"), REVIEWER_EXAMPLE);
	writeFile(target, join(PROJECT_DIR, "reviewers", "index.ts"), REVIEWERS_INDEX);
	writeFile(target, join(PROJECT_DIR, "exclusions.ts"), EXCLUSIONS_TEMPLATE);
	writeFile(target, join(PROJECT_DIR, "doc-mappings.ts"), DOC_MAPPINGS_TEMPLATE);
	copySkillAssets(target);
	for (const harness of target.harnesses) writeHarnessPointers(target, harness);
	ensurePackageScript(target);
	ensureRunsGitignore(target);

	for (const path of target.created) console.log(`  + ${path}`);
	for (const path of target.skipped) console.log(`  = ${path} (mantido)`);

	console.log("\nPróximos passos:");
	console.log("  1. Ajuste `houndsman.config.ts` e `.houndsman/reviewers/`.");
	console.log("  2. Valide: bun run houndsman doctor");
	console.log("  3. Prepare a revisão: bun run houndsman");
}
