import type { DataProvider } from '@refinedev/core';
import createClient from 'openapi-fetch';
import type { paths } from '../api-live.d.ts';

const api = createClient<paths>({ baseUrl: '/api' });

// O dashboard genérico não conhece os recursos em tempo de compilação: os de plugin chegam pela
// spec em runtime. Então o provider fala com caminhos dinâmicos e a tipagem forte fica só nas
// telas fixas do core (que usam `api` direto).
// biome-ignore lint: protótipo
const raw = api as any;

export const dataProvider: DataProvider = {
  getApiUrl: () => '/api',
  async getList({ resource, filters }) {
    const query = Object.fromEntries((filters ?? []).flatMap((f) => ('field' in f && f.value !== undefined && f.value !== '' ? [[f.field, String(f.value)]] : [])));
    const { data, error } = await raw.GET(`/${resource}`, { params: { query } });
    if (error) throw error;
    return { data: data.items, total: data.total };
  },
  async getOne({ resource, id }) {
    const { data, error } = await raw.GET(`/${resource}/{id}`.replace('{id}', String(id)));
    if (error) throw error;
    return { data };
  },
  async update({ resource, id, variables }) {
    const { data, error } = await raw.PATCH(`/${resource}/${id}`, { body: variables });
    if (error) throw error;
    return { data };
  },
  create: () => Promise.reject(new Error('não usado')),
  deleteOne: () => Promise.reject(new Error('não usado')),
};
