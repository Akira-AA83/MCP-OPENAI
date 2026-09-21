#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
    McpError,
    ErrorCode,
    TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { investigate } from "./astraLoop.js";
import { shutdownAll } from "./childManager.js";
import { releaseAllAstraLocks } from "./lock.js";
import { DEFAULT_TIER, SUPPORTED_MODELS, TIER_DESCRIPTION, TIER_NAMES, resolveModel, type SupportedModel } from "./models.js";

// Initialize OpenAI client
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is required");
}

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});


// Define available tools
const TOOLS: Tool[] = [
    {
        name: "openai_chat",
        description: `Use this tool when a user specifically requests to use one of OpenAI's models (${SUPPORTED_MODELS.join(", ")}). This tool sends messages to OpenAI's chat completion API using the specified model.`,
        inputSchema: {
            type: "object",
            properties: {
                messages: {
                    type: "array",
                    description: "Array of messages to send to the API",
                    items: {
                        type: "object",
                        properties: {
                            role: {
                                type: "string",
                                enum: ["system", "user", "assistant"],
                                description: "Role of the message sender"
                            },
                            content: {
                                type: "string",
                                description: "Content of the message"
                            }
                        },
                        required: ["role", "content"]
                    }
                },
                tier: {
                    type: "string",
                    enum: TIER_NAMES,
                    description: TIER_DESCRIPTION,
                    default: DEFAULT_TIER
                },
                model: {
                    type: "string",
                    enum: SUPPORTED_MODELS,
                    description: `Optional exact model; overrides tier (${SUPPORTED_MODELS.join(", ")})`
                }
            },
            required: ["messages"]
        }
    },
    {
        name: "astra_investigate",
        description: "Delegate an investigation to an autonomous OpenAI agent (tier \"deep\" = GPT-6 Astra). The agent has direct access to the project's MCP servers (unreal-mcp, perplexity, ...) and calls them on its own to answer the prompt. It may modify editor state to test something, but restores original values, never saves to disk, and lists every modification in its answer. While it runs, the MCP servers it uses are locked for Claude Code. Use for independent second-opinion reviews, audits and verifications. Slow (30s-several minutes). Default tier is \"reason\"; request \"deep\" only for critical audits.",
        inputSchema: {
            type: "object",
            properties: {
                prompt: {
                    type: "string",
                    description: "The task for Astra. Be specific; Astra decides which MCP tools to call. Examples: 'verify PCG_CliffRockScatter has a sensible slope filter', 'search recent UE 5.8 PCG best practices'."
                },
                allowedServers: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional. Restrict Astra to these MCP servers (e.g. [\"unreal-mcp\"]). Default: all project servers."
                },
                tier: {
                    type: "string",
                    enum: TIER_NAMES,
                    description: TIER_DESCRIPTION,
                    default: DEFAULT_TIER
                },
                model: {
                    type: "string",
                    enum: SUPPORTED_MODELS,
                    description: `Optional exact model driving the investigation; overrides tier (${SUPPORTED_MODELS.join(", ")})`
                }
            },
            required: ["prompt"]
        }
    }
];

// Initialize MCP server
const server = new Server(
    {
        name: "mcp-openai",
        version: "0.2.0",
    },
    {
        capabilities: {
            tools: {}
        }
    }
);

// Register handler for tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
}));

// Register handler for tool execution
server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<{
    content: TextContent[];
    isError?: boolean;
}> => {
    switch (request.params.name) {
        case "openai_chat": {
            try {
                // Parse request arguments
                const { messages: rawMessages, model: requestedModel, tier } = request.params.arguments as {
                    messages: Array<{ role: string; content: string }>;
                    model?: string;
                    tier?: string;
                };
                const model = resolveModel(requestedModel, tier);

                // Convert messages to OpenAI's expected format
                const messages: ChatCompletionMessageParam[] = rawMessages.map(msg => ({
                    role: msg.role as "system" | "user" | "assistant",
                    content: msg.content
                }));

                // Call OpenAI API with fixed temperature
                const completion = await openai.chat.completions.create({
                    messages,
                    model
                });

                // Return the response
                return {
                    content: [{
                        type: "text",
                        text: completion.choices[0]?.message?.content || "No response received"
                    }]
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: `OpenAI API error: ${(error as Error).message}`
                    }],
                    isError: true
                };
            }
        }
        case "astra_investigate": {
            const { prompt, allowedServers, model: requestedModel, tier } = request.params.arguments as {
                prompt: string;
                allowedServers?: string[];
                model?: string;
                tier?: string;
            };
            let model: SupportedModel;
            try {
                model = resolveModel(requestedModel, tier);
            } catch (error) {
                return { content: [{ type: "text", text: (error as Error).message }], isError: true };
            }
            const progressToken = request.params._meta?.progressToken;
            let step = 0;
            const progress = async (message: string) => {
                console.error(`[astra] ${message}`);
                if (progressToken === undefined) return;
                await extra.sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: ++step, message },
                }).catch(() => {});
            };

            try {
                const answer = await investigate(prompt, model, allowedServers, progress);
                return { content: [{ type: "text", text: answer }] };
            } catch (error) {
                return {
                    content: [{ type: "text", text: `Astra investigation error: ${(error as Error).message}` }],
                    isError: true
                };
            }
        }
        default:
            throw new McpError(
                ErrorCode.MethodNotFound,
                `Unknown tool: ${request.params.name}`
            );
    }
});

// Initialize MCP server connection using stdio transport
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});

// Release Astra locks and close child MCP servers on shutdown
process.on("exit", releaseAllAstraLocks);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        releaseAllAstraLocks();
        await shutdownAll();
        process.exit(0);
    });
}
server.onclose = async () => {
    releaseAllAstraLocks();
    await shutdownAll();
    process.exit(0);
};