/** Texto de ajuda do CLI (mantido fora do bootstrap para reduzir acoplamento). */
export const HELP = `Uso: houndsman [comando] [flags]

Comandos:
  (nenhum)            Prepara a revisão (classification + briefs + manifesto)
  --finalize          Consolida os findings em review.md
  context             Coleta o contexto da PR via gh (Passo 0)
  findings <sub>      Triagem/correção dos findings (list · show · set · done · reset · sync · summary · batch · verify · submit · path)
  server              Sobe a UI local de triagem (--port, --host, --open)
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
  --dir <dir>         Diretório dos artefatos
  --clean             Descarta findings anteriores
  --full              Força review completo (ignora o modo incremental)
  --no-jev            Desativa a pré-análise Jev
  --fail-on-blocking  Exit 1 se houver bloqueantes (com --finalize)

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
  --dry-run           (submit) Só a prévia do envio, sem postar`;
