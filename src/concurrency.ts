/**
 * ABAP MCP Server — Concurrency & Session Management
 * Serializes write operations and manages stateful ADT sessions.
 */

import { ADTClient, session_types } from "abap-adt-api";

let writeLock: Promise<void> = Promise.resolve();

export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let release: () => void;
  writeLock = new Promise<void>(resolve => { release = resolve; });
  return prev.then(fn).finally(() => release!());
}

export async function withStatefulSession<T>(client: ADTClient, fn: () => Promise<T>): Promise<T> {
  client.stateful = session_types.stateful;
  try {
    return await fn();
  } finally {
    try { await client.dropSession(); } catch (e) {
      console.error("⚠️ dropSession failed:", e instanceof Error ? e.message : String(e));
    }
    client.stateful = session_types.stateless;
  }
}
