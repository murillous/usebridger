// Contrato do service registry (M1-9, ADR 0018). O M1-9 completa este arquivo; os nomes
// exportados aqui são usados por outros módulos e não mudam.

/**
 * Mapa nome → tipo do serviço, preenchido por declaration merging no plugin que provê:
 *
 * ```ts
 * declare module '@usebridger/core' {
 *   interface Services { ai: AiService }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: vazio de propósito; plugins estendem por declaration merging.
export interface Services {}

/** Nomes declarados em `Services`; só strings, porque viram chave de mapa e texto de erro. */
export type ServiceName = Extract<keyof Services, string>;

/**
 * Mapa nome → tipo de cada contribuição de um ponto de extensão, preenchido por declaration
 * merging no plugin que oferece o ponto:
 *
 * ```ts
 * declare module '@usebridger/core' {
 *   interface ExtensionPoints { 'sticker.steps': StickerStep }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: vazio de propósito; plugins estendem por declaration merging.
export interface ExtensionPoints {}

/** Nomes declarados em `ExtensionPoints`. */
export type ExtensionPointName = Extract<keyof ExtensionPoints, string>;

/** Visão viva de um ponto de extensão, devolvida por `ctx.services.extensionPoint`. */
export interface ExtensionPoint<T> {
  /**
   * Contribuições atuais, na ordem de carga de quem contribuiu (dentro do mesmo plugin, na ordem
   * do `contribute`). Cópia: lida a cada chamada, já reflete reload e disable de quem contribuiu.
   */
  list(): readonly T[];
}

/**
 * Acesso do plugin ao registry (`ctx.services`). Os serviços que o plugin provê ficam
 * atribuídos a ele e saem no teardown/reload.
 */
export interface ServiceAccess {
  /**
   * Publica o serviço. Lança `ServiceConflictError` se o nome já foi provido, por outro plugin
   * ou pelo próprio (re-prover não substitui: trocar a implementação é recarregar o plugin).
   */
  provide<K extends ServiceName>(name: K, service: Services[K]): void;
  /**
   * Devolve o serviço; lança `ServiceNotFoundError` se ninguém o provê. Pode ser chamado já no
   * `setup`: o boot segue a ordem do `dependsOn`, então a dependência já rodou o dela.
   */
  get<K extends ServiceName>(name: K): Services[K];
  has(name: ServiceName): boolean;
  /**
   * Acrescenta uma contribuição ao ponto de extensão, atribuída a este plugin: sai sozinha no
   * teardown, reload e disable dele. O ponto não precisa existir antes; quem o oferece só lê.
   */
  contribute<K extends ExtensionPointName>(name: K, contribution: ExtensionPoints[K]): void;
  /** Visão das contribuições de todos os plugins ao ponto `name` (ver `ExtensionPoint`). */
  extensionPoint<K extends ExtensionPointName>(name: K): ExtensionPoint<ExtensionPoints[K]>;
}
