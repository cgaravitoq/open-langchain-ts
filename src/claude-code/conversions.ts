import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import type {
  AIMessage,
  BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { getModelOverride } from "@cgaravitoq/claude-code-core";

type AnyBlock = Record<string, unknown>;
export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnyBlock[];
};

export const DEFAULT_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 10240,
  high: 20480,
  xhigh: 32768,
  max: 64000,
};

export function toEffort(level: string): string {
  return level === "minimal" ? "low" : level;
}

export function buildThinking(
  modelId: string,
  reasoning: string | undefined,
  modelSupportsReasoning: boolean,
): { thinking?: object; output_config?: object } {
  if (!reasoning || !modelSupportsReasoning) return {};
  const override = getModelOverride(modelId);
  if (override?.adaptiveThinking) {
    // Opus 4.8/4.7 reject a manual budget_tokens with a 400.
    return {
      thinking: { type: "adaptive" },
      output_config: { effort: toEffort(reasoning) },
    };
  }
  return {
    thinking: {
      type: "enabled",
      budget_tokens: DEFAULT_BUDGETS[reasoning] ?? 10240,
    },
  };
}

export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "�");
}

const contentToText = (content: BaseMessage["content"]): string =>
  typeof content === "string"
    ? content
    : content
        .map((block) =>
          typeof block === "string"
            ? block
            : "text" in block && typeof block.text === "string"
              ? block.text
              : JSON.stringify(block),
        )
        .join("\n");

const assistantText = (content: BaseMessage["content"]): string => {
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      typeof block !== "string" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
};

const userBlocks = (
  content: Exclude<BaseMessage["content"], string>,
): AnyBlock[] =>
  content.map((block) => {
    if (typeof block === "string")
      return { type: "text", text: sanitizeSurrogates(block) };
    if (block.type === "text" && typeof block.text === "string")
      return { type: "text", text: sanitizeSurrogates(block.text) };
    if (block.type === "image_url") {
      const imageUrl = (block as { image_url?: { url?: string } | string })
        .image_url;
      const url = typeof imageUrl === "string" ? imageUrl : imageUrl?.url;
      return { type: "image", source: { type: "url", url } };
    }
    if (block.type === "image") return block as AnyBlock;
    return { type: "text", text: JSON.stringify(block) };
  });

const userMessage = (message: BaseMessage): AnthropicMessage | null => {
  if (typeof message.content === "string") {
    const text = sanitizeSurrogates(message.content);
    return text.trim() ? { role: "user", content: text } : null;
  }
  const blocks = userBlocks(message.content);
  return blocks.length ? { role: "user", content: blocks } : null;
};

const assistantMessage = (message: AIMessage): AnthropicMessage => {
  const blocks: AnyBlock[] = [];
  const text = assistantText(message.content);
  if (text.trim())
    blocks.push({ type: "text", text: sanitizeSurrogates(text) });
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id ?? "",
      name: call.name,
      input: call.args ?? {},
    });
  }
  // Drop thinking blocks (their signature is bound to the original turn); keep a
  // placeholder so role alternation survives.
  if (blocks.length === 0) blocks.push({ type: "text", text: "(no content)" });
  return { role: "assistant", content: blocks };
};

const toolResultBlock = (message: ToolMessage): AnyBlock => ({
  type: "tool_result",
  tool_use_id: message.tool_call_id,
  content: sanitizeSurrogates(contentToText(message.content)),
  is_error: message.status === "error",
});

export function toAnthropic(messages: BaseMessage[]): {
  system: string[];
  messages: AnthropicMessage[];
} {
  const system: string[] = [];
  const result: AnthropicMessage[] = [];
  let toolUser: AnthropicMessage | null = null;

  for (const message of messages) {
    const kind = message.getType();
    if (kind === "tool") {
      const block = toolResultBlock(message as ToolMessage);
      if (toolUser && Array.isArray(toolUser.content)) {
        toolUser.content.push(block);
      } else {
        toolUser = { role: "user", content: [block] };
        result.push(toolUser);
      }
      continue;
    }
    toolUser = null;
    if (kind === "system" || kind === "developer") {
      system.push(contentToText(message.content));
    } else if (kind === "ai") {
      result.push(assistantMessage(message as AIMessage));
    } else {
      const user = userMessage(message);
      if (user) result.push(user);
    }
  }

  const last = result[result.length - 1];
  if (
    last &&
    last.role === "user" &&
    Array.isArray(last.content) &&
    last.content.length
  ) {
    const lastBlock = last.content[last.content.length - 1];
    if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
  }

  return { system, messages: result };
}

export function toAnthropicTools(tools: BindToolsInput[]): AnyBlock[] {
  return tools.map((tool) => {
    const fn = convertToOpenAITool(tool).function;
    const params = (fn.parameters ?? {}) as {
      properties?: object;
      required?: string[];
    };
    return {
      name: fn.name,
      description: fn.description ?? "",
      input_schema: {
        type: "object",
        properties: params.properties ?? {},
        required: params.required ?? [],
      },
    };
  });
}

export interface AnthropicUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const usageMetadata = (usage: AnthropicUsage) => ({
  input_tokens: usage.input,
  output_tokens: usage.output,
  total_tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
  input_token_details: {
    cache_read: usage.cacheRead,
    cache_creation: usage.cacheWrite,
  },
});

export const responseMetadata = (
  model: string,
  stopReason: string,
  usage: AnthropicUsage,
) => ({ provider: "claude-code", model, stopReason, usage });

export function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "error";
  }
}

export const applyStop = (text: string, stop?: string[]) =>
  text.slice(
    0,
    Math.min(
      ...(stop?.map((seq) => text.indexOf(seq)).filter((idx) => idx >= 0) ??
        []),
      text.length,
    ),
  );
