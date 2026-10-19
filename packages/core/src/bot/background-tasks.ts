// `run` de comandos com `background: true` em andamento (ADR 0083): fora da fila do chat, mas
// dentro do `settled()`. O shutdown os solta (`clear`): quem ignora o `signal` abortado e tem o
// prazo desarmado nunca assenta.

export class BackgroundTasks {
  readonly #tasks = new Set<Promise<void>>();
  #waiters: (() => void)[] = [];

  get size(): number {
    return this.#tasks.size;
  }

  /** A tarefa sai do conjunto ao assentar; quem a cria trata a rejeição dela. */
  track(task: Promise<void>): void {
    this.#tasks.add(task);
    void task.finally(() => {
      this.#tasks.delete(task);
      if (this.#tasks.size === 0) this.#release();
    });
  }

  /** Resolve quando não houver tarefa em andamento; na hora, se já não houver. */
  idle(): Promise<void> {
    if (this.#tasks.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Esquece as tarefas em andamento e solta quem espera o `idle()`. */
  clear(): void {
    this.#tasks.clear();
    this.#release();
  }

  #release(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
