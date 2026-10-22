/*
 * The sent marker (0099): what the outbound gate matched, kept between the two hooks of one tool call. pre-tool.mjs
 * writes it when the board approves a send tool's text (the card and the part ids the board matched, and the server
 * the tool belongs to); post-tool.mjs reads and removes it once the tool has run, and reports the send on the board's
 * ledger so the agent needn't call report_sent itself.
 *
 * One file per call under ~/.claude/agentorb/sent/, named by a hash of the key, the tool and the strings it was given:
 * both hooks see the same input, so both compute the same name, and nothing else is written there (never the key or
 * the texts). A marker left behind (a tool that failed, or was stopped before it ran) is ignored after MAX_AGE_MS and
 * pruned on the next write.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_AGE_MS = 15 * 60_000;
export const sentDir = () => join(homedir(), ".claude", "agentorb", "sent");

/** Every string in a tool's input, as the gate sees them (at most 50, each capped). */
export function stringsIn(v, out = [], depth = 0) {
  if (out.length >= 50 || depth > 6) return out;
  if (typeof v === "string") out.push(v.slice(0, 100_000));
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringsIn(x, out, depth + 1);
  return out;
}

/**
 * The same strings with where each was in the tool's input (0103): text, attachments[0], message.to. The board checks
 * by field: the largest is the message and must be approved; a recipient field is checked against the part's
 * addresses. Same caps and order as stringsIn, so the two lists line up.
 */
export function fieldsIn(v, path = "", out = [], depth = 0) {
  if (out.length >= 50 || depth > 6) return out;
  if (typeof v === "string") out.push({ path: (path || "$").slice(0, 200), value: v.slice(0, 100_000) });
  else if (Array.isArray(v)) v.forEach((x, i) => fieldsIn(x, `${path}[${i}]`, out, depth + 1));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) fieldsIn(x, path ? `${path}.${k}` : k, out, depth + 1);
  return out;
}

export function sentMarkerPath(key, tool, texts) {
  const h = createHash("sha256");
  h.update(String(key ?? "")).update("\0").update(String(tool ?? ""));
  for (const t of texts) h.update("\0").update(t);
  return join(sentDir(), `${h.digest("hex").slice(0, 32)}.json`);
}

/** Best effort: a marker that can't be written only means the agent reports the send itself. */
export function writeSentMarker(file, marker) {
  try {
    mkdirSync(sentDir(), { recursive: true });
    writeFileSync(file, JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

/** The marker, or null when there is none, it is stale, or it can't be read. Removes it either way. */
export function takeSentMarker(file) {
  let marker = null;
  try {
    const fresh = Date.now() - statSync(file).mtimeMs < MAX_AGE_MS;
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (fresh && j && typeof j.card === "string" && Array.isArray(j.parts) && j.parts.length) marker = j;
  } catch {
    /* none */
  }
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
  return marker;
}

/** Drop markers nothing will read: older than MAX_AGE_MS. Cheap: the folder holds a handful at most. */
export function pruneSentMarkers() {
  try {
    const dir = sentDir();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = join(dir, f);
      try {
        if (Date.now() - statSync(p).mtimeMs > MAX_AGE_MS) unlinkSync(p);
      } catch {
        /* gone */
      }
    }
  } catch {
    /* no folder yet */
  }
}
