import { ChatClaudeCode, type ChatClaudeCodeFields } from "./claude-code-chat";
import { ChatCodex, type ChatCodexFields } from "./codex-chat";
import { ChatOpencode, type ChatOpencodeFields } from "./opencode-chat";

export type CreateChatFields = {
  provider: string;
  model: string;
} & Partial<Omit<ChatOpencodeFields, "model" | "tier">> &
  Partial<Omit<ChatClaudeCodeFields, "model">> &
  Partial<Omit<ChatCodexFields, "model">>;

// One entry, routed by provider: opencode / opencode-go → ChatOpencode (native
// OpenAI-compatible Zen), claude-code → ChatClaudeCode (native Anthropic via the
// Claude Code subscription), openai-codex → ChatCodex (ChatGPT subscription).
export function createChat(
  fields: CreateChatFields,
): ChatOpencode | ChatClaudeCode | ChatCodex {
  const { provider, model, ...rest } = fields;
  if (provider === "opencode" || provider === "opencode-go") {
    return new ChatOpencode({
      ...rest,
      model,
      tier: provider === "opencode-go" ? "go" : "zen",
    } as unknown as ChatOpencodeFields);
  }
  if (provider === "claude-code") {
    return new ChatClaudeCode({
      ...rest,
      model,
    } as unknown as ChatClaudeCodeFields);
  }
  if (provider === "openai-codex" || provider === "codex") {
    return new ChatCodex({
      ...rest,
      model,
    } as unknown as ChatCodexFields);
  }
  throw new Error(
    `Unknown provider "${provider}". Supported: opencode, opencode-go, claude-code, openai-codex.`,
  );
}
