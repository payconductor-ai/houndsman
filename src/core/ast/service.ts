/**
 * Serviço de AST (biblioteca) — fachada usada pelo engine/pipeline.
 *
 * Concentra parse, delta e impacto. É **fail-open**: sem grammar, arquivo
 * grande/binário, erro de git ou ABI incompatível, o resultado é vazio e a
 * revisão segue pelo caminho de regex.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { HoundsmanConfig } from "../config";
import type { DiffSource } from "../diff-source";
import { CORE_DIR } from "../paths";
import { ProjectConfig } from "../project-config";
import { GitRepository } from "../services/git-repository";
import { computeDelta } from "./diff";
import { buildImpact, resolveImport } from "./impact";
import { AstParser, languageForPath } from "./parser";
import type { AstAnalysis, AstEntry, AstFacts, AstImpact } from "./types";

/** Padrões de arquivos candidatos para a busca reversa de imports. */
const GREP_PATHSPECS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];

/** Serviço de análise estrutural por AST. */
export class AstService {
	private readonly project: ProjectConfig;
	private readonly git: GitRepository;
	private readonly parser: AstParser;

	constructor(
		config: HoundsmanConfig,
		git: GitRepository = new GitRepository(),
		root: string = process.cwd(),
	) {
		this.project = new ProjectConfig(config);
		this.git = git;
		// Camada do projeto (quando presente); sem ela o parser usa o wasm embarcado.
		const layerGrammars = join(root, CORE_DIR, "grammars");
		this.parser = new AstParser({
			maxFileBytes: this.project.astMaxFileBytes,
			languages: this.project.ast.languages,
			grammarDir: existsSync(layerGrammars) ? layerGrammars : undefined,
		});
	}

	/** `true` quando o AST está habilitado na configuração. */
	get enabled(): boolean {
		return this.project.astEnabled;
	}

	/**
	 * Smoke test do runtime/grammar (usado pelo `doctor`). Não lança: devolve o
	 * diagnóstico para o chamador decidir. Fail-open.
	 */
	async check(): Promise<{ ok: boolean; detail: string }> {
		if (!this.enabled) return { ok: true, detail: "desabilitado na config" };
		const facts = await this.parser.parseSource(
			"typescript",
			"export const houndsmanAstCheck = 1;\n",
		);
		return facts
			? { ok: true, detail: "typescript disponível" }
			: { ok: false, detail: "grammar indisponível ou ABI incompatível" };
	}

	/**
	 * Analisa os arquivos alterados: fatos da versão atual, delta contra a base
	 * e (para deletados) os fatos da última versão disponível.
	 */
	async analyze(
		entries: readonly AstEntry[],
		diff: DiffSource,
		baseRef: string,
	): Promise<Map<string, AstAnalysis>> {
		const analyses = new Map<string, AstAnalysis>();
		if (!this.enabled) return analyses;

		for (const entry of entries) {
			const language = languageForPath(entry.path, this.project.ast.languages);
			if (!language) continue;
			const patch = diff.byFile.get(entry.path) ?? "";

			if (entry.status === "deleted") {
				const oldContent = this.readAt(baseRef, entry.path);
				const facts = await this.parseContent(entry.path, oldContent);
				if (facts) {
					analyses.set(entry.path, {
						facts,
						delta: computeDelta(facts, null, patch),
						deleted: true,
					});
				}
				continue;
			}

			const current = this.readWorkingFile(entry.path);
			if (current === null) continue;
			const facts = await this.parser.parseFile(entry.path, current);
			if (!facts) continue;

			const oldPath = entry.oldPath ?? entry.path;
			const oldContent =
				entry.status === "added" ? null : this.readAt(baseRef, oldPath);
			const before = oldContent
				? await this.parseContent(oldPath, oldContent)
				: null;

			analyses.set(entry.path, {
				facts,
				delta: computeDelta(before, facts, patch),
			});
		}

		return analyses;
	}

	/**
	 * Descobre importadores dos arquivos alterados. A busca é heurística e
	 * limitada por `ast.maxImpactFiles`: usa `git grep` pelo nome do módulo,
	 * depois confirma o import resolvido (relativo/alias) no candidato.
	 */
	async impact(analyses: ReadonlyMap<string, AstAnalysis>): Promise<AstImpact> {
		const changed = [...analyses.keys()];
		const importersByFile = new Map<string, Set<string>>();
		for (const file of changed) importersByFile.set(file, new Set<string>());
		if (!this.enabled || changed.length === 0) {
			return buildImpact(analyses, importersByFile);
		}

		const maxCandidates = this.project.astMaxImpactFiles;
		if (maxCandidates <= 0) return buildImpact(analyses, importersByFile);

		const changedSet = new Set(changed);
		const candidates = this.candidateFiles(changed, maxCandidates);
		const cache = new Map<string, AstFacts | null>();

		for (const candidate of candidates) {
			const content = this.readWorkingFile(candidate);
			if (content === null) continue;
			let facts: AstFacts | null;
			if (cache.has(candidate)) {
				facts = cache.get(candidate) ?? null;
			} else {
				facts = await this.parser.parseFile(candidate, content);
				cache.set(candidate, facts);
			}
			if (!facts) continue;

			for (const item of facts.imports) {
				const resolved = resolveImport(
					candidate,
					item.source,
					this.project.ast.aliases ?? {},
					(path) => existsSync(path) || changedSet.has(path),
				);
				if (!resolved) continue;
				const importers = importersByFile.get(resolved);
				if (importers) importers.add(candidate);
			}
		}

		return buildImpact(analyses, importersByFile);
	}

	/** Fatos estruturais do arquivo atual (usado pelo motor e pelo server). */
	async factsOf(filePath: string): Promise<AstFacts | null> {
		if (!this.enabled) return null;
		const content = this.readWorkingFile(filePath);
		if (content === null) return null;
		return this.parser.parseFile(filePath, content);
	}

	/** Lê o conteúdo atual do arquivo; `null` se ausente/ilegível. */
	private readWorkingFile(filePath: string): string | null {
		try {
			return readFileSync(filePath, "utf8");
		} catch {
			return null;
		}
	}

	/** Lê o conteúdo de um arquivo numa ref; `null` se ausente. */
	private readAt(ref: string, filePath: string): string | null {
		if (!ref) return null;
		try {
			return this.git.readFileAt(ref, filePath);
		} catch {
			return null;
		}
	}

	/** Parseia conteúdo textual reaproveitando a linguagem do caminho. */
	private async parseContent(
		filePath: string,
		content: string | null,
	): Promise<AstFacts | null> {
		if (!content) return null;
		const language = languageForPath(filePath, this.project.ast.languages);
		if (!language) return null;
		return this.parser.parseSource(language, content);
	}

	/** Candidatos a importadores via `git grep` pelo nome do módulo. */
	private candidateFiles(changed: readonly string[], maxCandidates: number): string[] {
		const candidates = new Set<string>();
		for (const file of changed) {
			for (const needle of needlesFor(file)) {
				const result = this.git.tryRun([
					"grep",
					"-l",
					"-I",
					"-F",
					"-e",
					needle,
					"--",
					...GREP_PATHSPECS,
				]);
				for (const line of result.stdout.split("\n")) {
					const candidate = line.trim().replace(/\\/g, "/");
					if (!candidate) continue;
					candidates.add(candidate);
					if (candidates.size >= maxCandidates) return [...candidates];
				}
			}
		}
		return [...candidates].sort();
	}
}

/** Nomes usados para localizar importadores de um arquivo. */
function needlesFor(filePath: string): string[] {
	const extension = extname(filePath);
	const withoutExtension = extension ? filePath.slice(0, -extension.length) : filePath;
	const base = basename(withoutExtension);
	if (base !== "index") return base.length >= 2 ? [base] : [];
	const directory = basename(dirname(filePath));
	return directory.length >= 2 ? [directory] : [];
}
