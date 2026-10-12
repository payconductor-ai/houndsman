# Houndsman

Orquestrador de revisão de Pull Requests. Classifica o diff, despacha revisores
especializados por domínio (um subagente por revisor) e consolida os achados em um
relatório único.

> Review de PR no piloto automático: alguém aprova no "LGTM" sem ler, um `catch {}` engole
> o erro e ninguém nota. Sexta às 18h a produção cobra a conta — e aí todo mundo lembra
> daquela linha.

![alt text](assets/houndsman.png)

## Por que "houndsman"?

Um **houndsman** é o treinador de um time de cães de caça: escolhe cada cão pelo faro,
manda o mais adequado para cada terreno e recolhe tudo o que a matilha encontrou.

Esta lib funciona igual — você monta o **seu time de cães de caça**, cada um farejando um
domínio diferente (`api`, `db`, `ui`...) das PRs, e não deixa passar **nada de errado** para
produção. O motor só coordena a caçada; a matilha é problema seu.

- **Motor genérico** — classificação de arquivos, geração de briefs, pré-análise opcional
  (Jev) e consolidação do relatório. Sem regras nem paths de nenhum projeto.
- **Camada de projeto** — revisores, exclusões e mapeamentos de docs vivem no repositório do
  consumidor (`houndsman.config.ts` + `.houndsman/`), carregados em runtime.

## Instalação (global)

```bash
bun add -g houndsman
```

> Requer **Bun** (runtime) e **git**. `gh` e `TYPESAFE_API_KEY` são opcionais (falha-aberto).
>
> A camada que o `setup` gera no seu projeto é **autocontida** — não precisa de install local.

## Uso

```bash
bun run houndsman setup        # cria houndsman.config.ts + .houndsman/ + ponteiros de skill
bun run houndsman doctor       # valida config e ambiente
bun run houndsman --base main  # Passo 1 — prepara briefs
bun run houndsman --finalize   # Passo 3 — gera o relatório
bun run houndsman update       # sincroniza os arquivos auto-gerados (.houndsman/core)
```

### Comandos

| Comando | Função |
|---|---|
| `houndsman` | Passo 1 — preparar (classificação + briefs + manifesto) |
| `houndsman --finalize` | Passo 3 — consolidar findings em `review.md` |
| `houndsman context` | Passo 0 — contexto da PR via `gh` |
| `houndsman setup` | Cria a configuração inicial do projeto |
| `houndsman update` | Sincroniza os arquivos auto-gerados (`.houndsman/core`) |
| `houndsman doctor` | Valida a configuração e o ambiente (anti-drift) |
| `houndsman test` | Suíte de testes da lib (project-agnóstica) |
| `houndsman reviewer <id>` | Contexto de um revisor (`--rules`, `--json`) |

## Configuração (`houndsman.config.ts`)

```ts
import { DOC_MAPPINGS } from "./.houndsman/doc-mappings";
import { EXCLUSION_PATTERNS } from "./.houndsman/exclusions";
import { REVIEWER_DEFINITIONS } from "./.houndsman/reviewers";
import type { ReviewConfig } from "./.houndsman/core/types";

export const reviewConfig = {
	projectName: "Meu Projeto",
	reviewers: REVIEWER_DEFINITIONS,
	exclusions: EXCLUSION_PATTERNS,
	docMappings: DOC_MAPPINGS,
} satisfies ReviewConfig;

export default reviewConfig;
```

> `artifactDir` é **opcional** (default `.houndsman/.runs`); o schema de output é
> derivado da camada (`.houndsman/core/skill/OUTPUT-FORMAT.md`).
>
> A camada separa **auto-gerado** (`.houndsman/core/**`, `.houndsman/.gitignore`,
> ponteiros de skill) do **usuário** (`.houndsman/reviewers/`, `exclusions.ts`,
> `doc-mappings.ts`, `houndsman.config.ts`). O `houndsman update` reescreve só os auto-gerados.

## Documentação

- `src/skill/SETUP.md` — instalação e configuração passo a passo.
- `src/skill/houndsman.md` — orquestração do skill (`/houndsman`).
- `src/skill/houndsman-update.md` — manutenção das regras dos revisores.
