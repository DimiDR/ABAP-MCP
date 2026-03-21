/**
 * CREATE tool handlers: all 7 create_* tools
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_CreateProgram, S_CreateClass, S_CreateInterface, S_CreateFunctionGroup, S_CreateCdsView, S_CreateTable, S_CreateMessageClass } from "../../schemas.js";
import { ADT_PACKAGES, ADT_PROGRAMS, ADT_CLASSES, ADT_INTERFACES, ADT_FUNCTION_GROUPS, ADT_DDIC_DDL_SOURCES, ADT_DDIC_TABLES } from "../../adt-endpoints.js";
import { assertWriteEnabled, assertPackageAllowed, assertCustomerNamespace } from "../../safety.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }

export async function handleCreateAbapProgram(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_CreateProgram.parse(args);
  assertPackageAllowed(p.devClass);
  assertCustomerNamespace(p.name, ["Z", "Y"]);
  const n = p.name.toUpperCase();
  const progType = p.programType ?? "P";
  await client.createObject(`PROG/${progType}`, n, p.devClass, p.description, `${ADT_PACKAGES}/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
  const url = `${ADT_PROGRAMS}/${n.toLowerCase()}`;
  const label = progType === "I" ? "Include" : "Program";
  return ok(`✅ ${label} '${n}' created\nURI: ${url}\n\nNext steps:\n  write_abap_source with objectUrl='${url}'`);
}

export async function handleCreateAbapClass(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_CreateClass.parse(args);
  assertPackageAllowed(p.devClass);
  assertCustomerNamespace(p.name, ["ZCL_", "YCL_"]);
  const n = p.name.toUpperCase();
  await client.createObject("CLAS/OC", n, p.devClass, p.description, `${ADT_PACKAGES}/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
  const url = `${ADT_CLASSES}/${n.toLowerCase()}`;
  return ok(`✅ Class '${n}' created\nURI: ${url}\n\nNext steps:\n  read_abap_source → write_abap_source`);
}

export async function handleCreateAbapInterface(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_CreateInterface.parse(args);
  assertPackageAllowed(p.devClass);
  assertCustomerNamespace(p.name, ["ZIF_", "YIF_"]);
  const n = p.name.toUpperCase();
  await client.createObject("INTF/OI", n, p.devClass, p.description, `${ADT_PACKAGES}/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
  const url = `${ADT_INTERFACES}/${n.toLowerCase()}`;
  return ok(`✅ Interface '${n}' created\nURI: ${url}`);
}

export async function handleCreateFunctionGroup(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_CreateFunctionGroup.parse(args);
  assertPackageAllowed(p.devClass);
  assertCustomerNamespace(p.name, ["Z", "Y"]);
  const n = p.name.toUpperCase();
  await client.createObject("FUGR/F", n, p.devClass, p.description, `${ADT_PACKAGES}/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
  const url = `${ADT_FUNCTION_GROUPS}/${n.toLowerCase()}`;
  return ok(`✅ Function group '${n}' created\nURI: ${url}`);
}

export async function handleCreateCdsView(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_CreateCdsView.parse(args);
  assertPackageAllowed(p.devClass);
  assertCustomerNamespace(p.name, ["Z", "Y"]);
  const n = p.name.toUpperCase();
  await client.createObject("DDLS/DF", n, p.devClass, p.description, `${ADT_PACKAGES}/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
  const url = `${ADT_DDIC_DDL_SOURCES}/${n.toLowerCase()}`;
  return ok(`✅ CDS View '${n}' created\nURI: ${url}`);
}

export async function handleCreateDatabaseTable(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_CreateTable.parse(args);
  assertPackageAllowed(p.devClass);
  assertCustomerNamespace(p.name, ["Z", "Y"]);
  const n = p.name.toUpperCase();
  await client.createObject("TABL/DT", n, p.devClass, p.description, `${ADT_PACKAGES}/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
  const url = `${ADT_DDIC_TABLES}/${n.toLowerCase()}`;
  return ok(`✅ Table '${n}' created\nURI: ${url}`);
}

export async function handleCreateMessageClass(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_CreateMessageClass.parse(args);
  assertPackageAllowed(p.devClass);
  assertCustomerNamespace(p.name, ["Z", "Y"]);
  const n = p.name.toUpperCase();
  await client.createObject("MSAG/N", n, p.devClass, p.description, `${ADT_PACKAGES}/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
  return ok(`✅ Message class '${n}' created`);
}
