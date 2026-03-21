/**
 * DELETE tool handler: delete_abap_object
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_DeleteObject } from "../../schemas.js";
import { assertWriteEnabled, assertDeleteEnabled } from "../../safety.js";
import { withWriteLock, withStatefulSession } from "../../concurrency.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }

export async function handleDeleteAbapObject(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled("Delete");
  assertDeleteEnabled();
  const p = S_DeleteObject.parse(args);
  await withWriteLock(() => withStatefulSession(client, async () => {
    const lock = await client.lock(p.objectUrl);
    try {
      await client.deleteObject(p.objectUrl, lock.LOCK_HANDLE, p.transport || undefined);
    } catch (e) {
      try { await client.unLock(p.objectUrl, lock.LOCK_HANDLE); } catch { /* ignore */ }
      throw e;
    }
  }));
  return ok(`✅ Object '${p.objectName}' deleted.\n⚠️  This action cannot be undone.`);
}
