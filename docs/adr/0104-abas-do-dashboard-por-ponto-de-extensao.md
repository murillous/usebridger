# ADR 0104 — Abas do dashboard por ponto de extensão

**Status:** Substituído por [ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md)
(2026-10-25) · Aceito (2026-10-17) · Detalha **D103**
([ADR 0103](0103-plugins-oficiais-de-metricas-e-dashboard.md)) · Usa **D92**
([ADR 0092](0092-pontos-de-extensao-em-servicos.md)) e **D72** ([ADR 0072](0072-http-do-core.md))

## Contexto

O `plugin-dashboard` (#151) mostra QR, status, logs, config, plugins e métricas. Outros plugins
também querem uma tela no painel: o `reminders` quer listar e cancelar lembretes, o `ai` quer custo
por modelo. O dashboard tem de ficar fechado para modificação: uma tela nova não pode exigir
mudança nele.

O ADR 0103 já cobre as métricas: qualquer métrica registrada no serviço `metrics` aparece na seção
genérica, sem integração. Falta o que não é métrica: listas, ações e formulários.

A investigação:

- O ponto de extensão (D92) já tira a contribuição no teardown, reload e disable de quem
  contribuiu. O dashboard não precisa de ciclo de vida próprio para as abas.
- `extensionPoint(name).list()` devolve só as contribuições. O registry guarda o plugin de cada
  uma (`entry.plugin`), mas não o expõe. Sem ele, o dashboard não sabe de quem é a aba nem tem
  como separar `id` repetido entre plugins.
- O core não emite evento de carga ou reload de plugin; só `plugin.error`.
- O HTTP do core não autentica (D72). Quem expõe rota confere o próprio acesso.
- O Zod 4 gera JSON Schema (`toJSONSchema`), que a config de plugin já usa. O formulário de aba
  pode usar o mesmo caminho do M5-4.2.
- A interface do canvas de design (`packages/plugin-dashboard/docs/design.md`) já desenha uma aba
  só com widgets, em desktop e celular.

Alternativas consideradas:

- **Plugin serve a própria UI** (web component ou iframe numa rota dele). Liberdade total, mas cada
  plugin traz build, CSS e tema, abre rota que precisa da autenticação do dashboard e quebra o
  visual e o mobile.
- **Plugin registra rota no dashboard** (`dashboard.route(...)`). Resolve a autenticação, mas a UI
  continua por conta do plugin.
- **Ponto `dashboard.cards`**, só cards na Visão geral. Cobre números, não listas com ação nem
  formulários.
- **Campo `plugin` declarado na aba.** Resolve o dono sem mudar o core, mas repete o que o registry
  já sabe e pode mentir. É lacuna do core, e o CLAUDE.md manda resolver lá.

## Decisão

- **Ponto `dashboard.tabs`**, tipado em `ExtensionPoints` pelo `@usebridger/plugin-dashboard`.
  Quem contribui importa só o tipo e declara `after: ['plugin-dashboard']` (ou `dependsOn`, se não
  roda sem ele).

  ```ts
  interface DashboardTab {
    id: string; // [a-z0-9-]{1,40}, único dentro do plugin
    title: string;
    order?: number; // dentro do grupo Extensões; empate pela ordem de carga
    widgets: DashboardWidget[];
  }

  type DashboardWidget =
    | { kind: 'stats'; id: string; load(): Promise<StatItem[]> }
    | { kind: 'table'; id: string; columns: TableColumn[];
        load(q: { cursor?: string }): Promise<{ rows: TableRow[]; cursor?: string }>;
        actions?: TableAction[] }
    | { kind: 'series'; id: string; load(q: { days: number }): Promise<SeriesPoint[]> }
    | { kind: 'form'; id: string; schema: z.ZodType; submit(input: unknown): Promise<void> }
    | { kind: 'text'; id: string; markdown: string };

  interface TableAction {
    id: string;
    label: string;
    confirm?: boolean; // pede confirmação no browser antes do run
    run(input: { row: TableRow }): Promise<void>;
  }
  ```

- **Dados declarativos, desenho do dashboard.** O plugin devolve dados. O dashboard desenha com os
  próprios componentes, tokens e layout, inclusive o celular: no `table`, a primeira coluna vira a
  linha principal e as outras, a secundária. Nenhum plugin manda HTML, CSS ou script.
- **O core expõe o dono:** `ExtensionPoint<T>` ganha
  `entries(): readonly { plugin: string; value: T }[]`, na mesma ordem e com a mesma cópia do
  `list()`. É mudança aditiva no core (minor pelo D65).
- **Chave da aba: `<plugin>/<id>`.** Dois plugins podem usar o mesmo `id`. Repetido no mesmo
  plugin, a primeira vence e o dashboard registra `warn` uma vez.
- **Uma porta só.** Tudo passa pelas rotas do dashboard (`ctx.http`, sob `/plugins/dashboard`) e
  pela autenticação dele (M5-4.1):

  | Rota | Faz |
  | --- | --- |
  | `GET /api/tabs` | Manifesto: chave, título, ordem e widgets sem as funções; `form` com o JSON Schema |
  | `GET /api/tabs/:plugin/:tab/:widget` | Roda o `load`, com `cursor` ou `days` da query |
  | `POST /api/tabs/:plugin/:tab/:widget/actions/:action` | Roda o `run` de uma ação da tabela |
  | `POST /api/tabs/:plugin/:tab/:widget/submit` | Valida o corpo com o `schema` e roda o `submit` |

  O plugin que contribui não abre rota para a aba.
- **Leitura viva, sem cache.** Cada pedido lê `entries()` de novo. Aba que sumiu (reload, disable)
  responde 404, e o browser mostra "aba não está mais disponível". O browser busca o manifesto de
  novo a cada navegação e a cada reconexão do WebSocket. Não há evento `tabs.changed`.
- **Validação na leitura.** Contribuição com `id` inválido, `kind` desconhecido ou campo faltando é
  ignorada, com `warn` uma vez por chave. `kind` desconhecido também é ignorado para um plugin novo
  rodar num dashboard antigo.
- **Erro tem destino.** `load`, `run` ou `submit` que lança responde 500 só para aquele widget, com
  mensagem genérica. O erro vai para o log do dashboard com o plugin dono e a chave do widget; as
  outras abas e widgets seguem. `submit` com corpo inválido responde 400 com as issues do Zod, que
  aparecem junto dos campos.
- **Sem prazo próprio.** `load`, `run` e `submit` rodam fora da fila dos chats, como qualquer
  handler HTTP (D72). Trabalho longo é responsabilidade de quem contribui.
- **Por bot.** Cada `Bot` tem o seu registry e o seu dashboard (`/sessions/<sessão>/plugins/dashboard`
  nas sessões que não são a `default`). A aba de um plugin aparece no dashboard do bot em que ele
  roda.
- **Abas do core fora do ponto.** Visão geral, Métricas, Plugins e Configuração são desenhadas pelo
  dashboard; as de plugins entram no grupo Extensões (sidebar) e em Mais (celular).
- **Fora agora:** UI própria de plugin (web component servido pelo plugin), widget `log`, ação fora
  de tabela e push de dados em tempo real numa aba. Entram quando um caso não couber nos widgets.

## Consequências

- Aba nova não muda o dashboard, e um plugin sem frontend ganha tela com o visual e o mobile do
  painel.
- O conjunto de widgets vira contrato: tirar um `kind` ou mudar o formato de um `load` é major do
  `plugin-dashboard`. Acrescentar `kind` é minor, porque dashboard antigo ignora o que não conhece.
- O core ganha `ExtensionPoint.entries()`. Quem implementa `ExtensionPoint` fora do core (um fake de
  teste) precisa acrescentá-lo.
- `load` sem paginação pode devolver muito dado; o dashboard limita a resposta e corta o excesso
  com `warn`.
- Quem contribui conhece o formato dos widgets. Se o dashboard não estiver carregado, a contribuição
  fica no ponto sem leitor e não custa nada.
