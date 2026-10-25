# ADR 0122 — Log de auditoria no kernel (`ctx.audit`)

**Status:** Proposto · Issue #224 · Depende do [ADR 0011](0011-escopo-do-core.md) (escopo do core),
do [ADR 0107](0107-acesso-admin-para-plugins.md) (ações admin), do
[ADR 0068](0068-isolamento-por-tenant.md) (tenant), do [ADR 0070](0070-trava-de-sessao-entre-processos.md)
(trava de sessão), do [ADR 0118](0118-contrato-de-log-estruturado.md) (log) e do
[ADR 0120](0120-trace-e-trilha-de-eventos.md) (`trace`)

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

1. **Uma cadeia por sessão — recomendada.** A trava do ADR 0070 garante um dono por sessão, então
   a ordem é total. O tenant é campo do evento, não da cadeia.
2. Uma cadeia por tenant. Descartada: precisa de um escritor serializado por tenant, `verify` por
   tenant, e a expurgação de um tenant não cabe numa cadeia compartilhada; ganho só se tenants
   forem auditados por partes diferentes (não é o caso hoje).

**Integridade: o que o hash promete.**

1. **HMAC-SHA256 com chave derivada da `BRIDGER_SECRET_KEY` — recomendada** (mesmo caminho do
   pseudônimo, ADR 0119). Quem só tem acesso ao banco não consegue editar o meio e recalcular a
   cadeia dali em diante, porque não tem a chave. **Limite real:** quem tem banco **e** a chave
   forja tudo; quem tem só o banco pode apagar o final ou tudo sem que a cadeia acuse (falta de
   eventos não é elo quebrado). Trocar a chave invalida a verificação do passado (a chave anterior
   precisa ser guardada para o `verify`).
2. SHA-256 puro (`sha256(prevHash + JSON)`, o da issue). Detecta só adulteração ingênua (editar
   um evento sem recalcular): quem tem o banco edita no meio e recalcula tudo dali em diante sem
   ser detectado. Além disso, o mesmo limite de apagar o final.
3. Ancorar o topo da cadeia fora do banco (hash do último `seq` publicado em log externo, WORM
   ou carimbo de tempo). É a única que detecta o corte do final e o recálculo por quem tem a chave;
   depende de destino externo, então fica como ponto de extensão (abaixo), somável à opção 1.

**Fila cheia: descartar × bloquear o `record`.**

1. **Descartar o evento novo, com sinal e log — recomendada.** Bloquear travaria o caminho da
   mensagem por causa do banco.
2. Bloquear (back-pressure total). Fica como opção futura (`audit.onFull: 'block'`) se o contrato
   público exigir perda zero.

**Como avisar do descarte.**

1. **Sinal de observador `audit.dropped` + log `error` `audit.dropped` — recomendada.** Não muda a
   API pública de eventos: o `PluginErrorEvent` (`events/types.ts`) exige `plugin` e uma `phase`
   de lista fechada, e o descarte não é falha de um plugin.
2. `plugin.error` com `phase: 'audit'` e `plugin` = quem chamou o `record`. Aviso no barramento
   que os plugins já assinam, mas muda a API pública (nova fase no tipo) e atribui ao plugin uma
   falha que é do storage. Registrada como alternativa.

**`query` e `verify`: quem chama.**

1. **Só admin (permissão do ADR 0107) — recomendada.** Isso deixa de fora o "serviço
   `audit.query(...)` para plugins com permissão" da issue (relatórios do inbox); um plugin de
   relatório só lê auditoria se for autorizado como admin, ou numa issue futura com permissão de
   leitura própria.
2. Permissão de leitura separada já agora. Descartada por ora: não há consumidor antes do inbox.

## Decisão

### Evento

```ts
interface AuditEvent {
  v: 1;                  // versão do formato (e do JSON canônico) que entra no hash
  eventId: string;       // ulid, só para referência humana; não é o `id` do storage
  seq: number;           // posição na cadeia da sessão; chave da cadeia e do cursor
  at: string;            // ISO 8601 UTC, relógio do servidor, nunca do cliente
  actor:
    | { kind: 'user'; id: string; name: string }          // só preenchido quando a #223 existir
    | { kind: 'system' }
    | { kind: 'plugin'; name: string }
    | { kind: 'contact'; transport: string; id: string }; // titular (pedido LGPD pelo chat)
  via?: string;          // plugin por cuja rota o request de `user`/`contact` chegou
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

O campo `id` é do storage: `normalizeDocument` (`storage/query.ts`) recusa `id` no documento e o
adapter gera o dele depois do insert, então ele **não entra no hash**. Por isso o ulid vira
`eventId` (referência, não chave) e a ordem e o cursor são o `seq`. O tipo `user` existe desde já
para o contrato não mudar, mas nada o preenche antes da #223.

### API

`ctx.audit.record({ action, target?, outcome?, details?, includeContent? })` (`outcome` padrão
`success`), `ctx.audit.query(filtro)` e `ctx.audit.verify()`. `query` e `verify` exigem a permissão
de admin do ADR 0107. Não há `update` nem `delete`.

**Nome da ação.** O core exige que `action` comece com `<nome do plugin chamador>.`, e reserva os
prefixos `kernel.` e `audit.`: um plugin não forja a ação de outro nem a do kernel. A expurgação
segue o padrão das ações do kernel: `kernel.audit.purge`.

### Ator

- **`plugin`:** vem do `name` da closure do `ctx` de cada plugin, do mesmo jeito que o `observe`
  (`bot/plugin-context.ts`). Sem `AsyncLocalStorage`: o plugin não escolhe o ator porque o `ctx`
  que ele recebe já está amarrado ao nome dele.
- **`system`:** só nas chamadas internas do core (boot, stop, scheduler, expurgação, ações do
  kernel). O `record` do plugin nunca produz `system`.
- **`user` e `contact`:** são os que dependem do contexto assíncrono. Um `AsyncLocalStorage` do
  módulo de auditoria, no molde do `TenantScope` (`packages/core/src/tenant/scope.ts`), guarda o
  titular do request (`user` depois da #223) ou do fluxo LGPD (`contact`, #225). Quando o request
  chega pela rota de um plugin, o evento leva `via: <plugin>`.

| Contexto | Ator |
| --- | --- |
| core: boot, stop, job, expurgação | `system` |
| `record` chamado por um plugin sem titular no escopo | `plugin` |
| escopo com titular LGPD (#225) | `contact` (e `via`) |
| request HTTP autenticado (depois da #223) | `user` (e `via`) |

### `record` e a fila

`record` é síncrono e barato: monta o evento, redige `details`, enfileira em memória e devolve
sem aguardar. Um dreno por vez, nesta instância, grava a fila.

- **Sem lote nem transação:** o `StoragePort` não tem insert em lote nem transação
  (`storage/types.ts`). O dreno grava **um evento por vez**, em ordem de `seq`; "lote" aqui é só
  "esvaziar a fila de uma vez", não uma operação de storage. `seq` e `prevHash` **só avançam
  depois de um insert confirmado**. Depois de **qualquer** erro (inclusive timeout, que é
  ambíguo: o insert pode ter entrado), o dreno **relê o topo gravado** (`orderBy: seq desc`,
  `limit: 1`) antes de tentar de novo, e reconstrói `seq` e `prevHash` dele. Assim uma falha
  ambígua não duplica `seq` nem bifurca a cadeia.
- **Flush:** a cada **1 s** ou ao chegar a **100 eventos**, o que vier primeiro, e no `stop`.
- **Limite:** **10.000 eventos** em memória (~10 MB com eventos de ~1 KB).
- **Storage falhou:** log `error` com `event: 'audit.flush_failed'` (ADR 0118); a fila mantém os
  eventos e tenta de novo com espera crescente (1 s até 30 s), relendo o topo como acima.
- **Passou do limite:** o evento novo é descartado, com log `error` `event: 'audit.dropped'` e o
  sinal `audit.dropped`.
- **Trava de sessão perdida (ADR 0070):** o `onLost` da trava (`bot/session-lease.ts`) chama
  `bot.stop()`, e outro processo pode ter assumido a sessão. Se o dreno continuasse, bifurcaria a
  cadeia. Na perda da trava o dreno **não grava**: a fila é descartada com o sinal `audit.dropped`
  (`reason: 'lease-lost'`) e log `error`. O novo dono relê o topo da cadeia ao assumir.
- **`stop` normal:** o dreno do `stop` tem **prazo** e respeita o `ShutdownOptions` existente
  (`bot/stop-hooks.ts`). O que não couber no prazo é descartado com `audit.dropped` (`reason:
  'shutdown'`).
- **Métrica:** o core não depende do `plugin-metrics`. O contador sai pelo novo sinal de
  observador `audit.dropped`, no registro do ADR 0102 (hoje `message.handled`, `outbound.sent` e
  `log`): `{ count, reason }`, em que `count` é o **incremento** daquele descarte (o `prom-client`
  precisa do delta, não do acumulado). O `plugin-metrics` o expõe como `audit_dropped_total`.
  Descartes que acontecem **antes** de o observador registrar (boot) ficam num contador
  interno e saem no primeiro sinal emitido depois do registro, com `reason: 'before-observer'`;
  o log `error` sai na hora de qualquer jeito.

### Redação de `details`

`details` não tem schema Zod, então o caminho por schema não serve aqui. A redação usa o
`createRedactor(SecretSource)` (`logger/redact.ts`), o mesmo do `ctx.admin` (ADR 0107), que censura:

1. os **valores** secretos conhecidos (as configs `secret` e os segredos do bot);
2. chaves conhecidas, sem diferenciar maiúscula, em qualquer nível: `password`, `passwd`,
   `token`, `secret`, `apiKey`, `api_key`, `authorization`, `cookie`.

O caminho por schema (`isSecretSchema`, `mapSecrets` e `SECRET_MASK` em `config/plugin-configs.ts`)
vale **só para o diff de `kernel.config.update`**, onde o schema do plugin existe.

**Conteúdo de mensagem.** A chave reservada `content` em `details` é **removida por padrão**: a
auditoria registra o fato, não o texto (ADR 0120). Quem precisa passa `includeContent: true`
**no próprio `record`**, ação por ação; não há opção global. (Alternativa: cortar a opção e
proibir conteúdo de vez; fica para o dono se preferir.)

Valor que não é JSON (função, `bigint`) é erro de programação e lança no `record`.

### Armazenamento

- Coleção `audit` no storage do kernel, no namespace do kernel da sessão (não no de plugin), com
  índices `seq`, `at`, `actorId`, `targetId`, `tenant` e `action`. Índices são de campos de
  primeiro nível (`CollectionOptions.indexes`), então o evento guarda `actorId` e `targetId`
  achatados, além de `actor` e `target`.
- **Cursor:** `where: { seq: { gt } }`, `orderBy: 'seq'`, `limit`. A paginação é por `seq`, não
  por `at`: o relógio pode voltar, `seq` não.
- **Append-only pela API:** só `append` e `query`. A única remoção é a expurgação. O limite é de
  API, não de banco: quem tem acesso ao banco escreve o que quiser, e a cadeia (Integridade) é o
  que detecta parte disso.
- **Volume:** ordem de 1 KB por evento. Mil ações por dia dão ~365 mil eventos e ~365 MB em 5
  anos, com "contato visualizado" limitado a 1 por contato, usuário e hora, como na issue. SQLite
  aguenta isso com os índices. Acima de ~10 milhões de eventos, ou com mais de um processo lendo,
  Postgres. O ADR 0012 isola o engine: nada aqui muda de um para o outro.

### Cadeia de hash e `verify`

`hash = HMAC-SHA256(chave, prevHash + JSON canônico do evento sem o campo hash)`, com a chave
derivada da `BRIDGER_SECRET_KEY` (ver Opções). JSON canônico: chaves ordenadas, sem espaços,
`undefined` omitido. O primeiro elo usa `prevHash` de 64 zeros (gênese).

- **Uma cadeia por sessão.** Tenant é campo do evento: `verify` percorre a sessão inteira, e o
  filtro por tenant é só da consulta.
- **Um escritor por sessão** é garantido pela trava do ADR 0070 (com TTL), não por haver um só
  `Bot` no processo: os ADR 0003 e 0071 permitem dois `Bot` no processo, cada um com a sua sessão
  e a sua cadeia. Na perda da trava, ver a seção da fila.
- **`verify`:** API `ctx.audit.verify()` que devolve `{ ok, checked, brokenAt? }`, apontando o
  **primeiro elo quebrado** (`seq` e `eventId`).
- **CLI.** O core não abre o banco: não depende de `storage-sqlite` nem `storage-postgres`, o
  storage chega no `createBot({ storage })`. Recomendado: **só a API `verify` no core**, e o app
  monta o próprio script (exemplo em `packages/core/docs/audit.md`) que cria o `StoragePort` e
  chama `verify`. Alternativas: um CLI por adapter (`storage-sqlite`/`postgres` exportam o
  binário) ou um CLI do core que importa um módulo do app que exporta o `StoragePort`. Ambas
  adicionam um binário para manter; ficam para o dono se quiser.
- **Limite, em `packages/core/docs/audit.md`:** ver "Integridade". Com HMAC, editar o meio é
  detectado por quem não tem a chave; apagar o final ou tudo não é.

### Retenção e expurgação

`audit.retentionDays` na config do core, padrão **1825 (5 anos)**, configurável para menos. Um
job diário no scheduler faz a expurgação.

O corte é por `at`, mas a apagada tem de ser um prefixo contíguo em `seq`, e o relógio pode ter
voltado. O job acha o **maior `seq` com `at < corte`** (`toSeq`) e apaga `seq <= toSeq`.

Ordem, para a cadeia nunca ficar sem explicação: **grava `kernel.audit.purge` primeiro** (ator
`system`, `details: { fromSeq, toSeq, count, lastHash }`, em que `lastHash` é o `hash` do elo
`toSeq`) como evento normal da cadeia, e **só então apaga**. Se o processo cair no meio, sobra um
`kernel.audit.purge` sem buraco, que é inofensivo e o job refaz.

O `verify` aceita o buraco no início se o primeiro elo restante tiver `prevHash === lastHash` e
`seq === toSeq + 1` de um `kernel.audit.purge` gravado depois. Apagar o prefixo é legítimo e
visível; apagar em qualquer outro ponto é detectado.

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
| `kernel.config.update` (`setOverrides`) | diff por caminho, valores `secret` redigidos pelo schema |
| `kernel.secret.update` | só o **caminho** do segredo, nunca o valor |
| `kernel.boot` / `kernel.stop` | versão e plugins carregados |
| `kernel.audit.purge` | intervalo de `seq`, contagem e `lastHash` |

O ator é o do contexto: um plugin com acesso admin é `plugin`, e o dashboard autenticado será
`user` quando a #223 existir.

### Fora deste ADR e adiado

- Aba "Auditoria" do dashboard, exportação CSV/JSON e a permissão `dashboard.audit.read`:
  dependem da #223 e do dashboard do M7. Vão para a issue própria #261.
- Exportação periódica em JSON Lines assinado, ou ancoragem do topo fora do banco (S3 com
  object lock etc.): ponto de extensão futuro. É a defesa contra o corte do final; aqui fica só o
  contrato de que o destino é plugável.
- Auditar ações do inbox, LGPD e do dashboard: cada feature chama `ctx.audit.record` na sua issue.

## Consequências

- O core ganha `ctx.audit`, a coleção `audit`, um sinal de observador (`audit.dropped`) e a
  reserva dos prefixos `kernel.` e `audit.`; é mudança de API pública (minor) e leva changeset.
  Sem CLI no core.
- O custo no caminho quente é montar o evento, redigir e enfileirar; a meta é p99 < 1 ms, medida
  em benchmark (critério da #224). Sem nenhum `record`, o custo é zero.
- Auditoria perdida é possível, e sempre visível: fila cheia, perda da trava e prazo do `stop`
  estourado geram `audit.dropped`. Numa **queda do processo** a perda é a **fila inteira** (até
  10.000 eventos, se o storage estava fora), não só o último segundo; quem não aceita isso
  precisa da opção de bloqueio, adiada.
- O `verify` e a expurgação leem a coleção em lotes por `seq` e devem rodar fora do pico.
- Retenção de 5 anos torna o volume um tema de capacidade do storage (ver Armazenamento).
- Mudar o formato do evento ou o JSON canônico exige novo valor de `v`; o `verify` precisa
  continuar entendendo as versões antigas. Trocar a `BRIDGER_SECRET_KEY` exige guardar a chave
  anterior para verificar o passado.
