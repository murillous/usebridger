/** FIFO com remoção O(1) na frente; `Array.shift` é O(n) e o backlog pode ter milhares. */
export class Fifo<T> {
  #items: (T | undefined)[] = [];
  #head = 0;

  get size(): number {
    return this.#items.length - this.#head;
  }

  push(item: T): void {
    this.#items.push(item);
  }

  peek(): T | undefined {
    return this.#items[this.#head];
  }

  shift(): T | undefined {
    if (this.#head >= this.#items.length) return undefined;
    const item = this.#items[this.#head];
    this.#items[this.#head] = undefined;
    this.#head++;
    if (this.#head === this.#items.length) {
      this.#items = [];
      this.#head = 0;
    } else if (this.#head >= 1024 && this.#head * 2 >= this.#items.length) {
      // Compacta só quando a parte consumida domina: custo amortizado O(1).
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    return item;
  }

  clear(): void {
    this.#items = [];
    this.#head = 0;
  }
}
