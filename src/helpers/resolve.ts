/**
 * Main program resolution helpers for syntax checks and activation context.
 */

import type { ADTClient } from "abap-adt-api";
import { ADT_PROGRAMS } from "../adt-endpoints.js";

export function resolveMainProgram(mainProgram: string | undefined): string | undefined {
  if (!mainProgram) return undefined;
  // Already a URL — use as-is
  if (mainProgram.startsWith("/")) return mainProgram;
  // Plain program name → convert to ADT URL
  return `${ADT_PROGRAMS}/${mainProgram.toLowerCase()}`;
}

export async function resolveSyntaxContext(
  client: ADTClient,
  objectUrl: string,
  mainProgram?: string,
  log?: string[],
): Promise<string> {
  const explicitMain = resolveMainProgram(mainProgram);
  if (explicitMain) return explicitMain;

  // Include-Programme brauchen ein Hauptprogramm als Kontext,
  // sonst entstehen häufig "No component exists"-Fehler obwohl der Code korrekt ist.
  if (objectUrl.includes("/programs/includes/")) {
    try {
      const mains = await client.mainPrograms(objectUrl);
      const autoMain = mains[0]?.["adtcore:uri"];
      if (autoMain) {
        log?.push(`📎 Syntax context automatically determined: ${mains[0]["adtcore:name"]}`);
        return autoMain;
      }
    } catch (e) {
      log?.push(`⚠️ Main program for syntax check could not be determined: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return objectUrl;
}
