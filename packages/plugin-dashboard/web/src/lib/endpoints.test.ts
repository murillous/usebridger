import { describe, expect, it } from 'vitest';
import { endpoints } from './endpoints.ts';

describe('endpoints', () => {
  it('sessão default: API em /api e spec na raiz', () => {
    expect(endpoints('http://h:3000/plugins/dashboard/')).toEqual({
      base: 'http://h:3000',
      api: 'http://h:3000/api',
      apiPath: '/api',
      spec: 'http://h:3000/openapi.json',
    });
  });

  it('outra sessão: API sob /sessions/<s>, spec segue na raiz', () => {
    expect(endpoints('http://h/sessions/erp/plugins/dashboard/')).toEqual({
      base: 'http://h/sessions/erp',
      api: 'http://h/sessions/erp/api',
      apiPath: '/sessions/erp/api',
      spec: 'http://h/openapi.json',
    });
  });

  it('proxy com prefixo: o prefixo vale para a API e para a spec', () => {
    const result = endpoints('https://h/bot/plugins/dashboard/');
    expect(result.api).toBe('https://h/bot/api');
    expect(result.apiPath).toBe('/api');
    expect(result.spec).toBe('https://h/bot/openapi.json');
  });
});
