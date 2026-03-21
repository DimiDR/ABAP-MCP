/**
 * ABAPGIT tool handlers: get_abapgit_repos, abapgit_pull
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_GitRepos, S_GitPull } from "../../schemas.js";
import { assertWriteEnabled } from "../../safety.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }

export async function handleGetAbapgitRepos(client: ADTClient, _args: Record<string, unknown>): Promise<ToolResult> {
  const res = await client.gitRepos();
  const repos = Array.isArray(res) ? res : (res ? [res] : []);
  return ok(repos.length === 0
    ? "No abapGit repositories configured."
    : `${repos.length} repository/repositories:\n\n${JSON.stringify(repos, null, 2)}`);
}

export async function handleAbapgitPull(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled("abapGit pull");
  const p = S_GitPull.parse(args);
  const res = await client.gitPullRepo(p.repoId, undefined, p.transport || undefined);
  return ok(`✅ abapGit pull executed\n${JSON.stringify(res, null, 2)}`);
}
