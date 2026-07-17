export interface CodexModel {
  name: string;
  input: string[];
  contextWindow: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

const DEFAULTS = {
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", minimal: "low" } as Record<
    string,
    string | null
  >,
  maxTokens: 128000,
};

export const OPENAI_CODEX_MODELS: Record<string, CodexModel> = {
  "gpt-5.3-codex-spark": {
    name: "GPT-5.3 Codex Spark",
    input: ["text"],
    contextWindow: 128000,
    cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  },
  "gpt-5.4": {
    name: "GPT-5.4",
    input: ["text", "image"],
    contextWindow: 272000,
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  },
  "gpt-5.4-mini": {
    name: "GPT-5.4 mini",
    input: ["text", "image"],
    contextWindow: 272000,
    cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  },
  "gpt-5.5": {
    name: "GPT-5.5",
    input: ["text", "image"],
    contextWindow: 272000,
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  },
  "gpt-5.6-sol": {
    name: "GPT-5.6 Sol",
    input: ["text", "image"],
    contextWindow: 1050000,
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  },
  "gpt-5.6-terra": {
    name: "GPT-5.6 Terra",
    input: ["text", "image"],
    contextWindow: 1050000,
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  },
  "gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    input: ["text", "image"],
    contextWindow: 1050000,
    cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 },
  },
};

export const EXTENDED_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function getSupportedThinkingLevels(_model: string): string[] {
  if (!DEFAULTS.reasoning) return ["off"];
  const levelMap = DEFAULTS.thinkingLevelMap;
  const supported: string[] = [];
  for (const level of EXTENDED_THINKING_LEVELS) {
    if (level in levelMap && levelMap[level] === null) continue;
    if (level === "xhigh" && !(level in levelMap)) continue;
    supported.push(level);
  }
  return supported;
}

export function clampThinkingLevel(model: string, level: string): string {
  const available = getSupportedThinkingLevels(model);
  if (available.includes(level)) return level;
  const idx = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (idx === -1) return available[0] ?? "off";
  for (const candidate of EXTENDED_THINKING_LEVELS.slice(idx)) {
    if (available.includes(candidate)) return candidate;
  }
  for (const candidate of EXTENDED_THINKING_LEVELS.slice(0, idx).reverse()) {
    if (available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}

// Map a canonical level to the value sent in the request. "off" -> null (omit).
export function thinkingWireValue(model: string, level: string): string | null {
  if (level === "off") return null;
  const levelMap = DEFAULTS.thinkingLevelMap;
  const has = level in levelMap;
  const mapped = has ? (levelMap[level] as string | null) : null;
  if (mapped === null && !has) return level;
  return mapped;
}
