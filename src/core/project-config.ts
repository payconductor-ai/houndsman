/**
 * Configuração do projeto (domínio) — resolve defaults e expõe o registry.
 *
 * Evita o "data clump" de passar `HoundsmanConfig` para dezenas de funções:
 * quem precisa de orçamento/concorrência/watchdogs pede aqui.
 * O contrato do consumidor (`houndsman.config.ts`) não muda.
 */

import type { HoundsmanAst, HoundsmanConfig, HoundsmanStorage } from "./config";
import {
	DEFAULT_ALWAYS_INCLUDE_DOCS,
	DEFAULT_AST_MAX_FILE_BYTES,
	DEFAULT_AST_MAX_IMPACT_FILES,
	DEFAULT_JEV_CONCURRENCY,
	DEFAULT_MAX_FILES_PER_BRIEF,
} from "./defaults";
import { WatchdogRegistry } from "./watchdog-registry";

/** Configuração resolvida do projeto. */
export class ProjectConfig<TId extends string = string> {
	readonly raw: HoundsmanConfig<TId>;
	readonly watchdogs: WatchdogRegistry<TId>;

	constructor(raw: HoundsmanConfig<TId>) {
		this.raw = raw;
		this.watchdogs = new WatchdogRegistry(raw);
	}

	get projectName(): string {
		return this.raw.projectName;
	}

	get storage(): HoundsmanStorage {
		return this.raw.storage ?? {};
	}

	/** Config do AST (objeto vazio quando ausente). */
	get ast(): HoundsmanAst {
		return this.raw.ast ?? {};
	}

	/** AST habilitado (default: ligado; falhas de grammar são fail-open). */
	get astEnabled(): boolean {
		return this.ast.enabled !== false;
	}

	get astMaxFileBytes(): number {
		const value = this.ast.maxFileBytes;
		return value !== undefined && value > 0 ? value : DEFAULT_AST_MAX_FILE_BYTES;
	}

	get astMaxImpactFiles(): number {
		const value = this.ast.maxImpactFiles;
		return value !== undefined && value >= 0 ? value : DEFAULT_AST_MAX_IMPACT_FILES;
	}

	get maxFilesPerBrief(): number {
		const value = this.raw.budgets?.maxFilesPerBrief;
		return value !== undefined && value > 0 ? value : DEFAULT_MAX_FILES_PER_BRIEF;
	}

	get jevConcurrency(): number {
		const value = this.raw.concurrency?.jev;
		return value !== undefined && value > 0 ? value : DEFAULT_JEV_CONCURRENCY;
	}

	get alwaysIncludeDocs(): readonly string[] {
		return this.raw.alwaysIncludeDocs ?? DEFAULT_ALWAYS_INCLUDE_DOCS;
	}

	get exclusions(): readonly RegExp[] {
		return this.raw.exclusions;
	}

	get docMappings(): readonly (readonly [RegExp, readonly string[]])[] {
		return this.raw.docMappings;
	}
}
