// Comparação com o baseline (M2-4.2): o PR falha se um cenário piorar mais de 10% sobre a medida
// do commit base, tirada na mesma máquina e intercalada com a do commit testado (ADR 0054, ADR 0089).

import type { Scenario } from './scenarios.ts';
import { percentile } from './stats.ts';

/** Piora máxima aceita sobre o baseline (plano §7). */
export const TOLERANCE = 0.1;

/** O que a comparação usa de um resultado: o cenário e as execuções. */
export interface Measured {
  readonly name: string;
  readonly runs: readonly number[];
}

export interface Comparison {
  readonly name: string;
  /** Quartil bom das execuções do commit testado (`goodQuartile`). */
  readonly value: number;
  /** Quartil bom das execuções do baseline; `undefined` quando o cenário não existia nele. */
  readonly baseline: number | undefined;
  /**
   * Piora relativa ao baseline (0,1 = 10% pior; negativo = melhorou). `undefined` sem baseline ou
   * em cenário sem `checksRegression`.
   */
  readonly change: number | undefined;
  readonly regressed: boolean;
}

/**
 * O quartil do lado bom da meta: o p25 num teto, o p75 num piso. O ruído da máquina (GC, troca de
 * processo, CPU disputada) puxa a medida para o lado ruim, então a mediana carrega ele. A melhor
 * execução também varia: uma execução rápida demais aparece num lado e não no outro (no `boot`,
 * o mínimo de 25 execuções chegou a ±7% com o mesmo código, e o quartil ficou em ±3%).
 */
export function goodQuartile(scenario: Pick<Scenario, 'target'>, runs: readonly number[]): number {
  return percentile(runs, 'max' in scenario.target ? 25 : 75);
}

/**
 * Compara cada resultado com o mesmo cenário no baseline, pelo quartil bom de cada lado. A
 * piora é medida no sentido da meta: subir é pior num teto (`max`), cair é pior num piso (`min`).
 * Cenário sem `checksRegression` ou ausente do baseline é listado, mas não falha.
 */
export function compare(
  scenarios: readonly Pick<Scenario, 'name' | 'target' | 'checksRegression'>[],
  results: readonly Measured[],
  baseline: readonly Measured[],
): Comparison[] {
  return results.map(({ name, runs }) => {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (scenario === undefined) throw new Error(`cenário desconhecido no resultado: ${name}`);
    const value = goodQuartile(scenario, runs);
    const baseRuns = baseline.find((candidate) => candidate.name === name)?.runs;
    if (baseRuns === undefined || baseRuns.length === 0) {
      return { name, value, baseline: undefined, change: undefined, regressed: false };
    }
    const base = goodQuartile(scenario, baseRuns);
    // Sem a checagem, a variação nem é calculada: com o baseline perto de zero ou negativo, o
    // percentual sai enorme ou com o sinal trocado.
    if (!scenario.checksRegression) {
      return { name, value, baseline: base, change: undefined, regressed: false };
    }
    const change = 'max' in scenario.target ? (value - base) / base : (base - value) / base;
    return { name, value, baseline: base, change, regressed: change > TOLERANCE };
  });
}
