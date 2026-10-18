import { describe, expect, it } from 'vitest';
import { buildFields, envName, isoToLocal, leaves, localToIso } from './schema.ts';

const one = (prop: Record<string, unknown>) =>
  leaves(buildFields({ type: 'object', properties: { apiKey: prop } }))[0];

describe('rótulo do campo', () => {
  it('prefere title, depois description, depois o nome com inicial maiúscula', () => {
    expect(one({ type: 'string', title: 'Chave', description: 'd' })?.label).toBe('Chave');
    const byDesc = one({ type: 'string', description: 'Chave da API' });
    expect(byDesc?.label).toBe('Chave da API');
    // A descrição que virou rótulo não repete como ajuda.
    expect(byDesc?.description).toBeUndefined();
    expect(one({ type: 'string' })?.label).toBe('ApiKey');
  });
  it('title mantém a descrição como ajuda', () => {
    expect(one({ type: 'string', title: 'T', description: 'd' })?.description).toBe('d');
  });
});

describe('placeholder e data/hora', () => {
  it('placeholder vem de examples[0]', () => {
    expect(one({ type: 'string', examples: ['sk-...'] })?.placeholder).toBe('sk-...');
    expect(one({ type: 'number', examples: [3] })?.placeholder).toBe('3');
    expect(one({ type: 'string' })?.placeholder).toBeUndefined();
  });
  it('format date-time vira o controle datetime', () => {
    expect(one({ type: 'string', format: 'date-time' })?.control).toBe('datetime');
    expect(one({ type: 'string', format: 'email' })?.control).toBe('text');
  });
  it('converte entre datetime-local e ISO', () => {
    const iso = '2026-03-04T05:06:00.000Z';
    expect(localToIso(isoToLocal(iso))).toBe(iso);
    expect(isoToLocal(undefined)).toBe('');
    expect(isoToLocal('lixo')).toBe('');
    expect(localToIso('')).toBeUndefined();
  });
});

// O core não exporta `envName` no pacote público e o Biome barra `../`: o módulo entra por URL.
// Se o core mover o arquivo, este import falha e o teste avisa em vez de passar calado.
const core = (await import(
  /* @vite-ignore */ new URL('../../../../core/src/config/env.ts', import.meta.url).href
)) as {
  envName: (plugin: string, path: string[]) => string;
  toEnvSegment: (name: string) => string;
};
const { envName: coreEnvName, toEnvSegment } = core;

describe('envName do web = envName do core', () => {
  const cases: [string, string][] = [
    ['plugin', 'apiKey'],
    ['user-names', 'apiKey'],
    ['openAI', 'openAIKey'],
    ['a', 'openai.model'],
    ['my-plugin', 'a-b.cD.HTTPServer'],
    ['x', 'abc123Def'],
  ];
  it.each(cases)('%s / %s', (plugin, path) => {
    expect(envName(plugin, path)).toBe(coreEnvName(plugin, path.split('.')));
  });
  it('segmento do core bate com o nome', () => {
    expect(toEnvSegment('apiKey')).toBe('API_KEY');
  });
});
