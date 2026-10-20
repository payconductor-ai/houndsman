/**
 * Preferências locais da sidebar (largura do painel, colapso e seção ativa).
 *
 * Persistidas em `localStorage` e lidas de forma falha-aberta: storage
 * indisponível ou JSON inválido caem nos defaults, sem quebrar a UI.
 */

export const SIDEBAR_MIN_WIDTH = 320;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 360;

/** Chave única — o valor é um JSON com `width`, `collapsed` e `section`. */
export const SIDEBAR_STORAGE_KEY = "houndsman.sidebar";

export type SidebarPrefs = {
	width: number;
	collapsed: boolean;
	section: string | null;
};

/** Preferências usadas quando não há nada salvo. */
export function defaultSidebarPrefs(): SidebarPrefs {
	return {
		width: SIDEBAR_DEFAULT_WIDTH,
		collapsed: false,
		section: null,
	};
}

/** Mantém a largura dentro de limites seguros (NaN/infinito viram o default). */
export function clampSidebarWidth(value: number): number {
	if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
	return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

/** Lê as preferências salvas; qualquer falha retorna os defaults. */
export function readSidebarPrefs(): SidebarPrefs {
	const fallback = defaultSidebarPrefs();
	try {
		if (typeof localStorage === "undefined") return fallback;
		const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
		if (!raw) return fallback;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return fallback;
		const value = parsed as Record<string, unknown>;
		return {
			width: clampSidebarWidth(Number(value.width)),
			collapsed: value.collapsed === true,
			section: typeof value.section === "string" ? value.section : null,
		};
	} catch {
		return fallback;
	}
}

/** Grava as preferências; falhas (modo privado, cota) são ignoradas. */
export function saveSidebarPrefs(prefs: SidebarPrefs): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// fail-open: preferências são cosméticas.
	}
}
