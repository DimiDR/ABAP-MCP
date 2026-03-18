# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ABAP MCP Server v2 is a standalone Model Context Protocol (MCP) server that enables AI assistants (Claude, Copilot, Cursor) to interact with SAP ABAP systems via the ADT REST API. It implements 45 tools across 12 categories + 1 meta-tool (`find_tools`) + 1 MCP Prompt (`abap_develop`) for full ABAP development workflow support.

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
- Output: CommonJS modules to `dist/`

## Architecture

### Single-Entry Point Pattern
- **Entry**: `src/index.ts` — monolithic server (no modularization needed at this scale)
- **Connection**: Lazy-initialized single `ADTClient` instance reused across all tool calls
- **Transport**: stdio-based MCP protocol with `@modelcontextprotocol/sdk`

### Concurrency & Session Management
- **Write Lock**: Serial execution of write operations (`withWriteLock()`) to prevent concurrent ADT lock conflicts
- **Stateful Sessions**: Write workflows use stateful mode for complex lock → write → activate sequences
- **Lock Recovery**: Automatic retry logic for stale locks (drops session, full logout/login if needed)

### Tool Architecture
- **Schema Validation**: Zod for all tool parameters (30+ schemas defined inline)
- **Tool Groups**: SEARCH, READ, WRITE, CREATE, DELETE, TEST, QUALITY, DIAGNOSTICS, TRANSPORT, ABAPGIT, QUERY, DOCUMENTATION
- **Deferred Loading** (default): Only 9 core tools (`search_abap_objects`, `read_abap_source`, `write_abap_source`, `get_object_info`, `where_used`, `analyze_abap_context`, `search_abap_syntax`, `validate_ddic_references`, `find_tools`) loaded initially; others activated on-demand via `find_tools` meta-tool (~75-80% token savings)
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
- `DEFER_TOOLS=false`: Load all 45 tools upfront (higher initial token cost)

## Key Patterns & Implementation Details

### Parameter Validation
All tools use Zod schemas (defined near line 185). Schemas include descriptions visible to clients and enforce type safety. Examples:
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

## Important Context from Documentation

- **45 Tools in 12 Groups + 1 Meta-Tool + 1 Prompt**: Full lifecycle coverage (search → read → write → test → quality → deployment → documentation)
- **ADT-Based**: Uses `/sap/bc/adt/*` endpoints (SICF must be active on SAP side)
- **Write Safety**: Lock conflicts prevented by serial execution; syntax errors block activation; incomplete unlocks logged for manual recovery (SE03)
- **Token Budget**: Default deferred mode targets ~75% reduction in tokens per `tools/list` call
- **Namespace Protection**: Z/Y prefixes enforced for creation; customer packages checked against `BLOCKED_PACKAGES`

## When to Read DOCUMENTATION.md

The `DOCUMENTATION.md` file (German) contains comprehensive tool reference. Reference it when:
- Adding new tools
- Understanding tool parameter contracts
- Troubleshooting system compatibility issues
- Reviewing security/configuration recommendations

## Common Debugging

- **401 Unauthorized**: Check SAP_USER/SAP_PASSWORD/SAP_URL
- **ADT_SRV not found**: SICF not activated (`/sap/bc/adt`)
- **Lock failed**: Object locked by another user; clear in SE03 or wait
- **Write disabled**: ALLOW_WRITE=false in .env
- **Package blocked**: Paket in BLOCKED_PACKAGES; adjust or use different package
- **Connection refused**: VPN, SAP system down, or wrong URL
- **codeCompletion is not a function**: Update `abap-adt-api` version
