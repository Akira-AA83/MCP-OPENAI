import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { ensureChildren } from "./childManager.js";
import { callTool, collectAllTools } from "./toolBridge.js";
import { releaseAllAstraLocks } from "./lock.js";
import { MODEL_PRICES, type SupportedModel } from "./models.js";

const MAX_ITERATIONS = Number(process.env.ASTRA_MAX_ITERATIONS ?? 30);
const MAX_OUTPUT_TOKENS = Number(process.env.ASTRA_MAX_OUTPUT_TOKENS ?? 8000);

const INSTRUCTIONS = `You are Astra, an autonomous investigator working one level below Claude Code.
Claude delegated a task to you. You have direct access to the project's MCP servers through the tools provided
(tool names are prefixed with "<server>__"). Inspect the real state yourself; do not guess what you can check.

For unreal-mcp: call list_toolsets and describe_toolset to discover toolsets and schemas, then call_tool.

You may modify the editor state when a task needs it (e.g. to test whether something works), under these rules:
1. Before changing anything, read and note the original values.
2. After the test, restore every original value and verify the restore by reading it back.
3. Never save assets, levels or packages to disk, and never delete assets. Leave changes in memory only.
4. Keep modifications to the minimum needed to answer the task.

Final answer: reply in the language of the task. Start with a clear verdict, then the evidence you found.
If you modified anything, end with a "Modifications" section listing each change (object, property,
original value, test value) and whether it was restored and verified. If a restore failed, say so explicitly.`;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type ProgressFn = (message: string) => Promise<void>;

export async function investigate(prompt: string, model: SupportedModel, allowedServers: string[] | undefined, progress: ProgressFn): Promise<string> {
    const connection = await ensureChildren();
    const bridgeTools = await collectAllTools(allowedServers);
    if (bridgeTools.length === 0) {
        const failures = connection.failed.map(f => `${f.name}: ${f.error}`).join("; ");
        throw new Error(`No MCP tools available to Astra. ${failures}`);
    }

    const tools = bridgeTools.map(tool => ({
        type: "function" as const,
        name: tool.openaiName,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
    }));

    const input: ResponseInputItem[] = [{ role: "user", content: prompt }];
    const trace: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;

    const footer = () => {
        const price = MODEL_PRICES[model];
        const cost = price
            ? ` (~$${((inputTokens * price.input + outputTokens * price.output) / 1_000_000).toFixed(3)} before cache discount)`
            : " (price unknown for this model)";
        const lines = [
            "",
            "---",
            `Astra trace: model=${model}, servers=${connection.connected.join(", ") || "none"}` +
                (connection.failed.length ? `, unavailable=${connection.failed.map(f => f.name).join(", ")}` : ""),
            `Tokens: ${inputTokens} in (${cachedTokens} cached) / ${outputTokens} out${cost}`,
            `Tool calls (${trace.length}):`,
            ...trace.map(line => `- ${line}`),
        ];
        return lines.join("\n");
    };

    try {
        for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
            await progress(`Astra iteration ${iteration}`);
            const response = await openai.responses.create({
                model,
                instructions: INSTRUCTIONS,
                tools,
                input,
                max_output_tokens: MAX_OUTPUT_TOKENS,
            });
            inputTokens += response.usage?.input_tokens ?? 0;
            outputTokens += response.usage?.output_tokens ?? 0;
            cachedTokens += response.usage?.input_tokens_details?.cached_tokens ?? 0;

            input.push(...(response.output as ResponseInputItem[]));
            const functionCalls = response.output.filter(item => item.type === "function_call");

            if (functionCalls.length === 0) {
                const text = response.output_text || `(no text output, status=${response.status})`;
                return text + footer();
            }

            for (const call of functionCalls) {
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(call.arguments || "{}");
                } catch {
                    // leave args empty; the tool will report missing parameters
                }
                await progress(`Astra → ${call.name}`);

                let output: string;
                try {
                    output = await callTool(call.name, args);
                } catch (error) {
                    output = `ERROR: ${(error as Error).message}`;
                }
                trace.push(`${call.name} ${summarizeArgs(args)}${output.startsWith("ERROR") || output.startsWith("TOOL ERROR") ? " → error" : ""}`);
                input.push({ type: "function_call_output", call_id: call.call_id, output });
            }
        }
        throw new Error(`Astra exceeded ${MAX_ITERATIONS} iterations without completing.${footer()}`);
    } finally {
        releaseAllAstraLocks();
    }
}

function summarizeArgs(args: Record<string, unknown>): string {
    const json = JSON.stringify(args);
    return json.length > 160 ? `${json.slice(0, 157)}...` : json;
}
