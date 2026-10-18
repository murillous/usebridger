---
"@usebridger/core": minor
---

`ctx.services.provideScoped(nome, factory, release?)`: serviço com instância por plugin que chama (ADR 0116). A fábrica recebe o nome do caller, a instância é guardada por `(nome, caller)` e é descartada, com `release`, quando o caller ou o provedor saem. Um `release` que lança não interrompe a limpeza: o registry e o `dispose` terminam tudo e relançam `AggregateError`. Quebra de tipo: `provideScoped` é método obrigatório em `ServiceAccess`, então quem implementa essa interface (fakes e wrappers de teste) precisa acrescentá-lo.
