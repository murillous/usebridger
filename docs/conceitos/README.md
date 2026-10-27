# Conceitos

Como o Bridger funciona e por que ele é assim. Os guias dizem **como fazer**; estas páginas
explicam **o modelo** por trás, em texto corrido, destilando as [decisões de arquitetura](../adr/README.md)
(ADRs). Cada página aponta para os ADRs de onde saiu, para quem quiser o registro completo com as
alternativas descartadas.

| Página | Assunto |
| --- | --- |
| [Visão geral](visao-geral.md) | Framework, quem chama quem, o que é core e o que é plugin, plataformas e estabilidade antes do 1.0 |
| [Bot e sessão](bot-e-sessao.md) | As peças do `createBot`, pareamento, quedas, vários bots, SQLite ou Postgres, HTTP |
| [O caminho da mensagem](mensagem.md) | Filas, prazos, cancelamento, conversa de vários passos e fila de saída |
| [Plugins](plugins.md) | Manifesto e `setup`, capabilities, plugins que usam e estendem outros, dados, mídia e escape hatch |
| [Distribuindo plugins](distribuicao.md) | Repositório próprio, npm, versão em relação ao core e `pluginDirs` |
| [Configuração](configuracao.md) | Camadas, precedência, segredos, textos e config inválida |
| [Testes](testes.md) | Testar sem rede, em vários perfis de plataforma, conversas, agendamentos e falhas |
| [Operação](operacao.md) | Tabela de boot, fila de saída em produção, métricas e migração |
| [Contribuindo](contribuindo.md) | Propor uma mudança no core e escrever um transport |
| [Perguntas frequentes](perguntas.md) | Índice de perguntas, cada uma apontando para a resposta |
