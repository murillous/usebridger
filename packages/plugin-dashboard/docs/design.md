# Design do `plugin-dashboard`

Guia de design do app web do `@usebridger/plugin-dashboard`. Quem mexer na interface segue este
documento. Decisões de base: [ADR 0019](../../../docs/adr/0019-dashboard-vira-plugin.md),
[ADR 0103](../../../docs/adr/0103-plugins-oficiais-de-metricas-e-dashboard.md) e
[ADR 0125](../../../docs/adr/0125-api-http-do-core-e-dashboard-cliente.md).

O canvas da M5 (**https://claude.ai/artifact/9mHnZZqd33jPZ1Mn7vERy7**) segue valendo para tokens e
componentes. As telas dele descrevem o app antigo (abas por `dashboard.tabs`, Visão geral); o app
da M7-10 tem as telas listadas na [documentação](README.md#telas).

## Princípios

- **A ação é a tinta.** Botão primário e item ativo usam `--ink`; não há cor de marca. A cor só
  carrega significado: azul (`--agent`) para informação e link; verde, âmbar e vermelho para
  estado.
- **Cor nunca sozinha.** Todo estado tem texto ("Conectado", "Erro fatal"), e todo gráfico tem
  rótulo acessível.
- **Denso e calmo.** Painel de operação: muita informação por tela, pouco ornamento. Sem
  gradiente, sem emoji, sem borda lateral colorida em card.
- **"Ao vivo" só quando é.** O selo do cabeçalho diz "ao vivo" com o stream SSE no ar e
  "reconectando" quando ele cai.
- **Recurso de plugin parece do core.** O plugin descreve dados e ações (`api.resources`); o
  dashboard desenha com os próprios componentes. Um recurso novo não precisa de CSS nem de build.


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
- **Navegação:** sidebar de 248 px com grupos Bot, Administração, Conta e Recursos de plugins.
  Item ativo em `--raised` com `aria-current="page"`. No celular, ver [Mobile](#mobile).
- **Formulário gerado:** o tema padrão do `@rjsf` com os ajustes de `.schema-form` em
  `styles.css` (campo, ajuda e erro com os mesmos tokens do `.field`).


## Mobile

Abaixo de 768 px a sidebar vira uma gaveta, aberta pelo botão Menu da barra do topo, e fecha ao
navegar. Os campos de texto sobem para 16 px (o iOS não dá zoom), as tabelas rolam dentro do card
e os filtros quebram em linhas.
