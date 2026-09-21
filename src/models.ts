// Models verified on 2026-09-21 against this account for both Chat Completions (openai_chat)
// and Responses API with function calling (astra_investigate). Re-verify before adding new ones.
export const SUPPORTED_MODELS = [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5",
    "gpt-5-mini",
    "o3",
    "o4-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
] as const;

export type SupportedModel = typeof SUPPORTED_MODELS[number];

// Cost/quality tiers; an explicit `model` argument overrides the tier
export const TIERS = {
    fast: "gpt-5-mini",
    reason: "gpt-5",
    deep: "gpt-6-astra",
} as const satisfies Record<string, SupportedModel>;

export type Tier = keyof typeof TIERS;

// Never default to the expensive tier: callers must ask for "deep" explicitly
export const DEFAULT_TIER: Tier = "reason";

export const TIER_NAMES = Object.keys(TIERS) as Tier[];

export const TIER_DESCRIPTION = `Cost/quality tier: ${TIER_NAMES.map(t => `"${t}" = ${TIERS[t]}`).join(", ")}. ` +
    `Default "${DEFAULT_TIER}". Use "deep" (gpt-6-astra, expensive) only for critical audits; "fast" for trivial tasks.`;

export function isSupportedModel(model: string): model is SupportedModel {
    return (SUPPORTED_MODELS as readonly string[]).includes(model);
}

// Picks the model from an explicit model, else the tier, else the default tier
export function resolveModel(model?: string, tier?: string): SupportedModel {
    if (model !== undefined) {
        if (!isSupportedModel(model)) {
            throw new Error(`Unsupported model: ${model}. Must be one of: ${SUPPORTED_MODELS.join(", ")}`);
        }
        return model;
    }
    const chosen = tier ?? DEFAULT_TIER;
    if (!(chosen in TIERS)) {
        throw new Error(`Unsupported tier: ${chosen}. Must be one of: ${TIER_NAMES.join(", ")}`);
    }
    return TIERS[chosen as Tier];
}

// USD per million tokens (input, output) for the cost estimate; models without an entry show tokens only
export const MODEL_PRICES: Partial<Record<SupportedModel, { input: number; output: number }>> = {
    "gpt-6-astra": { input: 10, output: 50 },
};
