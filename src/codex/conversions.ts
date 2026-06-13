import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import type {
  AIMessage,
  BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { thinkingWireValue } from "./models";

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

type AnyRecord = Record<string, unknown>;

function contentToText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      typeof block === "string"
        ? block
        : "text" in block && typeof block.text === "string"
          ? block.text
          : JSON.stringify(block),
    )
    .join("\n");
}

export function applyStop(text: string, stop?: string[]): string {
  if (!stop || stop.length === 0) return text;
  const idxs = stop
    .map((s) => text.indexOf(s))
    .filter((i) => i >= 0);
  return idxs.length ? text.slice(0, Math.min(...idxs)) : text;
}

export function toolToResponses(tool: BindToolsInput): AnyRecord {
  const fn = convertToOpenAITool(tool).function;
  return {
    type: "function",
    name: fn.name,
    description: fn.description ?? "",
    parameters: fn.parameters ?? { type: "object", properties: {} },
    strict: null,
  };
}

function userContent(content: BaseMessage["content"]): AnyRecord[] {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  const blocks: AnyRecord[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      blocks.push({ type: "input_text", text: block });
      continue;
    }
    const btype = block.type;
    if (btype === "text") {
      blocks.push({ type: "input_text", text: block.text ?? "" });
    } else if (btype === "image_url") {
      const imageUrl = (block as { image_url?: { url?: string } | string })
        .image_url;
      const url = typeof imageUrl === "string" ? imageUrl : imageUrl?.url;
      blocks.push({ type: "input_image", image_url: url });
    } else if (btype === "input_text" || btype === "input_image") {
      blocks.push(block as AnyRecord);
    } else {
      blocks.push({ type: "input_text", text: JSON.stringify(block) });
    }
  }
  return blocks;
}

function assistantItems(message: AIMessage): AnyRecord[] {
  const items: AnyRecord[] = [];
  const text = contentToText(message.content);
  if (text) {
    items.push({
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }
  for (const call of message.tool_calls ?? []) {
    items.push({
      type: "function_call",
      name: call.name,
      arguments: JSON.stringify(call.args ?? {}),
      call_id: call.id ?? "",
    });
  }
  return items;
}

function toolResultItem(message: ToolMessage): AnyRecord {
  return {
    type: "function_call_output",
    call_id: message.tool_call_id,
    output: contentToText(message.content),
  };
}

export function messagesToResponses(
  messages: BaseMessage[],
  system?: string,
): { instructions: string; input: AnyRecord[] } {
  const instructionsParts: string[] = system ? [system] : [];
  const input: AnyRecord[] = [];
  for (const message of messages) {
    const kind = message.getType();
    if (kind === "system" || kind === "developer") {
      instructionsParts.push(contentToText(message.content));
    } else if (kind === "ai") {
      input.push(...assistantItems(message as AIMessage));
    } else if (kind === "tool") {
      input.push(toolResultItem(message as ToolMessage));
    } else {
      input.push({ role: "user", content: userContent(message.content) });
    }
  }
  const parts = instructionsParts.filter(Boolean);
  const instructions = parts.length
    ? parts.join("\n\n")
    : DEFAULT_INSTRUCTIONS;
  return { instructions, input };
}

export interface BuildRequestBodyOptions {
  model: string;
  instructions: string;
  input: AnyRecord[];
  tools?: AnyRecord[];
  toolChoice?: unknown;
  reasoningEffort?: string | null;
  sessionId?: string;
}

export function buildRequestBody(options: BuildRequestBodyOptions): AnyRecord {
  const {
    model,
    instructions,
    input,
    tools,
    toolChoice = "auto",
    reasoningEffort,
    sessionId,
  } = options;
  const body: AnyRecord = {
    model,
    store: false,
    stream: true,
    instructions,
    input,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    tool_choice: toolChoice,
    parallel_tool_calls: true,
  };
  if (sessionId) body.prompt_cache_key = sessionId;
  if (tools && tools.length) body.tools = tools;
  const wire = reasoningEffort
    ? thinkingWireValue(model, reasoningEffort)
    : null;
  if (wire !== null) body.reasoning = { effort: wire, summary: "auto" };
  return body;
}

export function toToolCalls(
  raw: AnyRecord[],
): { name: string; args: AnyRecord; id?: string; type: "tool_call" }[] {
  return raw.map((tc) => {
    let args = tc.arguments as unknown;
    if (typeof args === "string") {
      try {
        args = args ? JSON.parse(args) : {};
      } catch {
        args = {};
      }
    }
    return {
      name: tc.name as string,
      args: (args as AnyRecord) ?? {},
      id: (tc.call_id ?? tc.id) as string | undefined,
      type: "tool_call" as const,
    };
  });
}

export function toUsageMetadata(usage?: AnyRecord) {
  if (!usage) return undefined;
  const inputTokens = (usage.input_tokens as number) ?? 0;
  const outputTokens = (usage.output_tokens as number) ?? 0;
  const cached =
    ((usage.input_tokens_details as AnyRecord)?.cached_tokens as number) ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: (usage.total_tokens as number) ?? inputTokens + outputTokens,
    input_token_details: { cache_read: cached, cache_creation: 0 },
  };
}

export function toResponseMetadata(
  model: string,
  stopReason: string | null | undefined,
  usage?: AnyRecord,
): AnyRecord {
  const metadata: AnyRecord = {
    provider: "openai-codex",
    model,
    stopReason: stopReason ?? null,
  };
  if (usage) metadata.usage = usage;
  return metadata;
}
