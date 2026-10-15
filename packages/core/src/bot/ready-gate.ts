/**
 * Portão do boot: mensagens que chegam enquanto os plugins sobem esperam `promise`; `false` =
 * boot abortado. Só a primeira chamada de `settle` vale: depois de pronto, o shutdown drena o
 * que a fila já aceitou.
 */
export class ReadyGate {
  #ready = false;
  #settled = false;
  readonly #deferred = Promise.withResolvers<boolean>();

  /** `true` só depois de `settle(true)`. */
  get ready(): boolean {
    return this.#ready;
  }

  /** Assenta com o `ok` da primeira chamada a `settle`. */
  get promise(): Promise<boolean> {
    return this.#deferred.promise;
  }

  /** Idempotente: só a primeira chamada vale. */
  settle(ok: boolean): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#ready = ok;
    this.#deferred.resolve(ok);
  }
}
