/**
 * Navegação da sidebar: registry de seções e preferências de layout.
 */

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_SIDEBAR_SECTION,
	getSidebarSection,
	resolveSidebarSectionId,
	SIDEBAR_SECTIONS,
	type SidebarSectionContext,
} from "../server/client/sidebar-sections";
import {
	clampSidebarWidth,
	readSidebarPrefs,
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
} from "../server/client/utils/sidebar-prefs";
import type { RunSummary } from "../server/client/utils/types";

function makeRun(slug: string): RunSummary {
	return {
		slug,
		branch: slug,
		summary: {
			total: 0,
			present: 0,
			byDecision: { pending: 0, execute: 0, ignore: 0 },
			byExecState: { pending: 0, in_progress: 0, done: 0, stale: 0 },
			bySeverity: { blocking: 0, attention: 0, suggestion: 0, nit: 0 },
		},
	};
}

function makeContext(runs: RunSummary[]): SidebarSectionContext {
	return {
		runs,
		slug: null,
		onSelect: () => undefined,
		onRefreshRuns: () => undefined,
		active: true,
	};
}

describe("SIDEBAR_SECTIONS", () => {
	test("expõe Execuções e PRs na ordem canônica", () => {
		expect(SIDEBAR_SECTIONS.map((section) => section.id)).toEqual(["runs", "prs"]);
		expect(DEFAULT_SIDEBAR_SECTION).toBe("runs");
	});

	test("cada seção tem identificação e conteúdo", () => {
		const ids = new Set<string>();
		for (const section of SIDEBAR_SECTIONS) {
			expect(section.id).not.toBe("");
			expect(ids.has(section.id)).toBe(false);
			ids.add(section.id);
			expect(section.label.length).toBeGreaterThan(0);
			expect(section.title.length).toBeGreaterThan(0);
			expect(typeof section.icon).toBe("function");
			expect(typeof section.Content).toBe("function");
		}
	});

	test("o badge de Execuções reflete a contagem de runs", () => {
		const runs = SIDEBAR_SECTIONS.find((section) => section.id === "runs");
		expect(runs?.badge?.(makeContext([]))).toBeNull();
		expect(runs?.badge?.(makeContext([makeRun("a"), makeRun("b")]))).toBe(2);
	});

	test("resolve ids salvos e cai no default quando inválidos", () => {
		expect(resolveSidebarSectionId("prs")).toBe("prs");
		expect(resolveSidebarSectionId("desconhecida")).toBe(DEFAULT_SIDEBAR_SECTION);
		expect(resolveSidebarSectionId(null)).toBe(DEFAULT_SIDEBAR_SECTION);
		expect(getSidebarSection("desconhecida").id).toBe(DEFAULT_SIDEBAR_SECTION);
	});
});

describe("preferências da sidebar", () => {
	test("clampa a largura entre mínimo e máximo", () => {
		expect(clampSidebarWidth(200)).toBe(SIDEBAR_MIN_WIDTH);
		expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX_WIDTH);
		expect(clampSidebarWidth(400)).toBe(400);
		expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
	});

	test("lê defaults sem preferências salvas", () => {
		const prefs = readSidebarPrefs();
		expect(prefs.width).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH);
		expect(prefs.width).toBeLessThanOrEqual(SIDEBAR_MAX_WIDTH);
		expect(typeof prefs.collapsed).toBe("boolean");
		if (prefs.section !== null) expect(typeof prefs.section).toBe("string");
	});
});
