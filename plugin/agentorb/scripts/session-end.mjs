#!/usr/bin/env node
/* AgentOrb session end (a SessionEnd hook): this repo no longer has you in it, so the runner may work here again. */
import { readFileSync } from "node:fs";
import { clearLive, session } from "./config.mjs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  /* no stdin */
}
const me = session();
clearLive(me.root, me.key, input.session_id);
