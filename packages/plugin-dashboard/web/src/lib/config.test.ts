import { describe, expect, it } from 'vitest';
import { buildOverrides, configUi, fieldErrors, formSchema, MASK } from './config.ts';

describe('buildOverrides', () => {
  const view = {
    config: { model: 'gpt-4o', temperature: 0.5, openai: { apiKey: MASK }, list: ['a'] },
    messages: { greeting: 'Oi' },
    sources: {
      model: 'default',
      temperature: 'override',
      'openai.apiKey': 'override',
      list: 'file',
      'messages.greeting': 'override',
    },
  };

  it('manda o que mudou e os overrides que já existiam, sem a máscara do segredo', () => {
    const edited = { ...view.config, model: 'gpt-5' };
    expect(buildOverrides(view, edited)).toEqual({
      model: 'gpt-5',
      temperature: 0.5,
      messages: { greeting: 'Oi' },
    });
  });

  it('segredo com valor novo vai no corpo', () => {
    const edited = { ...view.config, openai: { apiKey: 'sk-novo' } };
    expect(buildOverrides(view, edited)).toMatchObject({ openai: { apiKey: 'sk-novo' } });
  });

  it('campo esvaziado sai do corpo: volta o default', () => {
    const { temperature, ...edited } = view.config;
    expect(buildOverrides(view, edited)).not.toHaveProperty('temperature');
  });

  it('array é folha: a lista inteira vai quando muda', () => {
    expect(buildOverrides(view, { ...view.config, list: ['a', 'b'] })).toMatchObject({
      list: ['a', 'b'],
    });
  });

  it('record: override numa chave filha mantém o campo', () => {
    const records = {
      config: { extra: { a: 1 } },
      messages: {},
      sources: { 'extra.a': 'override' },
    };
    expect(buildOverrides(records, records.config)).toEqual({ extra: { a: 1 } });
  });
});

describe('formSchema e configUi', () => {
  const schema = {
    type: 'object',
    properties: {
      token: { type: 'string', minLength: 16, secret: true, writeOnly: true },
      nested: { type: 'object', properties: { port: { type: 'integer' } } },
    },
  };

  it('segredo perde as regras de formato (a máscara não passaria)', () => {
    const out = formSchema(schema) as { properties: { token: Record<string, unknown> } };
    expect(out.properties.token).toEqual({ type: 'string', secret: true, writeOnly: true });
  });

  it('segredo vira senha; campo do env fica só leitura com a origem', () => {
    expect(configUi(schema, { 'nested.port': 'env' })).toEqual({
      token: { 'ui:widget': 'password' },
      nested: {
        port: {
          'ui:readonly': true,
          'ui:help': 'Definido no ambiente: o valor do painel não tem efeito.',
        },
      },
    });
  });
});

it('fieldErrors aninha os caminhos pontilhados no formato do rjsf', () => {
  expect(
    fieldErrors([
      { path: 'openai.apiKey', message: 'curta' },
      { path: 'openai.apiKey', message: 'inválida' },
      { path: 'model', message: 'vazio' },
    ]),
  ).toEqual({
    openai: { apiKey: { __errors: ['curta', 'inválida'] } },
    model: { __errors: ['vazio'] },
  });
});
