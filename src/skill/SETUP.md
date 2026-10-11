# Setup — usar o houndsman no seu projeto

O **houndsman** é um CLI instalado **globalmente**. A camada de configuração que ele gera
no seu projeto é **autocontida** — não exige nenhuma dependência local do pacote.

## Pré-requisitos

- **Bun** — o CLI e o motor usam a runtime Bun (execução de TS, `Bun.spawnSync`).
- **git** — o diff usa `git diff <base>...<head> --name-status`.
- Opcional: **`gh`** (contexto da PR) e **`TYPESAFE_API_KEY`** (pré-análise Jev). Ambos são
  **falha-aberto** — sem eles o pipeline segue normalmente.

## Instalação (global)

```bash
bun add -g houndsman
```

O comando `houndsman` fica disponível em qualquer diretório.

## Configuração

Na raiz do seu projeto:

```bash
bun run houndsman setup
```

Isso cria:

| Caminho | O que é |
|---|---|
| `houndsman.config.ts` | Configuração — um objeto de dados (sem imports do pacote) |
| `.houndsman/types.ts` | Snapshot dos tipos + helpers locais (tipagem sem install) |
| `.houndsman/reviewers/example.ts` + `index.ts` | Comece com **1 revisor de exemplo** |
| `.houndsman/exclusions.ts` | Arquivos que nunca entram na revisão |
| `.houndsman/doc-mappings.ts` | path → documentação de contexto |
| `.houndsman/skill/*.md` | Cópia local da documentação do skill |
| `.houndsman/.gitignore` | Ignora `.runs/` (artefatos de revisão) |
| `.agents/skills/houndsman/SKILL.md` etc. | Ponteiros de skill dos harnesses |

Além disso, adiciona o script `"houndsman": "houndsman"` ao `package.json` — assim
`bun run houndsman [...]` funciona na raiz do projeto. Os artefatos ficam em
`.houndsman/.runs/<branch-slug>/` (ignorados pelo `.gitignore` interno).

Flags: `--name <projeto>` · `--harness agents,claude|both|none` · `--force` (sobrescreve).
É **idempotente** — arquivos existentes são mantidos (use `--force` para recriar).

> `.houndsman/types.ts` é um **snapshot gerado** do contrato público. Se a lib evoluir e você
> quiser os tipos atualizados, rode `bun run houndsman setup --force`.

## Verificar

```bash
bun run houndsman doctor         # valida config + ambiente (git/gh/Jev)
bun run houndsman test           # suíte da lib (project-agnóstica)
bun run houndsman --base main    # prepara briefs do diff atual
```

## Contrato do motor (`ReviewConfig`)

Definido em `src/core/config.ts` (pacote) e espelhado em `.houndsman/types.ts` (gerado):

| Campo | Descrição |
|---|---|
| `projectName` | Nome legível (prompts/docs). |
| `artifactDir` | Onde gravar os artefatos (default `.houndsman/.runs`). |
| `outputFormatPath` | Caminho do schema de output citado nos briefs. **Opcional** — default é o asset do pacote. |
| `reviewers` | Definições dos revisores (incluem `classify`); os **ids são derivados** das chaves. |
| `exclusions` | Arquivos que nunca entram na revisão. |
| `docMappings` | Path → documentação de contexto. |
| `alwaysIncludeDocs` | Docs sempre presentes nos briefs (default `["AGENTS.md"]`). |

> O motor **não contém** ids, paths ou regras do projeto — tudo chega por `ReviewConfig`,
> carregado em runtime a partir de `houndsman.config.ts` (ou `--config <path>`).

## Estrutura do pacote (motor)

```
houndsman/
├── package.json
└── src/
    ├── index.ts              # API pública (defineReviewer, defineReviewConfig, tipos)
    ├── cli/index.ts          # CLI único — bin `houndsman`
    ├── core/                 # bibliotecas genéricas (config, orchestrator, brief, jev/, …)
    ├── skill/*.md            # assets markdown (embarcados no pacote)
    └── tests/                # suíte da lib (project-agnóstica, "project fake")
```

## Desenvolvimento da lib

- Scripts: `bun run test`, `bun run typecheck`, `bun run ci`.
- O motor é 100% agnóstico ao consumidor: nenhuma regra, path ou nome de projeto vive aqui.
