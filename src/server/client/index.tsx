/**
 * Entry do cliente (Preact): monta o `<App />` no `#app`.
 *
 * Bundle gerado em memória por `Bun.build` (`client-build.ts`). Os componentes
 * vivem em arquivos irmãos nesta pasta (`App.tsx`, `RunList.tsx`, ...).
 */

import { render } from "preact";
import { App } from "./App";

const root = document.getElementById("app");
if (root) render(<App />, root);
