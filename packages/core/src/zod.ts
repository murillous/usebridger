// Entry do subpath `@usebridger/core/zod`: o Zod que o core usa, para o schema da config do
// plugin sair da mesma cópia que o `definePlugin` tipa (ADR 0091). Fica fora do
// `@usebridger/core` porque carregar o Zod cria um global (`__zod_globalRegistry`), e importar o
// core não pode ter side effect (ADR 0003): só paga quem importa este subpath.
export { z } from 'zod';
