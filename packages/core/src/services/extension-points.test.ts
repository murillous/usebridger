// Pontos de extensão no registry (#83, ADR 0096): a contribuição é atribuída a quem contribuiu e
// sai com ele, sem o serviço que oferece o ponto cuidar disso.

import { describe, expect, it } from 'vitest';
import { createServiceRegistry } from '#services/registry.ts';

type Step = (input: string) => string;

// Nomes só destes testes; em runtime o registry não conhece tipos.
declare module '@usebridger/core' {
  interface ExtensionPoints {
    'test.steps': Step;
    'test.tags': string;
  }
}

describe('pontos de extensão do registry', () => {
  it('list devolve as contribuições de todos os plugins; ponto sem contribuição é lista vazia', () => {
    const registry = createServiceRegistry();
    const steps = registry.forPlugin('sticker').extensionPoint('test.steps');
    expect(steps.list()).toEqual([]);

    const caption: Step = (s) => `${s}+legenda`;
    registry.forPlugin('sticker-text').contribute('test.steps', caption);

    // A visão é viva: pega a contribuição feita depois de obtida.
    expect(steps.list()).toEqual([caption]);
  });

  it('contribuir não exige que alguém já tenha pedido o ponto', () => {
    const registry = createServiceRegistry();
    registry.forPlugin('a').contribute('test.tags', 'x');
    expect(registry.forPlugin('b').extensionPoint('test.tags').list()).toEqual(['x']);
  });

  it('removePlugin tira só as contribuições do plugin, em todos os pontos', () => {
    const registry = createServiceRegistry();
    registry.forPlugin('a').contribute('test.tags', 'a1');
    registry.forPlugin('a').contribute('test.steps', (s) => s);
    registry.forPlugin('b').contribute('test.tags', 'b1');

    registry.removePlugin('a');

    const access = registry.forPlugin('x');
    expect(access.extensionPoint('test.tags').list()).toEqual(['b1']);
    expect(access.extensionPoint('test.steps').list()).toEqual([]);
  });

  it('o reload (remove + contribui de novo) não duplica e volta à posição de antes', () => {
    const registry = createServiceRegistry();
    registry.forPlugin('a').contribute('test.tags', 'a');
    registry.forPlugin('b').contribute('test.tags', 'b');
    registry.forPlugin('c').contribute('test.tags', 'c');

    registry.removePlugin('a');
    registry.forPlugin('a').contribute('test.tags', 'a2');

    expect(registry.forPlugin('x').extensionPoint('test.tags').list()).toEqual(['a2', 'b', 'c']);
  });

  it('ordena pela ordem de carga informada; no mesmo plugin, pela ordem do contribute', () => {
    const order = ['c', 'a', 'b'];
    const registry = createServiceRegistry({ loadOrder: () => order });
    registry.forPlugin('a').contribute('test.tags', 'a1');
    registry.forPlugin('b').contribute('test.tags', 'b1');
    registry.forPlugin('a').contribute('test.tags', 'a2');
    registry.forPlugin('c').contribute('test.tags', 'c1');
    // Plugin fora da ordem informada vai para o fim.
    registry.forPlugin('z').contribute('test.tags', 'z1');

    expect(registry.forPlugin('x').extensionPoint('test.tags').list()).toEqual([
      'c1',
      'a1',
      'a2',
      'b1',
      'z1',
    ]);
  });

  it('list devolve cópia: mexer no array não altera o ponto', () => {
    const registry = createServiceRegistry();
    registry.forPlugin('a').contribute('test.tags', 'a');
    const point = registry.forPlugin('x').extensionPoint('test.tags');

    (point.list() as string[]).push('intruso');
    expect(point.list()).toEqual(['a']);
  });

  it('pontos de registries diferentes não se enxergam', () => {
    const one = createServiceRegistry();
    const two = createServiceRegistry();
    one.forPlugin('a').contribute('test.tags', 'a');
    expect(two.forPlugin('a').extensionPoint('test.tags').list()).toEqual([]);
  });
});
