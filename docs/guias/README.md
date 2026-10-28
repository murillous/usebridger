# Guias do autor de plugin

Como escrever um plugin do Bridger sem ler o código interno do core. Comece pelo primeiro
plugin; os outros guias vão por assunto e apontam para a documentação de cada módulo do core
quando o detalhe importa.

| Guia | Assunto |
| --- | --- |
| [Seu primeiro plugin em 5 minutos](primeiro-plugin.md) | Do `create-bridger-plugin` ao plugin respondendo no bot |
| [Comandos](comandos.md) | `command()`, args, aliases, `role` e respostas |
| [Eventos e mídia](eventos-e-midia.md) | Reagir a eventos e ler ou enviar mídia |
| [Storage](storage.md) | KV e coleções do plugin |
| [Config](config.md) | Schema Zod, segredos, mensagens e reload |
| [Services](services.md) | Oferecer e consumir services entre plugins |
| [Scheduler](scheduler.md) | Tarefas agendadas que sobrevivem a restart |
| [Capabilities](capabilities.md) | O que cada transport suporta, com matriz por transport |
| [Portabilidade entre plataformas](portabilidade.md) | Formatação neutra, IDs e owners, botões, resposta esperada, tenant |
| [Escape hatch](escape-hatch.md) | Objeto bruto da mensagem e do transport |
| [Testes](testes.md) | `@usebridger/testing` e os perfis de transport |

## Outras referências

- **Referência da API**: `pnpm run docs` gera no site (seção Referência → API), com cada entrada pública (`@usebridger/core`, `@usebridger/core/adapter`, …) e os comentários do código.
- **Documentação do core** (como cada módulo funciona): [`packages/core/docs/`](../../packages/core/docs/README.md).
- **Como o Bridger funciona e por quê**: [Conceitos](../conceitos/README.md), com as
  [perguntas frequentes](../conceitos/perguntas.md).
