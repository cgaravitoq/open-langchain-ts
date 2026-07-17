export const CLAUDE_CODE_BASE_URL = "https://api.anthropic.com";

export interface ClaudeCodeModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export const CLAUDE_CODE_MODELS: ClaudeCodeModel[] = [
  {
    id: "claude-fable-5",
    name: "Claude Fable 5 (Claude Code)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 128000,
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8 (Claude Code)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 128000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7 (Claude Code)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 128000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5 (Claude Code)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 128000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Claude Code)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 128000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5 (Claude Code)",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
];

export function findClaudeCodeModel(id: string): ClaudeCodeModel | undefined {
  return CLAUDE_CODE_MODELS.find((m) => m.id === id);
}
