/**
 * Ícones SVG inline (traço = `currentColor`) — sem dependência e sem requisição
 * externa; o cliente é servido localmente a partir de um bundle em memória.
 */

import type { ComponentChildren } from "preact";

export type IconProps = { size?: number; class?: string };

function Svg({
	size = 16,
	class: cls,
	children,
}: IconProps & { children: ComponentChildren }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			class={cls}
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export const ChevronRight = (p: IconProps) => (
	<Svg {...p}>
		<path d="m9 18 6-6-6-6" />
	</Svg>
);

export const CodeIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="m16 18 6-6-6-6" />
		<path d="m8 6-6 6 6 6" />
	</Svg>
);

export const ExternalLink = (p: IconProps) => (
	<Svg {...p}>
		<path d="M15 3h6v6" />
		<path d="M10 14 21 3" />
		<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
	</Svg>
);

export const Sparkles = (p: IconProps) => (
	<Svg {...p}>
		<path d="M11 3.5l1.7 4.3 4.3 1.7-4.3 1.7L11 15.5 9.3 11.2 5 9.5l4.3-1.7z" />
		<path d="M18.5 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
	</Svg>
);

export const Refresh = (p: IconProps) => (
	<Svg {...p}>
		<path d="M3.2 12a8.8 8.8 0 0 1 15-6.2L21 8" />
		<path d="M21 3.5V8h-4.5" />
		<path d="M20.8 12a8.8 8.8 0 0 1-15 6.2L3 16" />
		<path d="M3 20.5V16h4.5" />
	</Svg>
);

export const Clock = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7.5V12l3 1.8" />
	</Svg>
);

export const Check = (p: IconProps) => (
	<Svg {...p}>
		<path d="m20 6.5-11 11-5-5" />
	</Svg>
);

/** Arco (não círculo fechado) — usado com `animation: spin` no fundo. */
export const Spinner = (p: IconProps) => (
	<Svg {...p}>
		<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
	</Svg>
);

export const Search = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="11" cy="11" r="7" />
		<path d="m20 20-3.6-3.6" />
	</Svg>
);

export const BranchIcon = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="6" cy="5" r="2.4" />
		<circle cx="6" cy="19" r="2.4" />
		<circle cx="18" cy="8" r="2.4" />
		<path d="M6 7.4v9.2" />
		<path d="M18 10.4c0 3.8-4 3.4-6.5 5.4" />
	</Svg>
);

export const Alert = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7.5V13" />
		<path d="M12 16.5h.01" />
	</Svg>
);

export const ListIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M9 6h12M9 12h12M9 18h12" />
		<path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
	</Svg>
);

export const Layers = (p: IconProps) => (
	<Svg {...p}>
		<path d="m12 3 9 5-9 5-9-5z" />
		<path d="m3 13 9 5 9-5" />
	</Svg>
);

/** Olho — "quem auditou o trecho" (watchdogs envolvidos). */
export const Watch = (p: IconProps) => (
	<Svg {...p}>
		<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" />
		<circle cx="12" cy="12" r="2.6" />
	</Svg>
);
