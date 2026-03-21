/**
 * TEST tool handlers: run_unit_tests, create_test_include
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_RunTests, S_CreateTestInclude } from "../../schemas.js";
import { assertWriteEnabled } from "../../safety.js";
import { withWriteLock, withStatefulSession } from "../../concurrency.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }
function err(text: string): ToolResult { return { content: [{ type: "text", text }], isError: true }; }

export async function handleRunUnitTests(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_RunTests.parse(args);
  const results = await client.unitTestRun(p.objectUrl);
  if (!results || results.length === 0) return ok("No unit test results — are tests present?");
  let passed = 0, failed = 0;
  for (const cls of results) {
    for (const method of cls.testmethods ?? []) {
      if (method.alerts && method.alerts.length > 0) failed++;
      else passed++;
    }
  }
  const summary = `Unit tests: ${passed} passed, ${failed} failed`;
  return (failed === 0 ? ok : err)(`${failed === 0 ? "✅" : "❌"} ${summary}\n\n${JSON.stringify(results, null, 2)}`);
}

export async function handleCreateTestInclude(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_CreateTestInclude.parse(args);
  await withWriteLock(() => withStatefulSession(client, async () => {
    const lock = await client.lock(p.classUrl);
    try {
      await client.createTestInclude(p.classUrl, lock.LOCK_HANDLE);
      await client.unLock(p.classUrl, lock.LOCK_HANDLE);
    } catch (e) {
      try { await client.unLock(p.classUrl, lock.LOCK_HANDLE); } catch { /* ignore */ }
      throw e;
    }
  }));
  return ok(`✅ Test include created for ${p.classUrl}`);
}
