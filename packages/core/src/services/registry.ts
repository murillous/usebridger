import type {
  ExtensionPoint,
  ExtensionPointName,
  ExtensionPoints,
  ServiceAccess,
  ServiceName,
  Services,
} from './types.ts';

/** Serviço registrado com o plugin que o proveu. */
export interface ProvidedService {
  readonly plugin: string;
  readonly name: string;
  readonly service: unknown;
}

/** `get` de um serviço que nenhum plugin carregado provê. */
export class ServiceNotFoundError extends Error {
  override readonly name = 'ServiceNotFoundError';
  readonly service: string;
  /** Plugin que pediu o serviço. */
  readonly requestedBy: string;

  constructor(service: string, requestedBy: string) {
    super(
      `Serviço "${service}" não encontrado (pedido pelo plugin "${requestedBy}"): nenhum ` +
        `plugin carregado o provê. Declare em "${requestedBy}" o \`dependsOn\` do plugin que ` +
        `provê "${service}", para que ele carregue (e chame \`provide\`) antes.`,
    );
    this.service = service;
    this.requestedBy = requestedBy;
  }
}

/** Dois `provide` com o mesmo nome. Lançado no `setup`, isto é, no boot. */
export class ServiceConflictError extends Error {
  override readonly name = 'ServiceConflictError';
  readonly service: string;
  readonly existing: string;
  readonly incoming: string;

  constructor(service: string, existing: string, incoming: string) {
    super(
      existing === incoming
        ? `Serviço "${service}" provido duas vezes pelo plugin "${incoming}". Cada serviço é ` +
            `provido uma vez por setup; para trocar a implementação, recarregue o plugin.`
        : `Conflito de serviço "${service}": o plugin "${incoming}" tenta prover um serviço ` +
            `que o plugin "${existing}" já provê. Desabilite um dos dois ou renomeie o serviço.`,
    );
    this.service = service;
    this.existing = existing;
    this.incoming = incoming;
  }
}

export interface ServiceRegistry {
  /** O `ctx.services` do plugin: `provide` e `contribute` atribuem a ele, e os erros o citam. */
  forPlugin(plugin: string): ServiceAccess;
  /** Remove os serviços e as contribuições do plugin (teardown, reload e disable). */
  removePlugin(plugin: string): void;
  list(): ProvidedService[];
}

export interface ServiceRegistryOptions {
  /**
   * Nomes dos plugins na ordem de carga, lida a cada `list()` de um ponto de extensão. O `Bot`
   * passa a tabela do host; sem ela (ou para plugin fora dela), vale a ordem do primeiro
   * `forPlugin`, que no boot coincide com a de carga.
   */
  readonly loadOrder?: () => readonly string[];
}

interface Contribution {
  readonly plugin: string;
  readonly value: unknown;
}

/** Um registry por bot: nada global, então dois bots no mesmo processo não se enxergam. */
export function createServiceRegistry(options: ServiceRegistryOptions = {}): ServiceRegistry {
  // Chave string: em runtime o core não conhece os nomes, que só existem no type-level.
  const byName = new Map<string, ProvidedService>();
  // Por ponto, na ordem do `contribute`; o `list()` reordena por plugin.
  const contributions = new Map<string, Contribution[]>();
  // Guardado mesmo depois do `removePlugin`: o plugin recarregado volta à posição de antes, e
  // não para o fim da lista (a etapa dele rodaria fora da ordem de carga só por ter recarregado).
  const firstSeen = new Map<string, number>();

  const rankOf = (order: readonly string[], plugin: string): number => {
    const index = order.indexOf(plugin);
    return index >= 0 ? index : order.length + (firstSeen.get(plugin) ?? firstSeen.size);
  };

  function listContributions(point: string): unknown[] {
    const entries = contributions.get(point);
    if (!entries) return [];
    const order = options.loadOrder?.() ?? [];
    // `sort` é estável: dentro do mesmo plugin fica a ordem do `contribute`.
    return [...entries]
      .sort((a, b) => rankOf(order, a.plugin) - rankOf(order, b.plugin))
      .map((entry) => entry.value);
  }

  return {
    forPlugin(plugin) {
      if (!firstSeen.has(plugin)) firstSeen.set(plugin, firstSeen.size);
      return {
        provide<K extends ServiceName>(name: K, service: Services[K]): void {
          const existing = byName.get(name);
          // Re-prover é erro mesmo no próprio plugin: quem já fez `get` guardaria a instância
          // antiga sem saber. Trocar a implementação passa por teardown + setup (reload).
          if (existing) throw new ServiceConflictError(name, existing.plugin, plugin);
          byName.set(name, { plugin, name, service });
        },

        get<K extends ServiceName>(name: K): Services[K] {
          const entry = byName.get(name);
          if (!entry) throw new ServiceNotFoundError(name, plugin);
          // O tipo foi garantido no `provide`, que só aceita `Services[K]` para o nome K.
          return entry.service as Services[K];
        },

        has(name) {
          return byName.has(name);
        },

        contribute<K extends ExtensionPointName>(name: K, contribution: ExtensionPoints[K]): void {
          const entries = contributions.get(name) ?? [];
          entries.push({ plugin, value: contribution });
          contributions.set(name, entries);
        },

        extensionPoint<K extends ExtensionPointName>(name: K): ExtensionPoint<ExtensionPoints[K]> {
          // O tipo foi garantido no `contribute`, que só aceita `ExtensionPoints[K]` para K.
          return { list: () => listContributions(name) as ExtensionPoints[K][] };
        },
      };
    },

    removePlugin(plugin) {
      for (const [name, entry] of byName) {
        if (entry.plugin === plugin) byName.delete(name);
      }
      for (const [point, entries] of contributions) {
        const kept = entries.filter((entry) => entry.plugin !== plugin);
        if (kept.length > 0) contributions.set(point, kept);
        else contributions.delete(point);
      }
    },

    list() {
      return [...byName.values()];
    },
  };
}
