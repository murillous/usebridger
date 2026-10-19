# ADR 0114 — Título, tom e rótulo de envio nos widgets das abas

**Status:** Aceito (2026-10-18) · Complementa **D104**
([ADR 0104](0104-abas-do-dashboard-por-ponto-de-extensao.md)) e **D109**
([ADR 0109](0109-contrato-das-abas-do-dashboard-complemento.md))

## Contexto

A conferência do canvas na M5-4.8 (#180, #189) achou três coisas que o contrato de `dashboard.tabs`
não permite desenhar na aba Lembretes:

- **Título por widget:** o canvas mostra "Próximos" sobre a tabela e "Novo lembrete global" sobre o
  formulário. Só `series` tem `title` (D109).
- **Tom em `stats`:** "Atrasados" aparece em âmbar. `StatItem` só tem `label`, `value` e `hint`.
- **Rótulo do envio do `form`:** o canvas mostra "Agendar"; o app mostra sempre "Enviar".

Alternativas consideradas:

- **Cor livre no `stats`** (`color: '#d08700'`). Quebra o tema escuro e deixa o plugin escolher
  fora dos tokens do painel, contra o "desenho do dashboard" do D104.
- **Título como widget `text` antes do widget.** Já funciona, mas sai como parágrafo, não como
  título do cartão, e não serve de rótulo acessível.

## Decisão

- **`title?` em todo widget.** O campo sai de `series` e passa à base comum (`id`, `title?`). O
  dashboard desenha um `<h2>` sobre o widget (logo abaixo do `<h1>` da aba) e usa o título como
  `aria-label` da seção (sem ele, ou vazio, o `id`). A `series` segue com o título dentro do cartão, junto do seletor, e com o fallback "Série".
- **`tone?` em `StatItem`:** `'ok' | 'warn' | 'danger'`, mapeado para os tokens `--ok`, `--warn` e
  `--danger` no valor do cartão. Sem ele, cor neutra.
- **`submitLabel?` no `form`:** texto do botão de envio. Sem ele, "Enviar".
- **Defensivo como o D109:** `title` ou `submitLabel` que não é string some do manifesto. `tone`
  desconhecido some do item, mas o item fica: um plugin feito para um dashboard mais novo, com um
  tom a mais, não perde o número.

## Consequências

- Os três campos são opcionais: minor do `plugin-dashboard`, e quem já contribui não muda nada.
- Dashboard antigo ignora os campos novos; o plugin que os usa só perde o visual.
- O conjunto de tons vira contrato: tirar um é major, acrescentar é minor.
