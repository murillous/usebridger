import { envName as coreEnvName, toEnvSegment } from '@usebridger/core';
import { describe, expect, it } from 'vitest';
import { buildFields, configPluginOf, envName, isoToLocal, leaves, localToIso } from './schema.ts';

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
    // Segundos diferentes de zero sobrevivem à ida e volta.
    const withSeconds = '2026-03-04T05:06:07.000Z';
    expect(isoToLocal(withSeconds)).toMatch(/:07$/);
    expect(localToIso(isoToLocal(withSeconds))).toBe(withSeconds);
    expect(isoToLocal(undefined)).toBe('');
    expect(isoToLocal('lixo')).toBe('');
    expect(localToIso('')).toBeUndefined();
  });
});

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

describe('configPluginOf', () => {
  it('lê o plugin do hash', () => {
    expect(configPluginOf('config/foo')).toBe('foo');
    expect(configPluginOf('config/a%20b')).toBe('a b');
    expect(configPluginOf('plugins')).toBeUndefined();
  });
  it('vazio ou malformado vira ausente', () => {
    expect(configPluginOf('config/')).toBeUndefined();
    expect(configPluginOf('config/%E0%A4%A')).toBeUndefined();
  });
});
