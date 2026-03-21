/**
 * ABAP MCP Server — Configuration
 * Parsed from environment variables (.env file).
 */

import "dotenv/config";

export const cfg = {
  url:                     process.env.SAP_URL ?? "",
  user:                    process.env.SAP_USER ?? "",
  password:                process.env.SAP_PASSWORD ?? "",
  client:                  process.env.SAP_CLIENT ?? "100",
  language:                process.env.SAP_LANGUAGE ?? "EN",
  allowWrite:              process.env.ALLOW_WRITE === "true",
  allowDelete:             process.env.ALLOW_DELETE === "true",
  allowExecute:            process.env.ALLOW_EXECUTE === "true",
  blockedPackages:         (process.env.BLOCKED_PACKAGES ?? "SAP,SHD")
                             .split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
  defaultTransport:        process.env.DEFAULT_TRANSPORT ?? "",
  syntaxCheckBeforeActivate: process.env.SYNTAX_CHECK_BEFORE_ACTIVATE !== "false",
  maxDumps:                parseInt(process.env.MAX_DUMPS ?? "20", 10),
  allowUnauthorized:       process.env.SAP_ALLOW_UNAUTHORIZED === "true",
  deferTools:              process.env.DEFER_TOOLS !== "false",
  sapAbapVersion:          process.env.SAP_ABAP_VERSION ?? "latest",
};

if (!cfg.url || !cfg.user || !cfg.password) {
  console.error("ERROR: SAP_URL, SAP_USER and SAP_PASSWORD must be set in .env");
  process.exit(1);
}
