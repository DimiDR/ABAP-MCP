/**
 * ABAP MCP Server — Safety Guards
 * Inline checks that protect against unintended writes/deletes.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { cfg } from "./config.js";

export function assertWriteEnabled(action = "Write"): void {
  if (!cfg.allowWrite)
    throw new McpError(ErrorCode.InvalidRequest,
      `${action} is disabled. Set ALLOW_WRITE=true in .env. ` +
      "⚠️  Only enable on DEV systems!");
}

export function assertDeleteEnabled(): void {
  if (!cfg.allowDelete)
    throw new McpError(ErrorCode.InvalidRequest,
      "Delete is disabled. Set ALLOW_DELETE=true in .env. ⚠️  This action cannot be undone!");
}

export function assertPackageAllowed(devClass: string): void {
  const upper = devClass.toUpperCase();
  const blocked = cfg.blockedPackages.find(p => upper.startsWith(p));
  if (blocked)
    throw new McpError(ErrorCode.InvalidRequest,
      `Package '${devClass}' is blocked (prefix '${blocked}' in BLOCKED_PACKAGES).`);
}

export function assertCustomerNamespace(name: string, prefix: string[]): void {
  const upper = name.toUpperCase();
  if (!prefix.some(p => upper.startsWith(p)))
    throw new McpError(ErrorCode.InvalidRequest,
      `Name '${name}' must start with ${prefix.join(" or ")} (customer namespace).`);
}

export function assertSelectOnly(query: string): void {
  const trimmed = query.trim();
  if (!/^SELECT\s/i.test(trimmed) || /[;.]\s*(INSERT|UPDATE|DELETE|MODIFY|COMMIT)\s/i.test(trimmed))
    throw new McpError(ErrorCode.InvalidRequest,
      "Only SELECT statements are allowed. The query must start with 'SELECT' and must not contain DML statements.");
}
