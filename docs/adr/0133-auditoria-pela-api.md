# ADR 0133 — Auditoria pela API: consulta com cursor, exportação em stream e verify

**Status:** Aceito (2026-10-27) · Usa a auditoria do **D122**
([ADR 0122](0122-log-de-auditoria-no-kernel.md)), a API do **D125**
([ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md)) e a auth do **D127**
([ADR 0127](0127-base-da-autenticacao-da-api.md))

## Contexto

O ADR 0122 entregou a auditoria no kernel, com `query` e `verify` só para plugin em `adminPlugins`.
Com a API do core, a consulta deixa de ser aba do dashboard: o dashboard novo (M7-10) e qualquer app
leem a mesma rota. Faltava decidir o formato da exportação, quem pode exportar e verificar, e se a
exportação fica registrada.

Alternativas consideradas:

- **Exportação montada na memória** (ler tudo, responder de uma vez): simples, mas a coleção cresce
  sem teto até a retenção, e um export de meses derruba o processo.
- **NDJSON em vez de array JSON:** mais fácil de ler em stream, mas a issue pede JSON, e o array
  abre direto em qualquer ferramenta. O stream continua possível escrevendo `[`, os eventos e `]`.
- **Permissão própria para exportar** (`audit.export`): separa ler de baixar em massa, mas quem lê
  pagina tudo pelo cursor do mesmo jeito; a separação daria falsa segurança.

## Decisão

- **Rotas** sob `/api`, todas com `audit.read` (owner, admin e viewer):
  - `GET /audit`: o `audit.query` com os filtros `from`, `to`, `actor`, `action`, `target`,
    `outcome`, o cursor `after` e `limit` (até 1000). Responde `{ events, next? }`.
  - `GET /audit/export?format=json|csv`: os mesmos filtros, sem `limit`. Lê de mil em mil a cada
    `pull` do stream, então o cliente lento segura a leitura e a memória não cresce.
  - `POST /audit/verify`: o `verify` da cadeia, `{ ok, checked, brokenAt? }`.
- **Exportação auditada:** `kernel.audit.export` com o ator da requisição e
  `details: { format, filters }`, gravado depois de a primeira página sair (falha nela grava
  `outcome: 'error'` e responde 500).
- **CSV** com uma coluna por campo achatado (`actorKind`, `actorId`, `actorName`, `onBehalfOf`,
  `targetType`, `targetId`...), `details` em JSON, RFC 4180 com `\r\n`. Célula de texto que começa
  com `=`, `+`, `-`, `@`, tab ou CR leva `'` na frente (injeção de fórmula, CWE-1236): ator, alvo e
  `details` vêm de fora.
- **Falha no meio do stream:** o 200 já saiu; o stream é abortado (arquivo cortado) e o log
  registra `audit.export.failed`.

## Consequências

- O app lê, exporta e verifica a auditoria sem plugin admin, e cada exportação em massa fica com
  quem a fez.
- O viewer exporta: quem pode ler a auditoria pode baixá-la. Se um papel precisar ler sem baixar,
  a permissão nova entra num ADR que substitua este.
- shortcut: o `verify` pela API percorre a cadeia inteira na requisição, sem limite nem cache. Em
  base grande ele é lento; o script do app (`verifyAudit`) continua sendo o caminho para rodar fora
  do processo.
- O arquivo cortado por falha não se distingue de um completo pelo status. No JSON o array fica
  sem `]`; no CSV, a última linha pode vir pela metade.
