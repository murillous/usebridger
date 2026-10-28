// O plugin injeta `<base href>` com o `basePath` dele: `<raiz>/plugins/dashboard/` na sessão
// `default`, `<raiz>/sessions/<s>/plugins/dashboard/` nas outras. Daí saem a API da sessão e a spec,
// que é uma só para o processo, na raiz do servidor. `<raiz>` cobre um proxy que publica sob prefixo.

export interface Endpoints {
  /** Base do cliente tipado: os caminhos da spec (`/api/...`) vão depois dela. */
  readonly base: string;
  /** Base da API da sessão, sem barra final (`http://h/api`, `http://h/sessions/erp/api`). */
  readonly api: string;
  /** Caminho da API na spec (`/api`, `/sessions/erp/api`): filtra as rotas desta sessão. */
  readonly apiPath: string;
  /** `GET /openapi.json` do servidor. */
  readonly spec: string;
}

export function endpoints(baseURI: string = document.baseURI): Endpoints {
  const url = new URL(baseURI);
  const match = /^(.*?)\/(sessions\/[^/]+\/)?plugins\/dashboard\/?$/.exec(url.pathname);
  const root = match?.[1] ?? '';
  const session = match?.[2] ? `/${match[2].slice(0, -1)}` : '';
  return {
    base: `${url.origin}${root}${session}`,
    api: `${url.origin}${root}${session}/api`,
    apiPath: `${session}/api`,
    spec: `${url.origin}${root}/openapi.json`,
  };
}
