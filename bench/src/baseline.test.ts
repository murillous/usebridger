import { describe, expect, it } from 'vitest';
import { compare, goodQuartile } from './baseline.ts';

const scenarios = [
  { name: 'overhead', target: { max: 1 }, checksRegression: true },
  { name: 'throughput', target: { min: 5_000 }, checksRegression: true },
  { name: 'memory-growth', target: { max: 5 }, checksRegression: false },
] as const;

describe('compare', () => {
  it('teto: subir mais de 10% regride', () => {
    const [within, over] = [
      compare(scenarios, [{ name: 'overhead', runs: [0.22] }], [{ name: 'overhead', runs: [0.2] }]),
      compare(scenarios, [{ name: 'overhead', runs: [0.23] }], [{ name: 'overhead', runs: [0.2] }]),
    ];
    expect(within[0]).toMatchObject({ baseline: 0.2, regressed: false });
    expect(within[0]?.change).toBeCloseTo(0.1);
    expect(over[0]).toMatchObject({ regressed: true });
    expect(over[0]?.change).toBeCloseTo(0.15);
  });

  it('piso: cair mais de 10% regride, subir é melhora', () => {
    const base = [{ name: 'throughput', runs: [10_000] }];
    expect(compare(scenarios, [{ name: 'throughput', runs: [8_900] }], base)[0]).toMatchObject({
      regressed: true,
    });
    const better = compare(scenarios, [{ name: 'throughput', runs: [12_000] }], base)[0];
    expect(better).toMatchObject({ regressed: false });
    expect(better?.change).toBeCloseTo(-0.2);
  });

  it('cenário sem checksRegression não regride nem calcula a variação', () => {
    const [comparison] = compare(
      scenarios,
      [{ name: 'memory-growth', runs: [2] }],
      [{ name: 'memory-growth', runs: [-0.2] }],
    );
    expect(comparison).toEqual({
      name: 'memory-growth',
      value: 2,
      baseline: -0.2,
      change: undefined,
      regressed: false,
    });
  });

  it('cenário ausente do baseline passa sem comparação', () => {
    expect(compare(scenarios, [{ name: 'overhead', runs: [0.5] }], [])).toEqual([
      { name: 'overhead', value: 0.5, baseline: undefined, change: undefined, regressed: false },
    ]);
  });

  it('recusa resultado de cenário desconhecido', () => {
    expect(() => compare(scenarios, [{ name: 'nenhum', runs: [1] }], [])).toThrow(/desconhecido/);
  });

  it('compara o quartil bom de cada lado, não a mediana nem a melhor execução', () => {
    // Medianas 0,30 → 0,40 (+33%) e melhores 0,10 → 0,20 (+100%): a execução lenta é ruído, e a
    // de 0,10 na base, sorte. Quartis 0,20 → 0,21 (+5%).
    const [comparison] = compare(
      scenarios,
      [{ name: 'overhead', runs: [0.4, 0.21, 0.5, 0.2, 0.45] }],
      [{ name: 'overhead', runs: [0.3, 0.2, 0.35, 0.1, 0.3] }],
    );
    expect(comparison).toMatchObject({ value: 0.21, baseline: 0.2, regressed: false });
    expect(comparison?.change).toBeCloseTo(0.05);
  });
});

describe('goodQuartile', () => {
  it('teto: o p25; piso: o p75', () => {
    const runs = [5, 1, 4, 2, 3];
    expect(goodQuartile({ target: { max: 10 } }, runs)).toBe(2);
    expect(goodQuartile({ target: { min: 0 } }, runs)).toBe(4);
  });

  it('com uma execução, é ela', () => {
    expect(goodQuartile({ target: { max: 1 } }, [0.3])).toBe(0.3);
  });
});
