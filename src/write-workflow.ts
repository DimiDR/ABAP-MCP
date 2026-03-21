/**
 * ABAP MCP Server — Write Workflow
 * Orchestrates: lock → write → DDIC check → syntax check → activate → unlock
 */

import type { ADTClient, ActivationResultMessage } from "abap-adt-api";
import { withWriteLock, withStatefulSession } from "./concurrency.js";
import { resolveMainProgram, resolveSyntaxContext } from "./helpers/resolve.js";
import { validateDdicReferencesInternal } from "./helpers/ddic-validation.js";

export function formatActivationMessages(messages: ActivationResultMessage[]): string[] {
  return messages.map(m =>
    `  [${m.type}] ${m.shortText}${m.line ? ` (line ${m.line})` : ""}${m.objDescr ? ` — ${m.objDescr}` : ""}`
  );
}

export async function writeWorkflow(
  client: ADTClient,
  objectUrl: string,
  source: string,
  transport: string,
  activate: boolean,
  skipCheck: boolean,
  mainProgram?: string,
  onProgress?: (msg: string) => Promise<void>,
): Promise<{ success: boolean; log: string[]; syntaxErrors?: string[] }> {
  return withWriteLock(() => withStatefulSession(client, async () => {
    const log: string[] = [];
    let lockHandle: string | undefined;
    try {
      // Phase 1: lock → write → unlock (stateful session needed for lock/write)
      log.push(`🔒 Locking: ${objectUrl}`);
      // Direct lock — withStatefulSession already manages the session
      const lock = await client.lock(objectUrl);
      lockHandle = lock.LOCK_HANDLE;
      if (!lockHandle) throw new Error("Lock failed — no lock handle received");
      log.push(`✅ Lock acquired`);
      await onProgress?.("🔒 Lock acquired");

      log.push(`✏️  Writing source code (${source.length} characters)...`);
      const sourceUrl = objectUrl.endsWith("/source/main") ? objectUrl : `${objectUrl}/source/main`;
      await client.setObjectSource(sourceUrl, source, lockHandle, transport || undefined);
      log.push("✅ Source code saved");
      await onProgress?.("✏️ Source code saved");

      // Early DDIC validation prevents typical infinite loops caused by field name errors
      const ddicCheck = await validateDdicReferencesInternal(client, source);
      if (ddicCheck.tableCount > 0) {
        log.push(`🔎 DDIC validation: ${ddicCheck.tableCount} tables/structures checked`);
      }
      if (ddicCheck.invalid.length > 0) {
        log.push("❌ DDIC validation failed — code NOT activated.");
        log.push(...ddicCheck.invalid.slice(0, 50));
        if (ddicCheck.invalid.length > 50) {
          log.push(`... and ${ddicCheck.invalid.length - 50} more DDIC errors`);
        }
        log.push("👉 Please fix the invalid field names and call write_abap_source again.");
        return { success: false, log, syntaxErrors: ddicCheck.invalid };
      }

      // Phase 2: unlock + syntaxCheck in parallel (no lock needed for check)
      log.push("🔓 Releasing lock + 🔍 Syntax check (parallel)...");
      const syntaxContext = await resolveSyntaxContext(client, objectUrl, mainProgram, log);
      const [, syntaxRes] = await Promise.all([
        client.unLock(objectUrl, lockHandle).catch((e) => {
          log.push(`⚠️ Unlock failed: ${e instanceof Error ? e.message : String(e)}`);
        }),
        !skipCheck
          ? client.syntaxCheck(objectUrl, syntaxContext, source).catch((e) => {
              log.push(`⚠️ Syntax check failed: ${e instanceof Error ? e.message : String(e)}`);
              return null; // null = check failed
            })
          : Promise.resolve(undefined),
      ]);
      lockHandle = undefined;
      log.push("✅ Lock released");

      // Process syntaxRes (undefined = skipped, null = error, array = result)
      if (!skipCheck && syntaxRes !== undefined) {
        if (syntaxRes === null) {
          log.push("👉 Syntax check skipped — code was saved. Please check manually.");
          return { success: false, log };
        }
        const errs = (Array.isArray(syntaxRes) ? syntaxRes : []).filter(
          (m: { severity: string }) => ["E", "A"].includes(m.severity));
        if (errs.length > 0) {
          const msgs = errs.map((e: { text: string; line?: number }) => `  Line ${e.line ?? "?"}: ${e.text}`);
          log.push(`❌ ${errs.length} syntax error(s) — code NOT activated.`);
          log.push("👉 Please fix the errors and call write_abap_source again!");
          return { success: false, log, syntaxErrors: msgs };
        }
        log.push("✅ Syntax check OK");
        await onProgress?.("🔍 Syntax check OK — activating...");
      }

      if (activate) {
        log.push("🚀 Activating...");
        const segments = objectUrl.replace(/[?#].*$/, "").split("/").filter(Boolean);
        const name = segments[segments.length - 1] ?? objectUrl;

        // Include programs need the main program as context for activation,
        // because they cannot be activated alone (they reference variables of the main program).
        let activationContext: string | undefined;
        const isInclude = objectUrl.includes("/programs/includes/");
        if (isInclude) {
          const resolvedMain = resolveMainProgram(mainProgram);
          if (resolvedMain) {
            activationContext = resolvedMain;
            log.push(`📎 Include — activating in context of: ${mainProgram}`);
          } else {
            // Automatically determine main program
            try {
              const mains = await client.mainPrograms(objectUrl);
              if (mains.length > 0) {
                activationContext = mains[0]["adtcore:uri"];
                log.push(`📎 Include — main program automatically determined: ${mains[0]["adtcore:name"]}`);
              }
            } catch (mpErr) {
              log.push(`⚠️  Main program could not be determined: ${String(mpErr instanceof Error ? mpErr.message : mpErr)}`);
            }
          }
        }

        const activationResult = await client.activate(name, objectUrl, activationContext);
        if (!activationResult.success) {
          const msgs = formatActivationMessages(activationResult.messages);
          log.push(`❌ Activation failed — code was saved but NOT activated.`);
          if (msgs.length > 0) log.push(...msgs);
          log.push("👉 Please analyze the errors, fix the code and call write_abap_source again!");
          return { success: false, log };
        }
        if (activationResult.messages.length > 0) {
          log.push("✅ Activated (with notices):");
          log.push(...formatActivationMessages(activationResult.messages));
        } else {
          log.push("✅ Activated");
        }
        await onProgress?.("✅ Activated");
      }

      return { success: true, log };
    } catch (err) {
      if (lockHandle) {
        try { await client.unLock(objectUrl, lockHandle); log.push("🔓 Lock released after error"); }
        catch { log.push("⚠️  Lock could not be released — dropSession in finally will clean up"); }
        lockHandle = undefined;
      }
      throw err;
    }
  }));
}
