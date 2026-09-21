import { createHash } from "node:crypto";
import { getAllClients, getClient } from "./childManager.js";
import { acquireAstraLock } from "./lock.js";

// Tool results larger than this are truncated before going back to Astra
const MAX_TEXT_CHARS = Number(process.env.ASTRA_MAX_RESULT_CHARS ?? 20_000);
const LOCK_WAIT_MS = Number(process.env.ASTRA_LOCK_WAIT_MS ?? 90_000);
const TOOL_TIMEOUT_MS = Number(process.env.ASTRA_TOOL_TIMEOUT_MS ?? 300_000);

// unreal-mcp toolsets Astra may never call: arbitrary Python execution and simulated UI input
const BLOCKED_UNREAL_TOOLSETS = ["ProgrammaticToolset", "SlateInspectorToolset"];

export type BridgeTool = {
    openaiName: string;
    server: string;
    originalName: string;
    description: string;
    parameters: Record<string, unknown>;
};

// OpenAI tool names must match ^[a-zA-Z0-9_-]{1,64}$
function toOpenAIName(server: string, tool: string): string {
    const name = `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (name.length <= 64) return name;
    const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
    return `${name.slice(0, 55)}_${hash}`;
}

let toolIndex = new Map<string, BridgeTool>();

export async function collectAllTools(allowedServers?: string[]): Promise<BridgeTool[]> {
    const index = new Map<string, BridgeTool>();
    for (const [server, client] of getAllClients()) {
        if (allowedServers && !allowedServers.includes(server)) continue;
        try {
            const { tools } = await client.listTools();
            for (const tool of tools) {
                const openaiName = toOpenAIName(server, tool.name);
                index.set(openaiName, {
                    openaiName,
                    server,
                    originalName: tool.name,
                    description: tool.description ?? "",
                    parameters: tool.inputSchema as Record<string, unknown>,
                });
            }
        } catch (error) {
            console.error(`[astra] listTools failed on "${server}": ${(error as Error).message}`);
        }
    }
    toolIndex = index;
    return [...index.values()];
}

function checkPolicy(tool: BridgeTool, args: Record<string, unknown>): void {
    if (tool.server === "unreal-mcp" && tool.originalName === "call_tool") {
        const toolset = String(args.toolset_name ?? "");
        if (BLOCKED_UNREAL_TOOLSETS.some(blocked => toolset.endsWith(blocked))) {
            throw new Error(`Toolset "${toolset}" is disabled for Astra (policy). Use other toolsets.`);
        }
    }
}

type ContentItem = { type: string; text?: string; mimeType?: string; data?: string; resource?: unknown };

function serializeResult(content: ContentItem[], isError: boolean): string {
    const parts = content.map(item => {
        if (item.type === "text") {
            const text = item.text ?? "";
            if (text.length <= MAX_TEXT_CHARS) return text;
            return `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated: ${text.length - MAX_TEXT_CHARS} more chars omitted]`;
        }
        const size = item.data?.length ?? JSON.stringify(item.resource ?? "").length;
        return `[${item.type} content omitted, size=${size}, type=${item.mimeType ?? "unknown"}]`;
    });
    const text = parts.join("\n");
    return isError ? `TOOL ERROR: ${text}` : text;
}

export async function callTool(openaiName: string, args: Record<string, unknown>): Promise<string> {
    const tool = toolIndex.get(openaiName);
    if (!tool) throw new Error(`Unknown tool: ${openaiName}`);

    checkPolicy(tool, args);
    await acquireAstraLock(tool.server, LOCK_WAIT_MS);

    const result = await getClient(tool.server).callTool(
        { name: tool.originalName, arguments: args },
        undefined,
        { timeout: TOOL_TIMEOUT_MS },
    );
    return serializeResult((result.content ?? []) as ContentItem[], Boolean(result.isError));
}
