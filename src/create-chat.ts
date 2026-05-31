import { ChatPi, type ChatPiFields } from "./chat-models";
import { ChatOpencode, type ChatOpencodeFields } from "./opencode-chat";

export type CreateChatFields = {
  provider: string;
  model: string;
} & Partial<Omit<ChatPiFields, "provider" | "modelId">> &
  Partial<Omit<ChatOpencodeFields, "model" | "tier">>;

// One entry, routed by provider: opencode / opencode-go → ChatOpencode (native
// OpenAI-compatible Zen), everything else → ChatPi (via pi).
export function createChat(fields: CreateChatFields): ChatPi | ChatOpencode {
  const { provider, model, ...rest } = fields;
  if (provider === "opencode" || provider === "opencode-go") {
    return new ChatOpencode({
      ...rest,
      model,
      tier: provider === "opencode-go" ? "go" : "zen",
    } as unknown as ChatOpencodeFields);
  }
  return new ChatPi({
    ...rest,
    provider,
    modelId: model,
  } as unknown as ChatPiFields);
}
