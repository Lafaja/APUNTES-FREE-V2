/** Emisor de eventos mínimo. */
export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(type, handler) {
    let set = this._handlers.get(type);
    if (!set) {
      set = new Set();
      this._handlers.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const set = this._handlers.get(type);
    if (set) set.delete(handler);
  }

  emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`Error en manejador del evento "${type}":`, err);
      }
    }
  }
}
