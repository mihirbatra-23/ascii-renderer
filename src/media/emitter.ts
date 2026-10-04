/** Minimal synchronous event emitter; `on` returns its own unsubscribe function. */
export class Emitter<Args extends unknown[]> {
  private readonly listeners = new Set<(...args: Args) => void>();

  on(listener: (...args: Args) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(...args: Args): void {
    // Snapshot so listeners may unsubscribe while being called.
    for (const listener of [...this.listeners]) listener(...args);
  }

  clear(): void {
    this.listeners.clear();
  }
}
