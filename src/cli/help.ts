/** Texto de ajuda do CLI (mantido fora do bootstrap para reduzir acoplamento). */
export const HELP = `Uso: houndsman [comando] [flags]

Comandos:
  (nenhum)            Prepara a revisão (classification + briefs + manifesto)
  --finalize          Consolida os findings e grava o resumo final
  context             Coleta o contexto da PR via gh (Passo 0; --pr/--worktree)
  compare [a] [b]     Compara duas runs (A/B) por slug ou --branch/--a/--b
  findings <sub>      Triagem/correção dos findings (list · show · set · done · reset · sync · summary · batch · verify · submit · path)
  hunt [flags]        Harness local (maki): prepare → watchdogs via maki → finalize
                      (a skill /houndsman hunt continua existindo p/ agentes externos)
  hunt install        Baixa o maki fixado para <HOUNDSMAN_HOME>/tools/maki
  hunt doctor         Diagnóstico do harness local (opcional, não falha sem maki)
  hunt uninstall      Remove o binário gerenciado
  status [ping]       Mostra o status da run (ping renova o heartbeat da execução)
  worktree <ação>     Lista/cria/remove worktrees de revisão (list · add · remove · prune · path)
  server              Sobe a UI local de triagem (--port, --host, --open, --editor)
  setup               Cria a configuração inicial do projeto (config + skills)
  update              Sincroniza os arquivos auto-gerados (.houndsman/core)
  doctor              Valida a configuração, o ambiente e a credencial Jev
  test                Roda a suíte de testes da lib
  watchdog <id>       Contexto de um watchdog (--rules, --json)

Flags:
  --config <path>     Caminho do houndsman.config.* (default: detecta no cwd)
  --base <branch>     Base do diff (default: main)
  --head <ref>        Head do diff (default: HEAD)
  --branch <nome>     Branch alvo (default: detecta do git)
  --variant <label>   Rótulo da variante A/B (runs separadas para a mesma branch)
  --pr <n>            Revisa a PR em um worktree dedicado (cria/reusa automaticamente)
  --worktree <path>   Revisa em um worktree já existente
  --clean             Descarta findings brutos do staging anterior
  --full              Força review completo (ignora o modo incremental)
  --no-jev            Desativa a pré-análise Jev
  --no-ast            Desativa a análise estrutural (tree-sitter)
  --no-ai             Desativa as features de IA do fluxo normal
  --fail-on-blocking  Exit 1 se houver bloqueantes (com --finalize)

Flags de hunt (harness local):
  --allow-partial     Finaliza mesmo se algum watchdog maki falhar
  --no-context        Não coleta o contexto da PR via gh
  --hunt-model <m>    Modelo do maki (provider/model-id)
  --hunt-concurrency  Processos maki simultâneos
  --hunt-timeout      Timeout por watchdog (ms)
  --no-retry          Não repete saída inválida

Flags de findings:
  --decision <d>      pending | execute | ignore
  --exec <e>          pending | in_progress | done | stale
  --comment <text>    Comentário/instrução adicional
  --watchdog <id>     Filtra por watchdog (list)
  --severity <s>      Filtra por severidade (list, batch)
  --file <text>       Filtra por trecho do caminho (list)
  --all               Inclui findings ausentes do último relatório
  --json              Saída JSON
  --limit <n>         Limita o nº de itens (list)
  --group <key>       Grupo alvo no batch (default: o primeiro)
  --offset <n>        Paginação dentro do grupo (batch)
  --include-done      Inclui já concluídos no batch
  --apply             (verify) Marca os resolvidos como done
  --fail-on-persisting (verify) Exit 1 se algum blocking persistir
  --include-sent      (submit) Reenvia findings já enviados à PR
  --dry-run           (submit) Só a prévia do envio, sem postar
  --no-ping           (doctor) Pula a validação de rede das credenciais

Worktrees:
  houndsman worktree list
  houndsman worktree add --pr 123
  houndsman worktree remove <branch> [--force]
  Os worktrees ficam em <repo>/.houndsman/worktrees/<repo>/<branch> (detached).
  Use worktrees.location: "home" na config para voltar ao HOUNDSMAN_HOME.

Persistência:
  Runs, findings e artefatos ficam no storage global (SQLite em
  <HOUNDSMAN_HOME>/houndsman.db). Use storage.provider: "file" na config para
  voltar ao backend de arquivos. Nada é gravado em .houndsman/.runs.

Ambiente (o Bun carrega .env automaticamente):
  HOUNDSMAN_TYPE_SAFE_API_KEY   Pré-análise Jev (opcional)
  HOUNDSMAN_DEEP_SEEK_API_KEY   IA (provider deepseek, opcional; reusada pelo hunt)
  HOUNDSMAN_OPENAI_API_KEY     IA (provider openai, opcional)
  HOUNDSMAN_ANTHROPIC_API_KEY  IA (provider anthropic, opcional)
  HOUNDSMAN_MAKI_PATH          Binário do maki (harness local \`hunt\`)
  HOUNDSMAN_MAKI_VERSION       Versão do maki a instalar (default: fixada no pacote)`;
