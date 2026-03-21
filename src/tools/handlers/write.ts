/**
 * WRITE tool handlers: write_abap_source, activate_abap_object, mass_activate, pretty_print
 */

import * as fs from "fs";
import type { ADTClient, ActivationResultMessage } from "abap-adt-api";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "../../types.js";
import { S_WriteSource, S_Activate, S_MassActivate, S_PrettyPrint } from "../../schemas.js";
import { cfg } from "../../config.js";
import { assertWriteEnabled } from "../../safety.js";
import { writeWorkflow, formatActivationMessages } from "../../write-workflow.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }
function err(text: string): ToolResult { return { content: [{ type: "text", text }], isError: true }; }

export async function handleWriteAbapSource(client: ADTClient, args: Record<string, unknown>, extra?: any): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_WriteSource.parse(args);
  let source: string;
  if (p.sourcePath) {
    try {
      source = fs.readFileSync(p.sourcePath, "utf-8");
    } catch (e) {
      throw new McpError(ErrorCode.InvalidRequest,
        `Cannot read sourcePath '${p.sourcePath}': ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    source = p.source!;
  }
  const progressToken = (extra as { _meta?: { progressToken?: string | number } })?._meta?.progressToken;
  let step = 0;
  const totalSteps = 4;
  async function reportProgress(message: string) {
    if (progressToken === undefined) return;
    step++;
    await (extra as { sendNotification: (n: object) => Promise<void> }).sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: step, total: totalSteps, message },
    });
  }
  const r = await writeWorkflow(
    client, p.objectUrl, source,
    p.transport ?? cfg.defaultTransport,
    p.activateAfterWrite ?? true,
    p.skipSyntaxCheck ?? false,
    p.mainProgram,
    reportProgress,
  );
  const body = r.log.join("\n") + (r.syntaxErrors ? "\n\nSyntax errors:\n" + r.syntaxErrors.join("\n") : "");
  if (r.success) {
    return ok(`✅ Successfully written and activated\n\n${body}`);
  }
  return err(`❌ Error — code NOT activated!\n\n${body}\n\n⚠️ ACTION REQUIRED: Analyze the errors above, fix the ABAP source code and call write_abap_source again. Repeat until activation succeeds.`);
}

export async function handleActivateAbapObject(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_Activate.parse(args);
  const activationResult = await client.activate(p.objectName, p.objectUrl);
  if (!activationResult.success) {
    const msgs = formatActivationMessages(activationResult.messages);
    return err(`❌ Activation of '${p.objectName}' failed\n${msgs.join("\n")}`);
  }
  const extra2 = activationResult.messages.length > 0
    ? `\n${formatActivationMessages(activationResult.messages).join("\n")}` : "";
  return ok(`✅ '${p.objectName}' successfully activated${extra2}`);
}

export async function handleMassActivate(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_MassActivate.parse(args);
  if (p.objects.length > 50)
    throw new McpError(ErrorCode.InvalidRequest, "Maximum 50 objects per mass activation.");
  const allMessages: ActivationResultMessage[] = [];
  let allSuccess = true;
  for (const obj of p.objects) {
    const activationResult = await client.activate(obj.objectName, obj.objectUrl);
    allMessages.push(...activationResult.messages);
    if (!activationResult.success) allSuccess = false;
  }
  const activationResult = { success: allSuccess, messages: allMessages };
  const msgs = formatActivationMessages(activationResult.messages);
  if (!activationResult.success) {
    return err(`❌ Mass activation failed (${p.objects.length} objects)\n${msgs.join("\n")}`);
  }
  const extra2 = msgs.length > 0 ? `\n\nNotices:\n${msgs.join("\n")}` : "";
  return ok(`✅ Mass activation: ${p.objects.length} object(s) successfully activated${extra2}`);
}

export async function handlePrettyPrint(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_PrettyPrint.parse(args);
  const formatted = await client.prettyPrinter(p.source);
  return ok(typeof formatted === "string" ? formatted : JSON.stringify(formatted));
}
