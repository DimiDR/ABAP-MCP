# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ABAP MCP Server v2 is a standalone Model Context Protocol (MCP) server that enables AI assistants (Claude, Copilot, Cursor) to interact with SAP ABAP systems via the ADT REST API. It implements 50 tools across 14 categories + 2 meta-tools (`find_tools`, `list_tools`) + 1 MCP Prompt (`abap_develop`) for full ABAP development workflow support.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Build (TypeScript compilation)
npm run build

# Development mode (uses tsx for direct TypeScript execution)
npm run dev

# Start built server
npm start

# Clean build artifacts
npm run clean
```

**Tech Stack:**
- TypeScript 5.7+ with strict mode
- Node.js 20+
- Target: ES2022
- Output: ESM (`"type": "module"`) to `dist/`, module resolution: NodeNext

## Architecture

### Modular Architecture
- **Entry**: `src/index.ts` — startup & banner
- **Server**: `src/server.ts` — MCP request handlers (ListTools, CallTool, Prompts)
- **Config**: `src/config.ts` — environment variable parsing
- **Schemas**: `src/schemas.ts` — Zod parameter validation for all tools
- **Tools**: `src/tools/` — tool definitions, registry, and handler dispatch map
  - `tool-definitions.ts` — 50 tool metadata (name, description, schema)
  - `tool-registry.ts` — categories, core tools, deferred loading
  - `handler-map.ts` — dispatch map (tool name → handler function)
  - `handlers/` — 16 handler modules (search, read, write, create, delete, test, quality, diagnostics, transport, abapgit, query, documentation, context, websearch, batch, meta)
- **Helpers**: `src/helpers/` — JSON schema conversion, DDIC validation, documentation fetching, Clean ABAP analysis
- **Connection**: Lazy-initialized single `ADTClient` instance reused across all tool calls
- **Transport**: stdio-based MCP protocol with `@modelcontextprotocol/sdk`

### Concurrency & Session Management
- **Write Lock**: Serial execution of write operations (`withWriteLock()`) to prevent concurrent ADT lock conflicts
- **Stateful Sessions**: Write workflows use stateful mode for complex lock → write → activate sequences
- **Lock Recovery**: Automatic retry logic for stale locks (drops session, full logout/login if needed)

### Tool Architecture
- **Schema Validation**: Zod for all tool parameters (30+ schemas in `src/schemas.ts`)
- **Tool Groups**: SEARCH, READ, WRITE, CREATE, DELETE, TEST, QUALITY, DIAGNOSTICS, TRANSPORT, ABAPGIT, QUERY, DOCUMENTATION, WEBSEARCH, BATCH
- **Deferred Loading** (default): Only 13 core tools (`search_abap_objects`, `search_source_code`, `read_abap_source`, `write_abap_source`, `get_object_info`, `where_used`, `analyze_abap_context`, `search_abap_syntax`, `validate_ddic_references`, `batch_read`, `search_sap_web`, `find_tools`, `list_tools`) loaded initially; others activated on-demand via `find_tools` meta-tool (~75-80% token savings)
- **MCP Prompt** (`abap_develop`): Enforces a 6-step ABAP development workflow (context analysis → reference research → Clean ABAP → code placement → implementation → quality check)

### ADT Write Workflow (Critical Flow)
```
lock(objectUrl)
  → setObjectSource(source)
  → syntaxCheck(source)
  → [if errors: skip activate, unlock, throw]
  → activate(objectUrl)
  → unlock(objectUrl)
  → [finally block always unlocks on error]
```

## Configuration & Security

### Environment Variables (`.env`)
**Required:**
- `SAP_URL` — System URL (e.g., `https://dev-system:8000`)
- `SAP_USER`, `SAP_PASSWORD` — Credentials

**Optional:**
- `SAP_CLIENT=100` (default) — SAP client number
- `SAP_LANGUAGE=EN` (default) — Logon language
- `DEFAULT_TRANSPORT` — Default transport request for write operations
- `SYNTAX_CHECK_BEFORE_ACTIVATE=true` (default) — Set `false` to skip syntax check before activation
- `MAX_DUMPS=20` (default) — Max short dumps returned by diagnostics
- `SAP_ALLOW_UNAUTHORIZED=false` (default) — Accept self-signed SSL certificates

**Safety Guards (all default-safe):**
- `ALLOW_WRITE=false` (default) — Disables all write/create/delete tools
- `ALLOW_DELETE=false` (default) — Requires `ALLOW_WRITE=true` + explicit enable
- `ALLOW_EXECUTE=false` (default) — Enables `execute_abap_snippet`; requires `ALLOW_WRITE=true` + explicit enable
- `BLOCKED_PACKAGES=SAP,SHD` (default) — Customer namespace protection (prevents writes to SAP-owned packages)
- Enforced customer namespace check: names must start with Z/Y
- System-level SAP auth (`S_ADT_RES`, `S_DEVELOP`) is final barrier

**Recommended per environment:**
- **DEV**: `ALLOW_WRITE=true`, `ALLOW_DELETE=false`, `ALLOW_EXECUTE=true`
- **QAS/TEST**: `ALLOW_WRITE=false`, `ALLOW_DELETE=false`, `ALLOW_EXECUTE=false`
- **PROD**: All `false` (never enable)

### Token Optimization
- `SAP_ABAP_VERSION=latest` (default): ABAP version for help.sap.com documentation URLs (e.g. `latest`, `758`, `754`)
- `DEFER_TOOLS=true` (default): Lazy load tools on demand via `find_tools(category=...)` or `find_tools(query=...)`
- `DEFER_TOOLS=false`: Load all 47 tools upfront (higher initial token cost)

## Key Patterns & Implementation Details

### ESM Import Convention
All imports use `.js` extensions (e.g., `import { cfg } from "./config.js"`) as required by NodeNext module resolution, even though source files are `.ts`.

### Adding a New Tool
1. Add Zod schema in `src/schemas.ts`
2. Add tool definition in `src/tools/tool-definitions.ts` (name, description, schema)
3. Create or extend a handler in `src/tools/handlers/`
4. Register handler in `src/tools/handler-map.ts`
5. Add to the appropriate category in `src/tools/tool-registry.ts`
6. Handler signature: `(client: ADTClient, args: Record<string, unknown>) => Promise<ToolResult>` (see `src/types.ts`)

### Parameter Validation
All tools use Zod schemas (in `src/schemas.ts`). Schemas include descriptions visible to clients and enforce type safety. Examples:
- `S_Search`, `S_ReadSource`, `S_WriteSource`, `S_CreateProgram` etc.

### Error Handling
- **MCP Errors**: Use `new McpError(ErrorCode.InvalidRequest, message)` for user-facing errors
- **Safety Guards**: Inline checks like `assertWriteEnabled()`, `assertPackageAllowed()`, `assertCustomerNamespace()`
- **Syntax Check Errors**: Don't activate if syntax errors found; return error list to user without throwing
- **Lock Failures**: Retry with session drop/full logout if lock held from stale session

### Important Implementation Details
- **Related Includes** (READ): `read_abap_source` with `includeRelated=true` recursively includes INCLUDE statements (programs), Include classes/interfaces/test includes (classes), and function modules (function groups)
- **Pretty Print**: Requires NW 7.51+ and abapfs_extensions plugin; skips activation, just formats
- **Concurrency**: Single ADT session means parallel write requests will queue behind the `writeLock` promise chain
- **Short Dumps/Traces**: Only available on NW >= 7.52; older systems will error
- **Code Completion**: System-specific; available if ADT API version supports it

### execute_abap_snippet (Execution Tool)
- Workflow: statische Prüfung → Programm anlegen → Source schreiben → Syntaxcheck → aktivieren → ausführen → löschen
- Cleanup im `finally`-Block — Programm wird IMMER gelöscht, auch bei Laufzeitfehler
- Temporärer Name: ZZ_MCP_<timestamp> in $TMP — kein Transport nötig, zufälliger Suffix verhindert Kollisionen
- Statische Verbotsliste: COMMIT WORK, ROLLBACK, INSERT/UPDATE/DELETE auf DB, BAPI_TRANSACTION_COMMIT
- Erfordert `ALLOW_WRITE=true` **und** `ALLOW_EXECUTE=true` — doppelte Sicherheitsebene
- Wrapped in `withWriteLock` + `withStatefulSession` für Concurrency-Safety
- Bekannte Limitation: Ausgabe-Format hängt von ADT-Version ab (NW 7.52+)

## When to Read DOCUMENTATION.md

The `DOCUMENTATION.md` file (German) contains comprehensive tool reference. Reference it when:
- Adding new tools
- Understanding tool parameter contracts
- Troubleshooting system compatibility issues
- Reviewing security/configuration recommendations

## Documentation Maintenance

When implementing new features or tools, **always update all three documentation files**:
1. **`Updates.md`** — Add a dated entry with feature name, background, technical details, and changed files
2. **`readme.md`** — Update tool counts and add relevant user-facing information
3. **`DOCUMENTATION.md`** — Add full tool reference (parameters, examples, usage notes) in the appropriate section
4. **`CLAUDE.md`** — Update tool counts, categories, and core tool lists if applicable

This ensures documentation stays in sync with the implementation.

## Common Debugging

- **401 Unauthorized**: Check SAP_USER/SAP_PASSWORD/SAP_URL
- **ADT_SRV not found**: SICF not activated (`/sap/bc/adt`)
- **Lock failed**: Object locked by another user; clear in SE03 or wait
- **Write disabled**: ALLOW_WRITE=false in .env
- **Package blocked**: Paket in BLOCKED_PACKAGES; adjust or use different package
- **Connection refused**: VPN, SAP system down, or wrong URL
- **codeCompletion is not a function**: Update `abap-adt-api` version
