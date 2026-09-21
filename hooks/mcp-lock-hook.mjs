#!/usr/bin/env node
// Claude Code hook enforcing the Astra/Claude semaphore on MCP servers.
//
// PreToolUse:                      takes a Claude lock on the server, or denies the call if Astra holds it.
// PostToolUse / PostToolUseFailure: releases the Claude lock.
//
// Configure with matcher "mcp__.*" for the three events; command: node <path>/hooks/mcp-lock-hook.mjs
import { createHash } from "node:crypto";
import { claudeAfterTool, claudeBeforeTool } from "../dist/lock.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

try {
    const input = JSON.parse(raw);
    const match = /^mcp__(.+?)__(.+)$/.exec(input.tool_name ?? "");
    if (!match) process.exit(0);
    const server = match[1];

    // Pre and Post of the same call must derive the same id
    const toolUseId = input.tool_use_id ?? createHash("sha1")
        .update(`${input.session_id}|${input.tool_name}|${JSON.stringify(input.tool_input ?? {})}`)
        .digest("hex")
        .slice(0, 16);

    if (input.hook_event_name === "PreToolUse") {
        const decision = claudeBeforeTool(server, toolUseId);
        if (!decision.allowed) {
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: decision.reason,
                },
            }));
        }
    } else {
        claudeAfterTool(server, toolUseId);
    }
} catch (error) {
    // Never break Claude's tool calls because of the semaphore itself
    process.stderr.write(`mcp-lock-hook: ${error.message}\n`);
}
process.exit(0);
