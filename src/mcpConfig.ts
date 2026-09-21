import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Project .mcp.json that lists the MCP servers Astra may use
const DEFAULT_CONFIG_PATH = "C:/Users/angel/Desktop/EDGELAB/THE_VALLEY/.mcp.json";

// Name under which this server is registered; always excluded to avoid recursion
const SELF_NAME = process.env.ASTRA_SELF_NAME ?? "openai";

export type ChildServerConfig =
    | { name: string; kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
    | { name: string; kind: "http"; url: string; headers: Record<string, string> };

type RawEntry = {
    type?: string;
    transport?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
};

export function getConfigPath(): string {
    return process.env.ASTRA_MCP_CONFIG ?? DEFAULT_CONFIG_PATH;
}

// Normalized path of this server's entry point, used to spot our own entry under any name
function selfScriptPath(): string {
    return path.resolve(fileURLToPath(new URL("./index.js", import.meta.url))).toLowerCase();
}

function isSelf(name: string, entry: RawEntry): boolean {
    if (name === SELF_NAME) return true;
    const self = selfScriptPath();
    return (entry.args ?? []).some(arg => {
        try {
            return path.resolve(arg).toLowerCase() === self;
        } catch {
            return false;
        }
    });
}

export function loadChildServers(): ChildServerConfig[] {
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    const servers: Record<string, RawEntry> = raw.mcpServers ?? {};
    const result: ChildServerConfig[] = [];

    for (const [name, entry] of Object.entries(servers)) {
        if (isSelf(name, entry)) continue;

        const kind = entry.type ?? entry.transport ?? (entry.url ? "http" : "stdio");
        if (kind === "stdio" && entry.command) {
            result.push({ name, kind: "stdio", command: entry.command, args: entry.args ?? [], env: entry.env ?? {} });
        } else if ((kind === "http" || kind === "streamable-http") && entry.url) {
            result.push({ name, kind: "http", url: entry.url, headers: entry.headers ?? {} });
        } else {
            console.error(`[astra] Skipping MCP server "${name}": unsupported transport "${kind}"`);
        }
    }
    return result;
}
