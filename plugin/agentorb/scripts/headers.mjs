#!/usr/bin/env node
/*
 * The MCP connection's headers (Claude Code's headersHelper): this repo's own agent key (.agentorb.local.json, found
 * from the session's directory) as the Authorization header. Without one it prints no headers, and the static
 * "Bearer ${AGENTORB_KEY}" in .mcp.json applies (Claude Code doesn't hand that variable to helpers, so the global key
 * is left to the static header). Never logs the key.
 */
import { session } from "./config.mjs";

const me = session();
process.stdout.write(JSON.stringify(me.keySource === "repo" ? { Authorization: `Bearer ${me.key}` } : {}));
