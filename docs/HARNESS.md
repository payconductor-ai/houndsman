# Harness nativo — `houndsman hunt`

> Runtime de agentes do próprio houndsman. Não confundir com `src/skill/`, que é o
> **harness externo** (markdown consumido por Claude Code/agents).

O `hunt` substitui o "despacho de subagentes pelo agente do usuário" por um agente
próprio: ele prepara a revisão, investiga cada watchdog com tools read-only, verifica
as evidências e finaliza com o mesmo `review.md` do fluxo via skill.

```bash
HOUNDSMAN_DEEP_SEEK_API_KEY=... houndsman hunt
houndsman hunt --dry-run            # lista watchdogs/arquivos, sem IA
houndsman hunt --watchdog alpha     # um domínio
houndsman hunt --resume             # preserva findings válidos do staging
houndsman hunt --allow-partial      # falha de um watchdog vira skipped honesto
houndsman hunt --fail-on-blocking   # exit 1 se houver blocking
houndsman hunt --provider deepseek --model <id> --max-calls 30 --concurrency 2
```

## Camadas

```
cli → harness → core
```

- `core/` nunca importa `harness/`.
- `core/ai/` é a camada genérica de modelo/uso/schemas (também usada pelo fluxo normal).
- `harness/` contém tools, investigação, agente e o comando `hunt`.

## Máquina de estados

```
ORIENT → PLAN → INVESTIGATE ⇄ tools → VERIFY → CONCLUDE
```

| Estado | Entrada | Tools permitidas | Saída |
|---|---|---|---|
| ORIENT | watchdog, diff, AST, impacto | contexto, AST, outline, regras | hipóteses |
| PLAN | hipóteses + regras | regras, símbolos, impacto | tarefas priorizadas |
| INVESTIGATE | plano | leitura, busca, símbolos, referências, testes, docs | evidências + drafts |
| VERIFY | drafts + evidências | símbolos/referências/busca | decisões do crítico |
| CONCLUDE | drafts sobreviventes | nenhuma | relatório + cobertura |

Regras:
- `VERIFY` é obrigatório; não existe caminho de INVESTIGATE direto para CONCLUDE.
- Draft sem evidência válida é descartado (`FindingCritic`).
- Toda regra termina em `checked`, `not_applicable` ou `skipped` com motivo.
- Budget de IA/tools esgotado interrompe com `skipped`, nunca inventa achado.

## Catálogo de tools

Todas read-only, com validação Zod, `PathGuard`, cache, budget, limite de resultado e
redaction de segredos.

| Tool | Para quê | Limites |
|---|---|---|
| `pr_context` | contexto resumido da PR | já compactado |
| `list_files` | listar arquivos rastreados | 200 |
| `file_outline` | mapa de símbolos/imports/exports | sem corpo |
| `read_file_range` | ler trecho explícito | 200 linhas / 32 KB |
| `search_code` | localizar padrão (`git grep`) | 50 resultados |
| `find_symbol` | definir símbolo via AST | 20 |
| `find_references` | usos/chamadas | 50 |
| `symbol_context` | definição + corpo curto + referências | ~120 linhas |
| `changed_symbols` | delta AST da revisão | por arquivo |
| `impact` | importadores/exports alterados | top 40 |
| `imports_exports` | imports/exports/decorators | por arquivo |
| `rule_signals` | regra → sinais/checks | determinístico |
| `tests_for_symbol` | testes relacionados | 20 arquivos |
| `doc_context` | trechos de docs mapeados | 2 KB |

Nenhuma tool devolve arquivo inteiro por default. Leia sempre por faixa/símbolo/snippet.

## Como adicionar uma tool

1. Crie uma classe que implemente `AgentTool` em `src/harness/tools/builtin/`.
2. Declare `metadata` (categoria, capabilities, custo, cache, limite) e `inputSchema` Zod.
3. Registre em `builtin/index.ts`.
4. Escreva um contract test.

Não é necessário alterar `ReviewAgent`, `AgentRunner` ou os prompts de estado.

## Investigação

- `RuleAnalyzer`: polaridade, categoria, keywords, sinais (`hints`, backticks,
  identificadores) e checks.
- `InvestigationPlanner`: tarefas priorizadas por severidade + confiança + impacto.
- `AgentState`: tarefas, hipóteses, evidências, cobertura e drafts.
- `EvidenceVerifier`: reancora o snippet no working tree; evidência inválida não sustenta
  finding.
- `FindingCritic`: segunda passada que tenta refutar cada draft (`keep`/`drop`/`downgrade`).

### Lógica e domínio além das regras

O plano de IA do brief trata as regras como **piso**, não teto: ele sugere verificações de
consistência lógica (nome/contrato vs comportamento, fluxos, estados, bordas) e de domínio
(transições, idempotência, timezone, autorização). Essas sugestões aparecem em
`## Plano de revisão (IA)` e são apenas perguntas de verificação.

Para permitir que o agente reporte uma falha de lógica/domínio que não cabe em nenhuma
regra, o watchdog pode declarar `allowEmergentFindings: true`. Os findings usam os prefixos
reservados `Lógica:`/`Domínio:`, exigem evidência e têm severidade máxima `attention`.

### Watchdog `default` (fallback)

O `setup` gera `.houndsman/watchdogs/default.ts` com `fallback: true`: ele só assume
arquivos que nenhum outro watchdog casou, cobrindo padrões gerais, lógica e invariantes de
domínio. `fallback` é uma semântica do core; as regras do `default` continuam na camada do
projeto.

## Artefatos

Além dos artefatos do fluxo normal:

| Artefato | Conteúdo |
|---|---|
| `harness-transcript.json` | estados, tool calls, métricas por tool, truncamentos, uso |
| `ai-usage.json` | chamadas/tokens por feature e total |
| `ai-briefs.json` | planos de revisão sugeridos pela IA (fluxo normal) |

Nenhum artefato contém prompt, resposta crua ou segredo.

## Ambiente

Chaves de integração usam o prefixo `HOUNDSMAN_` (não colidem com envs do projeto):

| Variável | Uso |
|---|---|
| `HOUNDSMAN_DEEP_SEEK_API_KEY` | provider `deepseek` (default) |
| `HOUNDSMAN_OPENAI_API_KEY` | provider `openai` |
| `HOUNDSMAN_ANTHROPIC_API_KEY` | provider `anthropic` |
| `HOUNDSMAN_TYPE_SAFE_API_KEY` | pré-análise Jev |
| `HOUNDSMAN_HOME` | diretório global de dados |

Variáveis nativas do SO/CI (`LOCALAPPDATA`, `XDG_DATA_HOME`, `NO_COLOR`, `TERM`, `CI`)
mantêm o nome global por serem convenções do ambiente.

## Configuração

```ts
ai: {
	provider: "deepseek",
	model: "deepseek-v4.1-flash",
	concurrency: 2,
	maxSteps: 12,
	maxCallsPerReview: 40,
	timeoutMs: 120_000,
	features: {
		context: true,
		brief: true,
		classification: false,
		preAnalysis: false,
		verify: false,
	},
	watchdogs: { alpha: { model: "deepseek-v4.1-flash", maxSteps: 8 } },
},
```

Falhas de IA no fluxo normal são **fail-open**: sem chave, o fluxo determinístico segue
idêntico. O `hunt` é explícito e falha com mensagem clara quando não há IA configurada
(use `--dry-run` para inspecionar sem chamadas).

## Segurança

- Código, docs e diffs são tratados como **dado não confiável** (anti-prompt-injection).
- Tools não executam shell arbitrário, não escrevem arquivos e não acessam a rede.
- `PathGuard` bloqueia `..`, `.git`, `.env*`, binários e arquivos grandes.
- Segredos são redigidos em resultados/logs; nunca aparecem em artefatos/snapshots.
