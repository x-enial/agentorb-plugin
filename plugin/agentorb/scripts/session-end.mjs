#!/usr/bin/env node
/* AgentOrb session end (a SessionEnd hook): this repo no longer has you in it, so the runner may work here again. */
import { clearLive, session } from "./config.mjs";

clearLive(session().root);
