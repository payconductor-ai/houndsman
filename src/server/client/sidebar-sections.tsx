/**
 * Registry das seções da sidebar — fonte única da navegação.
 *
 * Adicionar uma seção é incluir um item em `SIDEBAR_SECTIONS`: a rail e o
 * painel passam a renderizá-la sem condicionais em `Sidebar.tsx`. O `Content`
 * fica montado mesmo fora de foco, então deve buscar dados apenas quando
 * `active` for `true` (preserva estado ao alternar, sem refetch).
 */

import type { ComponentType } from "preact";
import { GitPullRequest, type IconProps, ListIcon } from "./icons";
import { PrsSection } from "./PrsSection";
import { RunsSection } from "./RunsSection";
import type { RunSummary } from "./utils/types";

/** Estado e ações compartilhados por todas as seções da sidebar. */
export type SidebarSectionContext = {
	runs: RunSummary[];
	slug: string | null;
	onSelect: (slug: string) => void;
	onRefreshRuns: () => void;
	/** Seção visível no momento — use para adiar fetch e polling. */
	active: boolean;
};

export type SidebarSection = {
	id: string;
	/** Nome curto da tooltip da rail. */
	label: string;
	/** Título exibido no topo do painel. */
	title: string;
	/** Linha de apoio abaixo do título (contexto da seção). */
	hint?: string;
	icon: ComponentType<IconProps>;
	/** Contador opcional da rail (ex.: quantidade de execuções). */
	badge?: (ctx: SidebarSectionContext) => number | null;
	Content: ComponentType<SidebarSectionContext>;
};

export const SIDEBAR_SECTIONS: SidebarSection[] = [
	{
		id: "runs",
		label: "Execuções",
		title: "Execuções",
		hint: "Revisões executadas pelo Houndsman",
		icon: ListIcon,
		badge: ({ runs }) => (runs.length > 0 ? runs.length : null),
		Content: RunsSection,
	},
	{
		id: "prs",
		label: "PRs",
		title: "PRs",
		hint: "Pull requests abertas no repositório",
		icon: GitPullRequest,
		Content: PrsSection,
	},
];

/** Seção inicial quando não há preferência salva (ou ela é inválida). */
export const DEFAULT_SIDEBAR_SECTION = SIDEBAR_SECTIONS[0].id;

/** Resolve um id de seção salvo, caindo no default quando desconhecido. */
export function resolveSidebarSectionId(id: string | null | undefined): string {
	return id && SIDEBAR_SECTIONS.some((section) => section.id === id)
		? id
		: DEFAULT_SIDEBAR_SECTION;
}

/** Definição da seção (o id é sempre resolvido antes, via registry). */
export function getSidebarSection(id: string): SidebarSection {
	return SIDEBAR_SECTIONS.find((section) => section.id === id) ?? SIDEBAR_SECTIONS[0];
}
