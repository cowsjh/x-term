import { listen } from "@tauri-apps/api/event";

/** One Tauri listener per event name, fanned out by id. Panes register a handler instead of each filtering the full stream. */
const handlers = new Map<string, Map<string, (payload: any) => void>>();
const started = new Set<string>();
const warn = (e: unknown) => console.warn("[x-term]", e);

export function onEvent<T extends { id: string }>(event: string, id: string, fn: (payload: T) => void): () => void {
  if (!handlers.has(event)) handlers.set(event, new Map());
  handlers.get(event)!.set(id, fn);
  if (!started.has(event)) {
    started.add(event);
    listen<T>(event, ({ payload }) => handlers.get(event)?.get(payload.id)?.(payload)).catch(warn);
  }
  return () => { handlers.get(event)?.delete(id); };
}
export { warn };
/** Pane ids with a running turn; App warns before quitting while it is non-empty. */
export const busyPanes = new Set<string>();
/** Per chat pane, for the orchestration tools (agent_status / wait_agents) and the Alt+P / Alt+U jumps and the parent's
 *  children summary: turn state, permission wait, unread, last answer, turns finished, who spawned it. */
export type AgentState = { busy: boolean; perm: boolean; unread: boolean; last: string; turns: number; spawnedBy?: string };
export const agents = new Map<string, AgentState>();
