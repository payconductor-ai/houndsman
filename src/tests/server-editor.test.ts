import { describe, expect, test } from "bun:test";
import {
	editorFileLink,
	jetbrainsFileLink,
	vscodeFileLink,
} from "../server/client/utils/format";
import { detectEditor, resolveEditor } from "../server/editor";

describe("detecção de editor", () => {
	test("VS Code pelo TERM_PROGRAM", () => {
		expect(detectEditor({ TERM_PROGRAM: "vscode" }, "/work/app")).toMatchObject({
			kind: "vscode",
			project: "app",
		});
	});

	test("VS Code pelas variáveis VSCODE_*", () => {
		expect(detectEditor({ VSCODE_PID: "123" }, "/work/app")).toMatchObject({
			kind: "vscode",
			project: "app",
		});
	});

	test("JetBrains pelo terminal e produto do bundle", () => {
		expect(
			detectEditor(
				{
					TERMINAL_EMULATOR: "JetBrains-JediTerm",
					__CFBundleIdentifier: "com.jetbrains.pycharm",
				},
				"/work/app",
			),
		).toEqual({ kind: "jetbrains", project: "app", product: "pycharm" });
	});

	test("JetBrains por *_INITIAL_DIRECTORY", () => {
		expect(
			detectEditor({ WEBSTORM_INITIAL_DIRECTORY: "/work/app" }, "/work/app"),
		).toEqual({ kind: "jetbrains", project: "app", product: "webstorm" });
	});

	test("produto JetBrains ambíguo cai em idea", () => {
		expect(
			detectEditor({ TERMINAL_EMULATOR: "JetBrains-JediTerm" }, "/work/app"),
		).toEqual({ kind: "jetbrains", project: "app", product: "idea" });
	});

	test("sem pistas → none", () => {
		expect(detectEditor({}, "/work/app")).toEqual({
			kind: "none",
			project: "app",
		});
	});

	test("resolveEditor força vscode/jetbrains/none", () => {
		expect(resolveEditor("vscode", {}, "/work/app")).toMatchObject({
			kind: "vscode",
		});
		expect(resolveEditor("jetbrains", {}, "/work/app")).toMatchObject({
			kind: "jetbrains",
			product: "idea",
		});
		expect(
			resolveEditor("none", { TERM_PROGRAM: "vscode" }, "/work/app"),
		).toMatchObject({ kind: "none" });
		expect(resolveEditor("desconhecido", {}, "/work/app")).toMatchObject({
			kind: "none",
		});
	});
});

describe("links de editor", () => {
	test("VS Code normaliza o drive e mantém a linha", () => {
		expect(vscodeFileLink("C:\\repo\\src\\a.ts", 12)).toBe(
			"vscode://file/c:/repo/src/a.ts:12",
		);
	});

	test("JetBrains monta navigate/reference", () => {
		const link = jetbrainsFileLink("C:\\repo\\src\\a.ts", 12, "app", "webstorm");
		expect(link).toContain(
			"jetbrains://webstorm/navigate/reference?project=app&path=",
		);
		expect(link ? decodeURIComponent(link) : "").toContain("C:/repo/src/a.ts:12");
	});

	test("editorFileLink respeita o tipo detectado", () => {
		expect(editorFileLink("/repo/a.ts", 3, { kind: "vscode", project: "app" })).toBe(
			"vscode://file//repo/a.ts:3",
		);
		expect(
			editorFileLink("/repo/a.ts", 3, {
				kind: "jetbrains",
				project: "app",
				product: "goland",
			}),
		).toContain("jetbrains://goland/");
		expect(editorFileLink("/repo/a.ts", 3, { kind: "none" })).toBeNull();
	});
});
