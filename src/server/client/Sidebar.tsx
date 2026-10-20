/**
 * Sidebar do servidor: rail vertical de seções (padrão VS Code) + painel
 * expansível. A navegação vem do registry `sidebar-sections.tsx`; a rail fica
 * sempre visível, inclusive com o painel recolhido.
 *
 * Largura, colapso e seção ativa são preferências locais (`sidebar-prefs.ts`).
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ChevronRight } from "./icons";
import {
	getSidebarSection,
	resolveSidebarSectionId,
	SIDEBAR_SECTIONS,
	type SidebarSectionContext,
} from "./sidebar-sections";
import {
	clampSidebarWidth,
	readSidebarPrefs,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	saveSidebarPrefs,
} from "./utils/sidebar-prefs";
import type { RunSummary } from "./utils/types";

/** Passo do redimensionamento por teclado (Shift amplia). */
const KEYBOARD_STEP = 16;

export function Sidebar({
	runs,
	slug,
	onSelect,
	onRefreshRuns,
}: {
	runs: RunSummary[];
	slug: string | null;
	onSelect: (slug: string) => void;
	onRefreshRuns: () => void;
}) {
	const [width, setWidth] = useState(() => clampSidebarWidth(readSidebarPrefs().width));
	const [collapsed, setCollapsed] = useState(() => readSidebarPrefs().collapsed);
	const [active, setActive] = useState(() =>
		resolveSidebarSectionId(readSidebarPrefs().section),
	);
	const drag = useRef<{
		startX: number;
		startWidth: number;
		pointerId: number;
	} | null>(null);

	// Persistência com debounce: arrastar o divisor não escreve a cada pixel.
	useEffect(() => {
		const id = setTimeout(
			() => saveSidebarPrefs({ width, collapsed, section: active }),
			180,
		);
		return () => clearTimeout(id);
	}, [width, collapsed, active]);

	const selectSection = useCallback((id: string) => {
		setActive(id);
		setCollapsed(false);
	}, []);

	const startResize = useCallback(
		(event: PointerEvent) => {
			if (collapsed || event.button !== 0) return;
			event.preventDefault();
			const target = event.currentTarget as HTMLElement;
			target.setPointerCapture?.(event.pointerId);
			drag.current = {
				startX: event.clientX,
				startWidth: width,
				pointerId: event.pointerId,
			};
			document.body.classList.add("resizing-sidebar");
		},
		[collapsed, width],
	);

	const moveResize = useCallback((event: PointerEvent) => {
		const state = drag.current;
		if (!state || event.pointerId !== state.pointerId) return;
		setWidth(clampSidebarWidth(state.startWidth + event.clientX - state.startX));
	}, []);

	const endResize = useCallback((event: PointerEvent) => {
		if (!drag.current) return;
		drag.current = null;
		(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
		document.body.classList.remove("resizing-sidebar");
	}, []);

	const resizeByKeyboard = useCallback(
		(event: KeyboardEvent) => {
			const step = event.shiftKey ? KEYBOARD_STEP * 2 : KEYBOARD_STEP;
			let next: number | null = null;
			if (event.key === "ArrowLeft") next = width - step;
			if (event.key === "ArrowRight") next = width + step;
			if (event.key === "Home") next = SIDEBAR_MIN_WIDTH;
			if (event.key === "End") next = SIDEBAR_MAX_WIDTH;
			if (next === null) return;
			event.preventDefault();
			setWidth(clampSidebarWidth(next));
		},
		[width],
	);

	const section = getSidebarSection(active);
	const context: SidebarSectionContext = {
		runs,
		slug,
		onSelect,
		onRefreshRuns,
		active: false,
	};

	return (
		<aside
			class={`sidebar${collapsed ? " collapsed" : ""}`}
			style={`--side-width:${width}px`}
		>
			<nav class="side-rail" aria-label="Seções do Houndsman">
				{SIDEBAR_SECTIONS.map((item) => {
					const SectionIcon = item.icon;
					const count = item.badge?.(context);
					const isActive = item.id === active;
					return (
						<button
							key={item.id}
							type="button"
							class={`rail-btn${isActive ? " active" : ""}`}
							title={item.label}
							aria-label={item.label}
							aria-current={isActive ? "page" : undefined}
							aria-controls={`side-section-${item.id}`}
							onClick={() => selectSection(item.id)}
						>
							<SectionIcon size={20} />
							{typeof count === "number" && count > 0 && (
								<span class="rail-badge">
									{count > 99 ? "99+" : count}
								</span>
							)}
						</button>
					);
				})}
				<span class="rail-spacer" />
				<button
					type="button"
					class="rail-btn rail-toggle"
					title={collapsed ? "Expandir painel" : "Recolher painel"}
					aria-label={collapsed ? "Expandir painel" : "Recolher painel"}
					aria-expanded={!collapsed}
					onClick={() => setCollapsed((current) => !current)}
				>
					<ChevronRight size={18} class={collapsed ? undefined : "icon flip"} />
				</button>
			</nav>

			<div class="side-panel">
				<header class="side-head">
					<div class="brand">
						<img class="logo" src="/assets/logo.png" alt="" />
						<div>
							<h1>Houndsman</h1>
							<p class="sub">Revisões e triagem</p>
						</div>
					</div>
					<div class="side-title">
						<h2>{section.title}</h2>
						{section.hint && <p class="side-hint">{section.hint}</p>}
					</div>
				</header>

				<div class="side-body">
					{SIDEBAR_SECTIONS.map((item) => (
						<section
							key={item.id}
							id={`side-section-${item.id}`}
							class="side-section"
							hidden={item.id !== active}
						>
							<item.Content {...context} active={item.id === active} />
						</section>
					))}
				</div>
			</div>

			{!collapsed && (
				// biome-ignore lint/a11y/useSemanticElements: divisor arrastável, não conteúdo.
				<div
					class="side-resizer"
					role="separator"
					aria-orientation="vertical"
					aria-label="Redimensionar painel lateral"
					aria-valuemin={SIDEBAR_MIN_WIDTH}
					aria-valuemax={SIDEBAR_MAX_WIDTH}
					aria-valuenow={width}
					tabIndex={0}
					onPointerDown={startResize}
					onPointerMove={moveResize}
					onPointerUp={endResize}
					onPointerCancel={endResize}
					onKeyDown={resizeByKeyboard}
				/>
			)}
		</aside>
	);
}
