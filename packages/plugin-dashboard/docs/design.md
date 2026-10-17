# Design do `plugin-dashboard`

Guia de design e de sistema do `@usebridger/plugin-dashboard` (M5-4, #151). Quem mexer na
interface ou criar uma aba nova segue este documento e o canvas. Decisões de base:
[ADR 0021](../../../docs/adr/0021-dashboard-vira-plugin.md),
[ADR 0076](../../../docs/adr/0076-http-do-core.md),
[ADR 0096](../../../docs/adr/0096-pontos-de-extensao-em-servicos.md) e
[ADR 0107](../../../docs/adr/0107-plugins-oficiais-de-metricas-e-dashboard.md).

## Canvas

**https://claude.ai/artifact/9mHnZZqd33jPZ1Mn7vERy7**

O canvas é a fonte visual. Ele é privado: o dono do repositório precisa compartilhá-lo pelo menu
Share antes de outra pessoa ou agente conseguir abrir. Quadros:

| Quadro | O que mostra |
| --- | --- |
| Visão geral | Status por bot/transport (QR e código só no WhatsApp, erro `fatal` nos de token), KPIs do dia, logs recentes |
| Métricas | Painéis fixos do kernel e a seção genérica com toda métrica registrada no serviço `metrics` |
| Plugins | Tabela de boot (estado, setup, `dependsOn`, serviços, contribuições) e enable/disable |
| Config de plugin (Zod) | Formulário gerado do schema, secret mascarado, erro junto do campo, reload em cascata |
| Aba contribuída por plugin | Aba `Lembretes` do plugin `reminders`, montada só com widgets, e o `contribute` que a gera |
| Design system | Tokens, tipografia, espaço, raio, elevação, componentes e widgets |
| Componente · Sidebar | Navegação: grupos Bot, Administração e Extensões (abas de plugins) |
| Mobile · Início, Métricas, Plugins, Config | As mesmas telas a 390 px |
| Mobile · Mais (extensões) | Logs, abas de plugins e conta |
| Mobile · Aba de plugin | A aba `Lembretes` com os mesmos widgets, em layout de celular |
| Componente · TabBar | Barra inferior: Início, Métricas, Plugins, Config, Mais |

Os números nas telas são ilustrativos.

## Princípios

- **A ação é a tinta.** Botão primário e item ativo usam `--ink`; não há cor de marca. A cor só
  carrega significado: azul (`--agent`) para informação e link; verde, âmbar e vermelho para
  estado.
- **Cor nunca sozinha.** Todo estado tem texto ("Conectado", "Erro fatal"), e todo gráfico tem
  rótulo acessível.
- **Denso e calmo.** Painel de operação: muita informação por tela, pouco ornamento. Sem
  gradiente, sem emoji, sem borda lateral colorida em card.
- **"Ao vivo" só quando é.** O indicador mostra a hora da última atualização, vira estado
  desatualizado quando o WebSocket cai, e a atualização pode ser pausada.
- **Aba de plugin parece do core.** O plugin descreve dados e ações; o dashboard desenha com os
  próprios componentes. Por isso uma aba nova não precisa de CSS nem de build próprio.

## Tokens

Referência visual: neutro quente monocromático (inspirado em agentes.chat). Os valores são
semânticos, com tema claro e escuro (`prefers-color-scheme` e escolha manual):

```css
:root {
  --bg: #f4f4f1;        --raised: #ffffff;    --sunken: #ebebe7;
  --ink: #151514;       --ink2: #2a2a28;      --muted: #5c5c58;
  --line: #17171614;    --line2: #17171624;   --plate: #7f7f7f1a;
  --agent: #0063d1;     --agent-soft: #e3eefd;
  --ok: #1f7a45;        --ok-soft: #e2f2e8;
  --warn: #9a5b00;      --warn-soft: #fbeed5;
  --danger: #b42a20;    --danger-soft: #fbe4e1;
  --e1: 0 1px 1px #1717160a, 0 2px 4px -1px #1717160d, 0 0 0 1px var(--line);
  --e2: 0 1px 1px #1717160a, 0 6px 16px -4px #1717161a, 0 0 0 1px var(--line);
  --e3: 0 2px 4px #1717160a, 0 24px 56px -16px #1717164d, 0 0 0 1px var(--line2);
  --top: inset 0 1px 0 #ffffffe6;
}
[data-theme="dark"] {
  --bg: #0f0f0e;        --raised: #1c1c1b;    --sunken: #0a0a09;
  --ink: #efefec;       --ink2: #d6d6d2;      --muted: #a3a39e;
  --line: #ffffff1a;    --line2: #ffffff26;
  --agent: #5aa8ff;     --agent-soft: #11253f;
  --ok: #5fc48a;        --ok-soft: #13291c;
  --warn: #e0a84a;      --warn-soft: #33260e;
  --danger: #f08a80;    --danger-soft: #3a1714;
  --e1: 0 1px 2px #00000080, 0 0 0 1px var(--line);
  --e2: 0 8px 20px -6px #0009, 0 0 0 1px var(--line);
  --e3: 0 28px 64px -16px #000c, 0 0 0 1px var(--line2);
  --top: inset 0 1px 0 #ffffff14;
}
```

- **Tipografia:** Onest (corpo e interface), Funnel Display (títulos e números de KPI), Martian
  Mono (ids, logs, nomes de métrica, versões). Escala: 32 display, 28 título de aba, 20, 17 seção,
  14,5 corpo (altura de linha 1,5), 13, 12 rótulo. Nada abaixo de 12.
- **Espaço:** 4, 8, 12, 16, 24, 32. Gutter de página 32 (16 no celular), 16 entre cards, 24 entre
  seções.
- **Raio:** 6 pequeno, 10 item e campo, 12 botão, 14 card, 20 seção grande, 999 chip.
- **Elevação:** `e1` card, `e2` hover, `e3` modal. A borda é o anel de 1 px dentro da sombra, não
  `border`.

Componente nenhum usa hex direto; tudo sai dos tokens.

## Componentes

- **Botão:** altura mínima 40 px, raio 12. Variantes primário (`--ink`), secundário
  (`--plate`), destrutivo (`--danger-soft`), desabilitado (opacidade 0,45). Ação destrutiva pede
  confirmação.
- **Chip de estado:** fundo `*-soft`, texto na cor do estado, sempre com palavra.
- **Campo:** rótulo visível acima, ajuda abaixo, erro junto do campo com `aria-invalid` e
  `aria-describedby`. Foco: anel `--ink`. Secret aparece como máscara e só pode ser substituído.
- **Card:** `--raised`, raio 14, `e1` + `--top`.
- **Tabela:** dentro de caixa com rolagem horizontal; cabeçalho em rótulo 12; linhas separadas
  por `--line`.
- **Navegação:** sidebar de 248 px com grupos Bot, Administração e Extensões. Item ativo em
  `--raised` com `aria-current="page"`. No celular, ver [Mobile](#mobile).

## Mobile

Abaixo de 768 px a sidebar sai e entra a barra inferior (TabBar).

- **Navegação:** barra inferior com 5 destinos fixos (Início, Métricas, Plugins, Config, Mais),
  com ícone e texto. As abas de plugins nunca entram na barra: ficam em **Mais**, numa lista sem
  limite de tamanho. Uma aba de plugin abre com "voltar para Mais" no topo, e Mais continua
  marcado na barra.
- **Sessão** vira um seletor compacto no cabeçalho do Início.
- **Tabela vira lista:** uma linha por item, com o campo principal em cima e os secundários em
  mono 11 embaixo. Vale para o widget `table` de plugin, que o dashboard converte sozinho.
- **Grades:** KPIs em 2 colunas, `stats` de plugin em até 3; o resto em 1 coluna.
- **Config:** a lista de plugins vira um `select` acima do formulário. Salvar e Descartar ficam
  numa barra fixa acima da TabBar.
- **Alvos de 44 px** (40 px no desktop), campos com fonte de 16 px (evita o zoom do iOS),
  `inputmode` nos campos numéricos, `env(safe-area-inset-bottom)` na barra inferior.
- **QR** cresce para 200 px, e o código de pareamento ganha botão Copiar.

Acessibilidade mínima: contraste 4,5:1, foco visível, alvo de 40 px ou mais, botão de ícone com
`aria-label`, gráfico com `role="img"` e rótulo, `prefers-reduced-motion` respeitado, nada que só
funcione no hover.

## Sistema: extensão por abas

O dashboard é fechado para modificação e aberto para extensão: outro plugin acrescenta uma aba
sem tocar no código do dashboard, pelo ponto de extensão `dashboard.tabs` (ADR 0096). As abas do
próprio dashboard (Visão geral, Métricas, Plugins, Configuração) são as únicas que ele desenha à
mão; as de plugins entram no grupo Extensões da sidebar.

```text
plugin reminders ──contribute('dashboard.tabs', tab)──▶ registry (atribui ao plugin)
                                                             │ extensionPoint().list()
browser ──HTTP/WS (sessão do dashboard)──▶ plugin-dashboard ─┘
          GET  /plugins/dashboard/api/tabs                       manifesto, sem funções
          GET  /plugins/dashboard/api/tabs/:tab/:widget          roda o load do widget
          POST /plugins/dashboard/api/tabs/:tab/:widget/:action  roda a ação ou o submit
          WS   /plugins/dashboard/ws                             status, QR, logs, tabs.changed
```

O contrato, a ser fechado num ADR antes da implementação:

```ts
declare module '@usebridger/core' {
  interface ExtensionPoints {
    'dashboard.tabs': DashboardTab;
  }
}

interface DashboardTab {
  id: string; // único entre as abas; vira a URL da aba
  title: string;
  order?: number;
  widgets: DashboardWidget[];
}

type DashboardWidget =
  | { kind: 'stats'; id: string; load(): Promise<{ label: string; value: string | number }[]> }
  | { kind: 'table'; id: string; columns: string[]; load(q: { cursor?: string }): Promise<TablePage>;
      actions?: { id: string; label: string; confirm?: boolean; run(i: { row: Row }): Promise<void> }[] }
  | { kind: 'series'; id: string; load(q: { days: number }): Promise<{ day: string; value: number }[]> }
  | { kind: 'form'; id: string; schema: z.ZodType; submit(input: unknown): Promise<void> }
  | { kind: 'log'; id: string; source: string } // filtra o mesmo fluxo de logs do WS
  | { kind: 'text'; id: string; markdown: string };
```

- **Dados declarativos, desenho do dashboard.** O plugin só devolve dados; o dashboard renderiza
  com os componentes deste guia. O `form` reaproveita o gerador de formulários do Zod da config
  (M5-4.2), com o mesmo mascaramento de secret.
- **Uma porta só.** `load`, `run` e `submit` rodam no servidor, chamados pelas rotas do
  dashboard, atrás da autenticação dele. O plugin que contribui não abre rota pública para a aba.
- **Ciclo de vida de graça.** Reload, disable ou falha do contribuidor tira a aba (ADR 0096). O
  dashboard lê `list()` a cada pedido e avisa o browser com `tabs.changed` no WebSocket.
- **Erro tem destino.** `load` que lança mostra o erro dentro do widget e segue para
  `plugin.error` (fase `http`); as outras abas e widgets continuam.
- **Métricas não precisam de aba.** Métrica registrada no serviço `metrics` já aparece na seção
  genérica (ADR 0107). Aba é para o que não é métrica: listas, ações, formulários.

Questões abertas, para o ADR:

1. **Dono da contribuição.** `extensionPoint().list()` devolve só as contribuições, sem o plugin
   que contribuiu. O dashboard precisa dele para o rótulo "contribuída por" e para o `plugin.error`.
   É lacuna do core: uma leitura que devolva o dono junto, ou um campo `plugin` declarado na aba.
2. **`id` repetido entre plugins:** prefixar com o dono (depende do item 1) ou a primeira vence,
   com `warn`.
3. **Escape hatch para UI própria** (web component servido pelo plugin): fora agora; entra se
   algum caso não couber nos widgets.
