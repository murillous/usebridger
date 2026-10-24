# ADR 0119 — Pseudônimo estável do usuário nos logs

**Status:** Aceito (2026-10-24) · Complementa o [ADR 0118](0118-contrato-de-log-estruturado.md)
(campos `chat` e `sender`) e usa a chave mestra do [ADR 0117](0117-segredos-cifrados-editaveis-pelo-dashboard.md)

## Contexto

O `chat` do log por mensagem era o id em texto puro (JID, LID), e o `lid` aparecia em logs do
`transport-baileys`. Com o Loki, isso é dado pessoal (telefone, JID) espalhado pela infraestrutura,
com a retenção e o acesso do Loki, fora do controle da LGPD (#225). Ao mesmo tempo, seguir um
usuário para estudar o que ele fez antes de um bug exige um id **estável**: o HMAC do
`plugin-metrics` para ativos do dia usa uma chave aleatória por dia e não serve.

## Decisão

Nos logs, usuário e grupo aparecem por **pseudônimo estável**.

- **Formato:** `u_` (usuário) ou `g_` (grupo) + base64url do HMAC-SHA256 do id, truncado em
  **16 bytes** (22 caracteres). 128 bits deixam a colisão desprezível para qualquer base real
  (paradoxo do aniversário: ~2^64 ids para 50%), com a linha menor que o hash inteiro (43
  caracteres) sem custo prático.
- **Chave:** derivada por HKDF-SHA256 da chave mestra `BRIDGER_SECRET_KEY` (ADR 0117), com o rótulo
  `bridger-pseudonym-v1`. O rótulo próprio isola o uso: a chave de pseudônimo não cifra segredo, e
  a de cifra não gera pseudônimo. Nunca é logada.
- **Rotação:** não há rotação própria. Trocar a chave mestra **muda todos os pseudônimos**: o
  histórico anterior no Loki continua consultável, mas não casa mais com os novos. É aceitável: a
  rotação da mestra é rara e deliberada, e o pseudônimo serve a investigação de janela curta.
  `BRIDGER_SECRET_KEY_PREVIOUS` **não** entra: só a chave atual gera pseudônimo.
- **Sem chave mestra:** o bot usa uma chave aleatória do processo (os pseudônimos valem só até o
  restart) e loga `bot.pseudonym.ephemeral` (info) no start. O storage não guarda chave de
  pseudônimo: seria mais um segredo em repouso sem o cuidado do ADR 0117.
- **Aplicação automática:** o logger do bot troca os campos `chat` e `sender` (em chamadas e em
  `child`) por pseudônimo, para o core, os transports, os plugins e o sinal `log` dos
  observadores (o pseudônimo é aplicado antes do tap). O tipo (`u_`/`g_`) vem do id: `@g.us` e id
  começado em `-` são grupo; o resto, usuário. Valor que já tem a forma de pseudônimo
  (`ctx.pseudonym`) passa como está. O `chatId` cru deixa de ser binding.
- **API para plugins:** `ctx.pseudonym(id, kind?)`.
- **Redação de reserva:** o logger do core troca por `[REDACTED]`, na linha final, JIDs
  (`@s.whatsapp.net`, `@g.us`, `@lid`, `@c.us`, `@broadcast`, `@newsletter`) e telefones de 10 a 15
  dígitos, em campos, mensagem, bindings e `err`. O reconhecedor por formato do `plugin-metrics`
  foi promovido ao core (`isPersonalId`, `redactPersonalIds`); trocar o regex local do
  `plugin-metrics` por ele fica para a #241.
- **O que conta como id pessoal:** `chatId`/`senderId` (campos `chat`/`sender`), o `lid`, o
  telefone de pareamento e qualquer JID. O `transport-baileys` deixou de pôr o `lid` nos campos;
  linhas da biblioteca repassadas pelo adapter passam pela redação de reserva. **Nome de contato**
  não é reconhecível por formato: quem loga nome responde por isso (e o core não o loga).
- **Converter telefone em pseudônimo:** o comando `bridger-pseudonym [--group] <id>` (no pacote
  `@usebridger/core`) calcula o pseudônimo com a `BRIDGER_SECRET_KEY` do ambiente. A conversão é
  só nesse sentido. A ação no dashboard, atrás de permissão e com evento de auditoria, depende da
  #223 e da #224 e fica fora deste ADR.

## Falsos positivos e limites da redação de reserva

É heurística de formato, os mesmos limites do `plugin-metrics`:

- Um número de 10 a 15 dígitos que não é telefone (epoch em ms, id de pedido) dentro de **texto** é
  trocado. Número em valor JSON (depois de `:` ou `,`) e dígitos dentro de palavra não são.
- Um id opaco fora dos formatos (UUID de usuário, handle sem `@`) passa; quem os loga usa
  `ctx.pseudonym`.
- O CLI recebe o id por inteiro, como o transport o usa. Com endereçamento por LID, o `chat` do
  log é o LID, e o telefone não leva a ele sem o mapeamento do WhatsApp: use o LID.

## Consequências

- Os logs não carregam telefone nem JID por padrão; achar um usuário passa pelo CLI.
- Trocar `BRIDGER_SECRET_KEY` quebra a continuidade dos pseudônimos (documentado em `docs/logger.md`).
- Um `config.logger` próprio do app recebe `chat`/`sender` já pseudonimizados, mas **não** a
  redação de reserva (que vive no `createLogger` do core).
- Quem parseava o `chat` como id real (alertas, dashboards) precisa buscar pelo pseudônimo.
