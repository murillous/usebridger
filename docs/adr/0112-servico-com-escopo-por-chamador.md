# ADR 0112 — Serviço com escopo por quem chama

**Status:** Aceito (2026-10-17) · Detalha **D16** ([ADR 0016](0016-service-registry.md)) e
[ADR 0092](0092-pontos-de-extensao-em-servicos.md)

## Contexto

O serviço `metrics` é um objeto só para todos os plugins, então não sabe quem grava cada métrica.
A tela Métricas do dashboard precisa mostrar o plugin dono (M5-4.8, #180). Pedir que cada plugin se
declare dono é opt-in: quem esquece fica sem dono, e o nome do plugin é dado que o core já tem.

## Decisão

- **`ServiceAccess.provideScoped(name, factory, release?)`:** publica o serviço como `provide`
  (mesmo conflito de nome, mesma regra de reload), mas o `get` do `forPlugin(plugin)` chama
  `factory(plugin)` na primeira vez e guarda a instância por `(name, caller)`. O tipo de quem
  consome não muda (`Services[K]`).
- **Limpeza:** `removePlugin(caller)` descarta a instância do caller e chama `release(caller)`;
  `removePlugin(provedor)` descarta todas as instâncias, chama `release` de cada uma e remove o
  serviço. A limpeza do registry termina antes de qualquer `release`; um `release` que lança não
  impede os outros e o `removePlugin` relança os erros como `AggregateError`. O `dispose` do
  contexto roda todos os passos de limpeza mesmo assim e relança junto no fim.
- **Contexto descartado:** como `provide`, `provideScoped` é recusado depois do teardown.
- **plugin-metrics:** o serviço grava o dono (o `caller`) na primeira escrita que dá certo e
  limpa o dono no `release`. O que o próprio plugin-metrics grava (observadores do kernel) fica
  com o dono `core`, de propósito, para a tela separar kernel de plugin. Substitui o
  `declareOwner` opt-in da primeira versão da PR.

## Consequências

- Mudança aditiva no core (minor): serviços existentes seguem com `provide`.
- A instância por caller é criada preguiçosamente; `get` repetido devolve a mesma.
- `list()` e `describe()` do registry continuam listando o serviço pelo provedor.
