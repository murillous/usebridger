# ADR 0129 — Conexão e tempo real pela API: pareamento e logout no transport, stream SSE por sessão

**Status:** Aceito (2026-10-26) · Detalha o **D125**
([ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md)) (áreas conexão e tempo real) · Estende
o **D46** ([ADR 0046](0046-codigo-de-pareamento.md)) (código sob demanda)

## Contexto

O QR, o código de pareamento, o status da conexão e os logs ao vivo só existiam no WebSocket do
`plugin-dashboard`. Um app sem o dashboard não conectava o número. O ADR 0125 põe conexão e tempo
real na API do core, por SSE, com `id` em todo evento e retomada pelo `Last-Event-ID` (#276).

Faltavam três peças:

- **Pedir o código em runtime.** O código de pareamento só saía com `pairing.phone` fixo na opção
  do adapter (ADR 0046). A API recebe o telefone na hora.
- **Logout.** O `Transport` não tinha como desvincular a sessão na plataforma; só `disconnect`,
  que mantém a credencial.
- **Um lugar para os eventos.** O barramento é dos plugins e o listener segura o chat; os logs
  chegam pelos observadores (ADR 0105). O stream precisa de um buffer com id para retomar.

Alternativas consideradas:

- **Logout no kernel** (`disconnect` + apagar o auth state + `connect`): no WhatsApp o aparelho
  continua listado como conectado, e o kernel só sabe limpar o auth da fábrica.
- **Código só pela opção do adapter**, com a API trocando a opção e reconectando: derruba a
  tentativa em curso e não serve a outro transport.
- **Um stream por tipo** (`/events/logs`, `/events/connection`): mais conexões abertas por aba, e
  o browser limita a seis por origem em HTTP/1.1.

## Decisão

- **Dois métodos opcionais no `Transport`**, só por adição:
  - `requestPairingCode?(phone)` resolve com o código e também o emite em
    `connection.pairing-code`, para o barramento e o stream o verem.
  - `logout?()` desvincula a sessão e emite `closed` com `logged-out`. A política de reconexão já
    trata esse motivo: limpa a sessão e pareia de novo, com novo QR.
  - Os dois exigem a capability `pairing`. Sem o método ou a capability, a rota responde 409.
- **Rotas do core**, montadas por sessão a partir do bot (`SessionHttp.attach`):
  - `GET /connection` (`connection.read`): estado, motivo do `closed`, transport, se pareia, conta
    conectada (`transport.self`, ADR 0106), `connectedSince`, `reconnections` e `qrExpiresAt`
    (ADR 0111).
  - `POST /connection/pairing-code` (`connection.manage`), com `{ phone }` só em dígitos com DDI.
    Sessão já conectada é 409.
  - `POST /connection/logout` (`connection.manage`).
  - Os dois `POST` gravam auditoria (`kernel.connection.pairing-code`, `kernel.connection.logout`)
    sem o telefone.
- **`GET /events` em SSE** (`connection.read`), um stream por sessão com `connection.status`,
  `connection.qr`, `connection.pairing-code`, `log` e `plugin.status` (reload, disable e enable,
  com os dependentes).
  - Filtro por permissão em cada evento: `log` exige `logs.read`; QR e código exigem
    `connection.manage`. As linhas de log que carregam o valor do QR ou do código
    (`connection.qr.value`, `connection.pairing-code.value`) também exigem `connection.manage`.
  - Filtro por tipo na query: `?types=log,connection.status`. Tipo desconhecido é 400.
  - Id `<boot>-<seq>`. O `<boot>` muda a cada processo, então id de outro processo não casa com a
    sequência daqui.
  - Buffer dos últimos 1000 eventos. Com `Last-Event-ID` deste processo, o servidor manda o que
    veio depois do id e segue ao vivo. Sem ele, ou de outro processo, manda o estado atual: o
    último `connection.status` e o QR/código que ainda vale.
  - O log no stream é o sinal dos observadores, com segredos e ids pessoais já censurados
    (ADR 0105, 0118, 0119).
  - Comentário `: ping` a cada 15 s e `retry: 2000`. Cliente com mais de 1000 eventos na fila tem
    o stream fechado e retoma pelo último id. O stop do bot fecha os streams.
- **Na spec**, a resposta sai como `text/event-stream` com `itemSchema`, e cada item é componente
  nomeado (`ConnectionStatusEvent`, `LogEvent`...), com o `data` descrito como o objeto que o
  cliente tem depois do `JSON.parse`. `ApiOperation.stream: true` liga isso.
- **Sem servidor HTTP no bot, nada disso existe**: o observador de `log` do stream só é
  registrado com `BotConfig.http`, para o bot sem API não montar o sinal a cada linha.

## Consequências

- Um app conecta o número só com a API: lê `GET /connection`, abre `GET /events`, mostra o QR ou
  pede o código, e faz logout.
- `TransportEvents` não muda; o `Transport` ganha dois métodos opcionais. Adapter que não os
  implementa segue valendo, com 409 nas rotas.
- O `transport-baileys` implementa os dois. O `FakeTransport` do `@usebridger/testing` também,
  para testar o pareamento sem rede.
- Com `BotConfig.http`, toda linha de log que passa do nível monta o sinal, mesmo sem cliente
  conectado. É o custo de não perder log numa queda curta.
- O retorno é curto. Um cliente fora por mais de 1000 eventos perde o que girou; ele relê o estado
  em `GET /connection`.
- O stream não revalida a credencial depois de aberto. Uma sessão revogada continua recebendo até
  o stream cair; a reconexão já é recusada.
- A porta continua abrindo só com rota de plugin ou transport (ADR 0072): as rotas do core não
  contam.
