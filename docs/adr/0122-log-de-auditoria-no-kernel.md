# ADR 0122 — Log de auditoria no kernel (`ctx.audit`)

**Status:** Proposto · Issue #224 · Depende do [ADR 0011](0011-escopo-do-core.md) (escopo do core),
do [ADR 0107](0107-acesso-admin-para-plugins-autorizados.md) (ações admin), do
[ADR 0068](0068-isolamento-por-tenant.md) (tenant), do [ADR 0118](0118-contrato-de-log-estruturado.md)
(log) e do [ADR 0120](0120-trace-e-trilha-de-eventos.md) (`trace`)

## Contexto

Precisamos responder **quem fez o quê, quando e sobre o quê**: contratação pública (TR 4.09.1 e
5.2.4 do CRMV-MT), LGPD (art. 37 e 46) e operação (quem desligou um plugin, trocou um segredo,
mudou a config). O log do pino (`ctx.logger`) não serve: é operacional, rotaciona, tem ruído, não
tem integridade nem consulta estruturada. A trilha do ADR 0120 também não: é diagnóstico, sem
conteúdo e sem ator confiável.

## Opções consideradas

**Onde mora.**

1. **Core mínimo (`ctx.audit`) — recomendada.** `record`, fila, storage append-only, hash,
   `verify` e `query` no core; consulta/UI e exportação ficam no dashboard.
2. Plugin `plugin-audit`. Descartada: o core precisa auditar as próprias ações admin (plugin
   enable/disable/reload, `setOverrides`, segredo, boot/stop, ADR 0107) e não pode depender de
   plugin (regras de dependência do plano §5.4). Plugin desligado ou ausente significaria ação
   admin sem registro, que é justamente a falha de conformidade que a auditoria evita.
3. Só log estruturado com `event` fixo no Loki. Descartada: sem integridade, sem consulta, e
   retenção/rotação fora do nosso controle.

**Justificativa contra o ADR 0011.** "Entrar algo novo no core exige um ADR": este é o ADR. O
core fica mínimo (sem UI, sem exportação, sem permissões); o que o torna core é ser transversal e
precisar funcionar sem plugin nenhum, o mesmo argumento do storage e do logger.

**Cadeia de hash única ou por tenant.**

1. **Uma cadeia por sessão — recomendada.** O ADR 0003 dá uma sessão por processo, então há um
   único escritor e a ordem é total. O tenant é campo do evento, não da cadeia.
2. Uma cadeia por tenant. Descartada: precisa de um escritor serializado por tenant, `verify` por
   tenant, e a expurgação de um tenant não cabe numa cadeia compartilhada; ganho só se tenants
   forem auditados por partes diferentes (não é o caso hoje).

**Fila cheia: descartar × bloquear o `record`.**

1. **Descartar o evento novo, com `plugin.error` e métrica — recomendada.** Bloquear travaria o
   caminho da mensagem por causa do banco.
2. Bloquear (back-pressure total). Fica como opção futura (`audit.onFull: 'block'`) se o contrato
   público exigir perda zero.

## Decisão

### Evento

```ts
interface AuditEvent {
  v: 1;                  // versão do formato (e do JSON canônico) que entra no hash
  id: string;            // ulid: ordenável por tempo
  at: string;            // ISO 8601 UTC, relógio do servidor, nunca do cliente
  seq: number;           // posição na cadeia da sessão
  actor:
    | { kind: 'user'; id: string; name: string }          // só preenchido quando a #223 existir
    | { kind: 'system' }
    | { kind: 'plugin'; name: string }
    | { kind: 'contact'; transport: string; id: string }; // titular (pedido LGPD pelo chat)
  action: string;        // '<plugin>.<recurso>.<verbo>', ex.: 'inbox.ticket.transfer'
  target?: { type: string; id: string };
  outcome: 'success' | 'denied' | 'error';
  ip?: string; userAgent?: string;                         // quando vem do HTTP
  tenant?: string; session: string;
  trace?: string;                                          // ADR 0120
  details?: Record<string, JsonValue>;                     // já redigido
  prevHash: string; hash: string;
}
```

O tipo `user` existe desde já para o contrato não mudar, mas nada o preenche antes da #223.

### API

`ctx.audit.record({ action, target?, outcome?, details? })` (`outcome` padrão `success`),
`ctx.audit.query(filtro)` e `ctx.audit.verify()`. `query` e `verify` exigem a permissão de admin
do ADR 0107 para plugins. Não há `update` nem `delete`.

### Ator vem do contexto

Um `AsyncLocalStorage` do módulo de auditoria, no mesmo molde do `TenantScope`
(`packages/core/src/tenant/scope.ts`). O `record` **não aceita** `actor`: o core lê do escopo.

| Contexto | Ator |
| --- | --- |
| job do scheduler, boot, stop, expurgação | `system` |
| handler, hook ou comando de plugin | `plugin` (nome do dono) |
| mensagem do titular em fluxo LGPD (#225) | `contact` |
| request HTTP autenticado (depois da #223) | `user` |

Sem escopo ativo, o ator é `system`. Um plugin não escolhe nem falsifica o ator.

### `record` e a fila

`record` é síncrono e barato: monta o evento, redige `details`, enfileira em memória e devolve
sem aguardar. Um único escritor drena a fila em lote, e é ele quem atribui `seq`, `prevHash` e
`hash` (o hash depende da ordem de gravação, não da de chamada).

- **Flush:** a cada **1 s** ou ao chegar a **100 eventos**, o que vier primeiro, e no `stop`
  (drena tudo antes de fechar).
- **Limite:** **10.000 eventos** em memória (~10 MB com eventos de ~1 KB).
- **Storage falhou:** log `error` com `event: 'audit.flush_failed'` (ADR 0118); a fila mantém os
  eventos e o flush tenta de novo com espera crescente (1 s até 30 s).
- **Passou do limite:** o evento novo é descartado, emite `plugin.error` e incrementa o contador
  de descartes. Cada descarte também gera log `error` com `event: 'audit.dropped'` e a contagem
  acumulada.
- **Métrica:** o core não depende do `plugin-metrics`. O contador sai por um novo sinal de
  observador, `audit.dropped` (`{ count, reason }`), no registro do ADR 0102 (hoje
  `message.handled`, `outbound.sent` e `log`), e o `plugin-metrics` o expõe como
  `audit_dropped_total`, como já faz com `message.handled`. Sem observador o sinal não custa
  nada (guarda `has`).

### Redação de `details`

Antes de enfileirar, `details` passa por um filtro, na ordem:

1. campos `secret` do schema Zod do plugin (`secret()` em `config/schema.ts`), em qualquer nível,
   viram o texto de censura já usado por `describe`;
2. chaves conhecidas, sem diferenciar maiúscula, em qualquer nível: `password`, `passwd`,
   `token`, `secret`, `apiKey`, `api_key`, `authorization`, `cookie`;
3. **conteúdo de mensagem: `includeContent: false` por padrão.** A auditoria registra o fato, não
   o texto (mesma regra do ADR 0120). Quem precisa liga a opção por ação, de forma explícita.

Valor que não é JSON (função, `bigint`) é erro de programação e lança no `record`.

### Armazenamento

- Coleção `audit` no storage do kernel, no namespace do kernel da sessão (não no de plugin), com
  índices `at`, `actorId`, `targetId`, `tenant` e `action`. Índices são de campos de primeiro
  nível (`CollectionOptions.indexes`), então o evento guarda `actorId` e `targetId` achatados,
  além de `actor` e `target`.
- **Append-only pela API:** só `append` e `query`. A única remoção é a expurgação por retenção.
  O limite é de API, não de banco: quem tem acesso ao banco escreve o que quiser, e a cadeia
  é o que detecta isso.
- **Volume:** ordem de 1 KB por evento. Mil ações por dia (operação com dashboard e inbox)
  dão ~365 mil eventos e ~365 MB em 5 anos, com "contato visualizado" limitado a 1 por contato,
  usuário e hora, como na issue. SQLite aguenta isso com os índices, e a consulta paginada por
  cursor em `at` (ULID) fica estável. Acima de ~10 milhões de eventos, ou com mais de um
  processo lendo, Postgres. O ADR 0013 isola o engine: nada aqui muda de um para o outro.

### Cadeia de hash e `verify`

`hash = sha256(prevHash + JSON canônico do evento sem o campo hash)`. JSON canônico: chaves
ordenadas, sem espaços, `undefined` omitido. O primeiro elo usa `prevHash` de 64 zeros (gênese).

- **Uma cadeia por sessão** (ver Opções). Tenant é campo do evento: `verify` percorre a sessão
  inteira, e o filtro por tenant é só da consulta.
- O escritor único (a fila) garante a ordem, e só um processo escreve por sessão (ADR 0003). Num
  reinício, o escritor lê o último `seq` e `hash` gravados antes de aceitar eventos.
- **`verify`:** API (`ctx.audit.verify()` devolve `{ ok, checked, brokenAt? }`) e CLI
  `bridger-audit-verify`, no padrão do `packages/core/src/cli/pseudonym.ts` (`run(argv, io)`
  testável, configuração vinda do ambiente). Sai com 0 se íntegra e com 1 apontando o **primeiro
  elo quebrado** (`seq` e `id`).
- **Limite, documentado em `packages/core/docs/audit.md`:** a cadeia detecta edição ou remoção
  **no meio**. Não impede, nem detecta sozinha, que quem tem acesso ao banco apague **tudo**, ou
  corte o final da cadeia. Para isso serve o ponto de extensão da exportação assinada (abaixo).

### Retenção e expurgação

`audit.retentionDays` na config do core, padrão **1825 (5 anos)**, configurável para menos. Um
job diário no scheduler apaga os eventos mais velhos que o corte e grava `audit.purge` (ator
`system`, `details: { from, to, count, lastHash }`) **como um evento normal da cadeia**.

Como a cadeia continua: a expurgação sempre apaga um prefixo contíguo. O primeiro evento que
sobra guarda um `prevHash` que aponta para um elo que não existe mais. O `audit.purge` registra o
`hash` do último elo apagado (`lastHash`), e o `verify` aceita o primeiro elo restante se o seu
`prevHash` bater com o `lastHash` de um `audit.purge` gravado depois. Apagar o prefixo é legítimo
e visível; apagar em qualquer outro ponto é detectado.

### Tenant, relógio e `trace`

- O evento carrega `tenant` do `TenantScope` corrente (ADR 0068); a consulta filtra por ele e,
  num request de tenant, o filtro é imposto pelo core, não escolhido por quem consulta.
- `at` vem do relógio do servidor (injetável nos testes). Nenhum campo de tempo do cliente entra.
- **`trace`:** o `record` grava o `trace` corrente (ADR 0120) no evento, ligando a ação ao log
  de diagnóstico. Entra no hash como qualquer campo. Cumpre a seção "Relação com o `ctx.audit`"
  do ADR 0120.

### Ações do kernel auditadas automaticamente

| Ação | `details` |
| --- | --- |
| `kernel.plugin.enable` / `disable` / `reload` | `{ plugin }` |
| `kernel.config.update` (`setOverrides`) | diff por caminho, com valores `secret` e chaves conhecidas redigidos |
| `kernel.secret.update` | só o **caminho** do segredo, nunca o valor |
| `kernel.boot` / `kernel.stop` | versão e plugins carregados |
| `audit.purge` | intervalo, contagem e `lastHash` |

O ator é o do contexto: um plugin com acesso admin é `plugin`, e o dashboard autenticado será
`user` quando a #223 existir.

### Fora deste ADR e adiado

- Aba "Auditoria" do dashboard, exportação CSV/JSON e a permissão `dashboard.audit.read`:
  dependem da #223 e do dashboard do M7. Vão para issue própria.
- Exportação periódica em JSON Lines assinado (S3 com object lock etc.): ponto de extensão
  futuro. É a defesa contra o "apagar tudo"; aqui fica só o contrato de que o destino é plugável.
- Auditar ações do inbox, LGPD e do dashboard: cada feature chama `ctx.audit.record` na sua issue.

## Consequências

- O core ganha `ctx.audit`, a coleção `audit`, um sinal de observador (`audit.dropped`) e um CLI;
  é mudança de API pública (minor) e leva changeset.
- O custo no caminho quente é montar o evento, redigir e enfileirar; a meta é p99 < 1 ms, medida
  em benchmark (critério da #224). Sem nenhum `record`, o custo é zero.
- Auditoria perdida é possível em dois casos, ambos visíveis: fila cheia (métrica e
  `plugin.error`) e queda do processo antes do flush (até 1 s de eventos). Quem não aceita essa
  janela precisa da opção de bloqueio, adiada.
- `verify` e a expurgação leem a coleção inteira (em lotes) e devem rodar fora do pico.
- Retenção de 5 anos torna o volume um tema de capacidade do storage (ver Armazenamento).
- Mudar o formato do evento ou o JSON canônico exige novo valor de `v`; o `verify` precisa
  continuar entendendo as versões antigas.
