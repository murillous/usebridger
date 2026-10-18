# Design do `plugin-dashboard`

Guia de design e de sistema do `@usebridger/plugin-dashboard` (M5-4, #151). Quem mexer na
interface ou criar uma aba nova segue este documento e o canvas. Decisões de base:
[ADR 0021](../../../docs/adr/0021-dashboard-vira-plugin.md),
[ADR 0076](../../../docs/adr/0076-http-do-core.md),
[ADR 0096](../../../docs/adr/0096-pontos-de-extensao-em-servicos.md) e
[ADR 0107](../../../docs/adr/0107-plugins-oficiais-de-metricas-e-dashboard.md).

## Canvas

**https://claude.ai/artifact/9mHnZZqd33jPZ1Mn7vERy7**

O canvas é a fonte visual, aberto a quem tiver o link. Quadros:

| Quadro | O que mostra |
| --- | --- |
| Visão geral | Status por bot/transport (QR e código só no WhatsApp, erro `fatal` nos de token), KPIs do dia, logs recentes |
| Métricas | Painéis fixos do kernel e a seção genérica com toda métrica registrada no serviço `metrics` |
| Plugins | Tabela de boot (nome e versão, estado, setup, depende de, provê, contribui), busca, painel de erro do setup e toggle de ativo; no mobile, filtros, card de problema e lista com toggle |
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
- **Config:** a lista de plugins vira um `select` ("ai · 1 erro") acima do formulário. A barra
  de salvar fica dentro do card e, no mobile, fixa acima da TabBar (rola com o card, sem
  tapar o formulário). Campos numéricos consecutivos ficam lado a lado no desktop (grade de 2
  colunas) e empilham no mobile.
- **Config, regras da tela:** cabeçalho `bridger.config.json · plugins.<id>`; badge "N erros"
  (config atual inválida, lida do GET de cada plugin) ou "falhou" (setup falhou) na lista;
  secret só leitura com chips `secret`/origem e o nome real da variável (`BRIDGER_<PLUGIN>__<CAMPO>`);
  dica de tipo do schema sob cada campo; "Salvar recarrega X e N dependente(s)" calculado do
  `dependsOn` dos plugins (limite: dependentes por `optionalDependsOn`, que o core também recarrega, não entram na contagem, porque a linha do plugin não os expõe). Não há botão "Substituir" no secret: o PUT recusa secret (ADR 0111).
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

O contrato está no [ADR 0108](../../../docs/adr/0108-abas-do-dashboard-por-ponto-de-extensao.md).
O resumo para quem desenha ou implementa:

```text
plugin reminders ──contribute('dashboard.tabs', tab)──▶ registry (guarda o dono)
                                                             │ extensionPoint().entries()
browser ──HTTP (autenticação do dashboard)──▶ plugin-dashboard ─┘
          GET  /plugins/dashboard/api/tabs                                   manifesto, sem funções
          GET  /plugins/dashboard/api/tabs/:plugin/:tab/:widget              roda o load
          POST /plugins/dashboard/api/tabs/:plugin/:tab/:widget/actions/:id  roda a ação da tabela
          POST /plugins/dashboard/api/tabs/:plugin/:tab/:widget/submit       valida e roda o submit
```

- **Widgets:** `stats`, `table` (com ações por linha), `series`, `form` (schema Zod) e `text`. O
  plugin só devolve dados; o dashboard desenha com os componentes deste guia, inclusive no celular.
  O `form` usa o mesmo gerador da config (M5-4.2), com o mesmo mascaramento de secret.
- **Chave `<plugin>/<id>`:** o dono vem do registry, não da aba.
- **Ciclo de vida de graça:** reload, disable ou falha de quem contribuiu tira a aba (ADR 0096). Aba
  que sumiu responde 404 e mostra "aba não está mais disponível".
- **Erro por widget:** `load`, `run` ou `submit` que falha mostra o erro só naquele widget; `submit`
  inválido mostra as issues do Zod junto dos campos.
- **Métricas não precisam de aba.** Métrica registrada no serviço `metrics` já aparece na seção
  genérica (ADR 0107). Aba é para o que não é métrica: listas, ações, formulários.

## Métricas e abas de plugin: diferenças aceitas do canvas

Conferidas na M5-4.8 (#180). O canvas é ilustrativo; o que o contrato ou o core não sustenta fica de fora:

- **Painel "Fila de saída"**: lê `bridger.outbound.pending`, histograma de itens pendentes amostrado a cada envio (p95 do dia). "Envios por dia" deixou de ter painel; a métrica `bridger.outbound.sent` segue na tabela.
- **Coluna "Plugin" da tabela de métricas**: vem de `metrics.ownerOf(nome)`. O serviço é um objeto só e não sabe quem chama, então o plugin dono se declara com `declareOwner`; as métricas do kernel saem como `core` e as não declaradas, como `-`. A contagem de séries fica no texto, ao lado do nome.
- **Latência em ms**: a métrica real é `bridger.messages.handle_duration_ms`, o canvas mostra `_seconds`.
- **Título e etiqueta de widget** ("Próximos", "widget: table + action"): o contrato `dashboard.tabs` (ADR 0108) só tem título em `series`; as etiquetas são anotação do canvas.
- **Cor de tom em `stats`** ("Atrasados" em âmbar) e **rótulo do botão do form** ("Agendar"): o contrato não tem os campos; o botão é "Enviar".
- **Painel "Como o plugin declara esta aba"**: documentação do canvas, não faz parte do app.

## Visão geral: o que o core ainda não expõe

O card do bot mostra só o que o status de conexão traz (transport, sessão, estado, QR, código de
pareamento, motivo do erro). "No ar desde", reconexões, validade do QR ("Expira em") não saem do core hoje.
Os 5 KPIs de "Hoje" incluem "Fila de saída (p95)", de `bridger.outbound.pending`.
