import { describe, expect, test } from "bun:test";
import {
	buildAnchor,
	fingerprintOf,
	locateAnchor,
	normalizeLine,
	reanchor,
} from "../core/finding-anchor";

const DUPLICATED = [
	"function a() {",
	'\tconsole.log("x");',
	"}",
	"function b() {",
	'\tconsole.log("x");',
	"}",
].join("\n");

// Após um "auto-fix" que remove o PRIMEIRO console.log.
const AFTER_FIX = [
	"function a() {",
	"}",
	"function b() {",
	'\tconsole.log("x");',
	"}",
].join("\n");

describe("finding-anchor", () => {
	test("normalizeLine colapsa espaços e apara as pontas", () => {
		expect(normalizeLine('  \t console.log( "x" );  ')).toBe('console.log( "x" );');
		expect(normalizeLine("   ")).toBe("");
	});

	test("buildAnchor usa a linha quando válida", () => {
		const anchor = buildAnchor(DUPLICATED, 2);
		expect(anchor).not.toBeNull();
		expect(anchor?.snippet).toBe('console.log("x");');
		expect(anchor?.contextBefore).toBe("function a() {");
		expect(anchor?.contextAfter).toBe("}");
		expect(anchor?.line).toBe(2);
	});

	test("buildAnchor cai na evidence quando a linha é inválida", () => {
		const anchor = buildAnchor(DUPLICATED, 999, 'console.log("x");');
		expect(anchor?.line).toBe(2);
	});

	test("buildAnchor devolve null sem linha válida nem evidence localizável", () => {
		expect(buildAnchor(DUPLICATED, 999, "inexistente")).toBeNull();
	});

	test("locateAnchor encontra a linha e conta as ocorrências", () => {
		const anchor = buildAnchor(DUPLICATED, 2);
		const located = locateAnchor(DUPLICATED, anchor);
		expect(located.line).toBe(2);
		expect(located.occurrences).toBe(1);
	});

	test("fingerprint é estável e distingue contexto", () => {
		const a1 = buildAnchor(DUPLICATED, 2);
		const a2 = buildAnchor(DUPLICATED, 5);

		// Mesmo arquivo + regra + âncora → mesmo fingerprint.
		expect(fingerprintOf("f.ts", "rule", a1)).toBe(
			fingerprintOf("f.ts", "rule", buildAnchor(DUPLICATED, 2)),
		);
		// Snippet idêntico mas contexto diferente → fingerprints diferentes.
		expect(fingerprintOf("f.ts", "rule", a1)).not.toBe(
			fingerprintOf("f.ts", "rule", a2),
		);
		// Regra diferente muda o fingerprint.
		expect(fingerprintOf("f.ts", "outra", a1)).not.toBe(
			fingerprintOf("f.ts", "rule", a1),
		);
	});

	test("fingerprint sem âncora usa o fallback", () => {
		expect(fingerprintOf("f.ts", "rule", null, "mensagem")).toBe(
			fingerprintOf("f.ts", "rule", null, "mensagem"),
		);
		expect(fingerprintOf("f.ts", "rule", null, "a")).not.toBe(
			fingerprintOf("f.ts", "rule", null, "b"),
		);
	});

	test("reanchor: ok, moved e stale", () => {
		const anchor = buildAnchor(DUPLICATED, 5);
		expect(reanchor(DUPLICATED, anchor, 5).status).toBe("ok");

		const moved = reanchor(AFTER_FIX, anchor, 5);
		expect(moved.status).toBe("moved");
		expect(moved.line).toBe(4);

		const removed = buildAnchor(DUPLICATED, 2);
		expect(reanchor(AFTER_FIX, removed, 2).status).toBe("stale");
	});

	test("duas ocorrências iguais não se perdem quando o fix remove a primeira", () => {
		const first = buildAnchor(DUPLICATED, 2);
		const second = buildAnchor(DUPLICATED, 5);

		// A âncora removida vira stale; a sobrevivente apenas desloca de linha.
		expect(reanchor(AFTER_FIX, first, 2).status).toBe("stale");
		const survivor = reanchor(AFTER_FIX, second, 5);
		expect(survivor.status).toBe("moved");
		expect(survivor.line).toBe(4);
	});

	test("ocorrências byte-idênticas compartilham o fingerprint (grupo)", () => {
		// Mesmo snippet E mesmo contexto (sem vizinhos) → mesmo fingerprint.
		const content = "x\ny\nx\ny";
		const a1 = buildAnchor(content, 1);
		const a2 = buildAnchor(content, 3);
		// contextBefore ausente em ambos (linha 1 vs 3 tem 'y' antes → difere), então
		// forçamos âncoras sem contexto para simular colisão real.
		const bare = a1 && { ...a1, contextBefore: undefined, contextAfter: undefined };
		const bare2 = a2 && { ...a2, contextBefore: undefined, contextAfter: undefined };
		expect(fingerprintOf("f.ts", "r", bare)).toBe(fingerprintOf("f.ts", "r", bare2));
	});
});
