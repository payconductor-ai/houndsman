/**
 * Registro das tools built-in do harness.
 *
 * Adicionar uma tool = criar a classe + registrar aqui + contract test. O
 * `ReviewAgent` não muda.
 */

import type { ToolModule, ToolRegistryLike } from "../agent-tool";
import { ChangedSymbolsTool } from "./changed-symbols-tool";
import { DocContextTool } from "./doc-context-tool";
import { FileOutlineTool } from "./file-outline-tool";
import { FindReferencesTool } from "./find-references-tool";
import { FindSymbolTool } from "./find-symbol-tool";
import { ImpactTool } from "./impact-tool";
import { ImportsExportsTool } from "./imports-exports-tool";
import { ListFilesTool } from "./list-files-tool";
import { PrContextTool } from "./pr-context-tool";
import { ReadFileRangeTool } from "./read-file-range-tool";
import { RuleSignalsTool } from "./rule-signals-tool";
import { SearchCodeTool } from "./search-code-tool";
import { SymbolContextTool } from "./symbol-context-tool";
import { TestsForSymbolTool } from "./tests-for-symbol-tool";

/** Módulo com todas as tools read-only. */
export class BuiltinToolsModule implements ToolModule {
	register(registry: ToolRegistryLike): void {
		registry.registerTool(new PrContextTool());
		registry.registerTool(new ListFilesTool());
		registry.registerTool(new FileOutlineTool());
		registry.registerTool(new ReadFileRangeTool());
		registry.registerTool(new SearchCodeTool());
		registry.registerTool(new FindSymbolTool());
		registry.registerTool(new FindReferencesTool());
		registry.registerTool(new SymbolContextTool());
		registry.registerTool(new ChangedSymbolsTool());
		registry.registerTool(new ImpactTool());
		registry.registerTool(new ImportsExportsTool());
		registry.registerTool(new RuleSignalsTool());
		registry.registerTool(new TestsForSymbolTool());
		registry.registerTool(new DocContextTool());
	}
}

export {
	ChangedSymbolsTool,
	DocContextTool,
	FileOutlineTool,
	FindReferencesTool,
	FindSymbolTool,
	ImpactTool,
	ImportsExportsTool,
	ListFilesTool,
	PrContextTool,
	ReadFileRangeTool,
	RuleSignalsTool,
	SearchCodeTool,
	SymbolContextTool,
	TestsForSymbolTool,
};
