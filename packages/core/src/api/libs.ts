// `zod` e `zod-openapi` carregam sob demanda: importá-los no topo registra globais do Zod e
// quebraria a garantia de que importar `@usebridger/core` não tem side effect. Quem precisa
// (a abertura da porta, `createOpenApiDocument`) espera `loadApiLibs()` antes.

interface ApiLibs {
  readonly z: typeof import('zod').z;
  readonly createDocument: typeof import('zod-openapi').createDocument;
}

let loaded: ApiLibs | undefined;

export async function loadApiLibs(): Promise<void> {
  if (loaded !== undefined) return;
  const [{ z }, { createDocument }] = await Promise.all([import('zod'), import('zod-openapi')]);
  loaded = { z, createDocument };
}

export function apiLibs(): ApiLibs {
  if (loaded === undefined) throw new Error('api: chame loadApiLibs() antes de montar schemas');
  return loaded;
}
