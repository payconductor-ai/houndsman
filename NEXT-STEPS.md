# NEXT-STEPS — publicar e operar o `houndsman`

> Checklist de handoff. Copie estes arquivos para o repositório novo do `houndsman`
> (a pasta `packages/houndsman/` já foi movida para lá). Depois deste setup inicial, você
> pode apagar este arquivo (as partes duráveis estão no `AGENTS.md` e nos workflows).

O pacote é autocontido: `package.json`, `biome.json`, `.gitignore`, `LICENSE`, `tsconfig.json`,
`src/`, `README.md`. Nada referencia a Pay.Conductor.

---

## O que copiar para onde

| Arquivo (nesta pasta) | Destino no repo `houndsman` |
| --- | --- |
| `AGENTS.md` | `AGENTS.md` (raiz) |
| `.github/workflows/ci.yml` | `.github/workflows/ci.yml` |
| `.github/workflows/release.yml` | `.github/workflows/release.yml` |
| `NEXT-STEPS.md` | (temporário — apague depois do setup) |

---

## 1. Primeiro commit no repo novo

```bash
cd <caminho-do-repo-houndsman>
bun install
bun run ci      # biome ci . && tsc -b
bun run test    # 58 testes
git init -b main          # se ainda não for um repo
git add -A
git commit -m "feat: initial houndsman release"
```

## 2. Repositório público no GitHub

Com `gh`:

```bash
gh repo create <sua-org>/houndsman --public --source=. --remote=origin --push
```

Ou manualmente: crie o repo vazio na UI e então

```bash
git remote add origin git@github.com:<sua-org>/houndsman.git
git push -u origin main
```

Depois, adicione o campo ao `package.json` (habilita `--provenance`):

```jsonc
"repository": "github:<sua-org>/houndsman",
```

## 3. Publicar no npm (primeira vez)

O nome **`houndsman` está livre** no npm (verificado). Sem escopo, `access: public` já está no
`publishConfig`.

```bash
npm login                 # primeira vez (ou: bunx npm login)
npm publish --dry-run     # confere o tarball (src/, README.md, LICENSE)
npm publish --access public
# alternativamente: bun publish
```

Testar a instalação global:

```bash
bun add -g houndsman
houndsman --help
houndsman doctor   # (dentro de um projeto já configurado)
```

## 4. Automatizar o release

1. Crie um token **Automation** no npm → salve como secret **`NPM_TOKEN`** no repositório
   (Settings → Secrets and variables → Actions).
2. Copie os workflows (já prontos nesta pasta):
   - `.github/workflows/ci.yml` — valida PRs.
   - `.github/workflows/release.yml` — publica no push para a branch **`stable`**.

Modelo de branches sugerido: `main` (desenvolvimento) → PR → **`stable`** (release).
Para publicar direto da `main`, troque `branches: [stable]` por `branches: [main]` no
`release.yml`.

> `--provenance` exige repositório público + `permissions: id-token: write` (já configurado).
> Se o seu runner não suportar, remova a flag.

### Opcional — versionamento com Changesets

Para PRs declararem o bump semântico:

```bash
bun add -d @changesets/cli
bunx changeset init
```

Cada PR roda `bunx changeset` e o merge na `stable` publica a versão consolidada. Substitua o
passo `npm publish` do `release.yml` por `changesets/action` (que abre o "Version Packages PR"
e publica no merge dele).

## 5. Instalar direto do git (alternativa ao npm)

Funciona, sem publicar:

```bash
bun add -g github:<sua-org>/houndsman
# ou, sem instalar:
bunx github:<sua-org>/houndsman --help
```

Limitações: fica pinado ao commit (sem `latest`/semver) e atualizar exige reinstalar. Use git
para canários/pré-release; npm para releases estáveis.

## 6. Configurar um projeto consumidor

```bash
cd meu-projeto
houndsman setup              # 1ª vez: bin global (o script no package.json ainda não existe)
bun run houndsman doctor     # daqui pra frente o `setup` já injetou "houndsman": "houndsman"
bun run houndsman --base main
```

O `setup` cria:

| Caminho | O que é |
| --- | --- |
| `houndsman.config.ts` | Configuração (objeto de dados) |
| `.houndsman/types.ts` | Snapshot dos tipos + helpers (tipagem sem install) |
| `.houndsman/reviewers/*.ts` | Revisores (comece com 1 de exemplo) |
| `.houndsman/exclusions.ts` / `doc-mappings.ts` | Filtros e docs de contexto |
| `.houndsman/skill/*.md` | Documentação do skill (cópia local) |
| `.{agents,claude}/skills/houndsman/**` | Ponteiros de skill |
| `package.json` | script `"houndsman": "houndsman"` |
| `.gitignore` | entrada `.houndsman/runs/` (artefatos) |

Flags: `--name "<Projeto>"` · `--harness agents,claude|both|none` · `--force`.

### Consumir o repo local antes de publicar (`bun link`)

Enquanto o pacote não está no npm, aponte o consumidor para o clone local:

```bash
cd <path-do-repo-houndsman>
bun link                     # registra o pacote globalmente

cd <path-do-pay.conductor>
bun link houndsman           # cria node_modules/houndsman + .bin/houndsman
bun run houndsman doctor
```

> Se você mover/remover o repo depois, o link fica órfão e `bun run houndsman` falha com
> "Module not found". Limpe com:
> ```bash
> cmd /c rmdir "node_modules\houndsman"   # Windows (junction)
> bun install
> ```
> Alternativa sem link: rodar direto do outro repo —
> `bun run ../houndsman/src/cli/index.ts doctor`.

---

## 7. Manutenção do consumidor

**Atualizar só os tipos** (quando a lib evoluir) — sem tocar nas suas regras:

```bash
rm .houndsman/types.ts
bun run houndsman setup      # idempotente: regenera apenas o que falta
```

> Não use `--force` num projeto já configurado: ele reescreveria `houndsman.config.ts` e
> `.houndsman/reviewers/`.

**Artefatos** ficam em `.houndsman/runs/<branch>/` (gitignored): `classification.json`,
`candidates.json`, `briefs/`, `findings/`, `manifest.json`, `review.md`.

## 8. Depois da extração (lado Pay.Conductor)

- A pasta `packages/` ficou vazia — pode ser removida.
- `workspaces` no `package.json` ainda lista `"packages/*"` — remova essa linha.
- Os scripts raiz (`"houndsman": "houndsman"`, `houndsman:*`) passam a resolver o **bin global**:
  instale com `bun add -g houndsman` (ou use `bunx houndsman`) na máquina de quem revisa.
- A camada de projeto (`houndsman.config.ts` + `.houndsman/`) permanece no repositório.

## 9. Checklist final

- [ ] `bun run ci` e `bun run test` passando no repo novo.
- [ ] Repo público criado + `repository` no `package.json`.
- [ ] Secret `NPM_TOKEN` configurado.
- [ ] `npm publish --dry-run` lista apenas `src/`, `README.md`, `LICENSE`.
- [ ] `bun add -g houndsman` + `houndsman --help` funcionando.
- [ ] No Pay.Conductor: `bun link houndsman` (dev) ou install global; nenhum link órfão.
- [ ] Workflows `ci.yml` e `release.yml` copiados para `.github/workflows/`.
- [ ] `packages/*` removido do `workspaces` do Pay.Conductor.
