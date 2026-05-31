import type {
  Api,
  Message,
  Model,
  Tool,
  ToolCall,
  TSchema,
  Usage,
} from "@earendil-works/pi-ai";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import type {
  AIMessage,
  BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

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

export const applyStop = (text: string, stop?: string[]) =>
  text.slice(
    0,
    Math.min(
      ...(stop?.map((seq) => text.indexOf(seq)).filter((idx) => idx >= 0) ??
        []),
      text.length,
    ),
  );

export const usageMetadata = (usage: Usage) => ({
  input_tokens: usage.input,
  output_tokens: usage.output,
  total_tokens: usage.totalTokens,
  input_token_details: {
    cache_read: usage.cacheRead,
    cache_creation: usage.cacheWrite,
  },
});

export const responseMetadata = (
  provider: string,
  model: string,
  stopReason: string,
  usage: Usage,
) => ({ provider, model, stopReason, usage, cost: usage.cost });

const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// pi-ai wants JSON Schema (TypeBox already emits it); convertToOpenAITool turns
// any Zod/LangChain tool into JSON Schema, so the cast to TSchema is wire-safe.
export const toPiTool = (tool: BindToolsInput): Tool => {
  const { function: fn } = convertToOpenAITool(tool);
  return {
    name: fn.name,
    description: fn.description ?? "",
    parameters: (fn.parameters ?? {
      type: "object",
      properties: {},
    }) as unknown as TSchema,
  };
};

const toAssistantMessage = (
  message: AIMessage,
  model: Model<Api>,
  timestamp: number,
): Message => {
  const text = contentToText(message.content);
  const calls: ToolCall[] = (message.tool_calls ?? []).map((c) => ({
    type: "toolCall",
    id: c.id ?? "",
    name: c.name,
    arguments: c.args,
  }));
  return {
    role: "assistant",
    content: [...(text ? [{ type: "text" as const, text }] : []), ...calls],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage,
    stopReason: calls.length ? "toolUse" : "stop",
    timestamp,
  };
};

const toToolResult = (message: ToolMessage, timestamp: number): Message => ({
  role: "toolResult",
  toolCallId: message.tool_call_id,
  toolName: message.name ?? "",
  content: [{ type: "text", text: contentToText(message.content) }],
  isError: message.status === "error",
  timestamp,
});

const toUserMessage = (message: BaseMessage, timestamp: number): Message => ({
  role: "user",
  content: contentToText(message.content),
  timestamp,
});

export const buildContext = (
  messages: BaseMessage[],
  model: Model<Api>,
  system?: string,
  tools?: Tool[],
) => {
  const systemPrompts = system ? [system] : [];
  const history: Message[] = [];
  const timestamp = Date.now();

  for (const message of messages) {
    if (message.type === "system" || message.type === "developer")
      systemPrompts.push(contentToText(message.content));
    else if (message.type === "ai")
      history.push(toAssistantMessage(message as AIMessage, model, timestamp));
    else if (message.type === "tool")
      history.push(toToolResult(message as ToolMessage, timestamp));
    else history.push(toUserMessage(message, timestamp));
  }

  return {
    ...(systemPrompts.length
      ? { systemPrompt: systemPrompts.join("\n\n") }
      : {}),
    messages: history,
    ...(tools?.length ? { tools } : {}),
  };
};
