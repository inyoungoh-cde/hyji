// Simple event bus for menu → component communication
type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function onMenuEvent(id: string, fn: Listener): () => void {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id)!.add(fn);
  return () => listeners.get(id)?.delete(fn);
}

export function emitMenuEvent(id: string) {
  listeners.get(id)?.forEach((fn) => fn());
}
