import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import {
  type AnthropicUsage,
  applyStop,
  buildThinking,
  mapStopReason,
  responseMetadata,
  sanitizeSurrogates,
  toAnthropic,
  toAnthropicTools,
  usageMetadata,
} from "./claude-code/conversions";
import {
  applyClaudeCodeTransforms,
  type ClaudeCodeCreds,
  config,
  forceRefreshClaudeCodeCreds,
  readClaudeCodeCreds,
  refreshClaudeCodeCreds,
  requestBetas,
  SYSTEM_IDENTITY,
  unprefixToolName,
} from "@cgaravitoq/claude-code-core";
import {
  CLAUDE_CODE_BASE_URL,
  findClaudeCodeModel,
} from "./claude-code/models";

export type ReasoningLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ChatClaudeCodeFields = BaseChatModelParams & {
  model: string;
  reasoning?: ReasoningLevel;
  system?: string;
  maxTokens?: number;
  longContext?: boolean;
};

export type ChatClaudeCodeCallOptions = BaseChatModelCallOptions & {
  tools?: BindToolsInput[];
};

type ToolBlock = { id: string; name: string; partialJson: string };

export class ChatClaudeCode extends BaseChatModel<ChatClaudeCodeCallOptions> {
  model: string;
  reasoning: ReasoningLevel;
  system?: string;
  maxTokens?: number;
  longContext: boolean;

  constructor(fields: ChatClaudeCodeFields) {
    super(fields);
    this.model = fields.model;
    this.reasoning = fields.reasoning ?? "medium";
    this.system = fields.system;
    this.maxTokens = fields.maxTokens;
    this.longContext = fields.longContext ?? false;
  }

  _llmType() {
    return "claude-code";
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<ChatClaudeCodeCallOptions>,
  ): Runnable<
    BaseLanguageModelInput,
    AIMessageChunk,
    ChatClaudeCodeCallOptions
  > {
    return this.withConfig({ tools, ...kwargs });
  }

  private async getCreds(): Promise<ClaudeCodeCreds> {
    const creds = readClaudeCodeCreds();
    if (!creds)
      throw new Error(
        "No Claude Code credentials found. Run `claude` once to log in, then retry.",
      );
    return refreshClaudeCodeCreds(creds);
  }

  private buildParams(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): { params: MessageCreateParamsStreaming; toolNames: string[] } {
    const model = findClaudeCodeModel(this.model);
    if (!model) throw new Error(`Unknown claude-code model "${this.model}"`);

    const { system: systemTexts, messages: anthropicMessages } =
      toAnthropic(messages);

    const systemEntries: Record<string, unknown>[] = [
      {
        type: "text",
        text: SYSTEM_IDENTITY,
        cache_control: { type: "ephemeral" },
      },
    ];
    for (const text of [this.system, ...systemTexts]) {
      if (text)
        systemEntries.push({
          type: "text",
          text: sanitizeSurrogates(text),
          cache_control: { type: "ephemeral" },
        });
    }

    const anthropicTools = options.tools?.length
      ? toAnthropicTools(options.tools)
      : undefined;
    const toolNames = anthropicTools?.map((t) => String(t.name)) ?? [];

    let params: Record<string, unknown> = {
      model: this.model,
      messages: anthropicMessages,
      max_tokens: this.maxTokens ?? Math.floor(model.maxTokens / 3),
      stream: true,
      system: systemEntries,
      ...buildThinking(this.model, this.reasoning, model.reasoning),
    };
    if (anthropicTools) params.tools = anthropicTools;
    if (options.stop?.length) params.stop_sequences = options.stop;

    params = applyClaudeCodeTransforms(params);
    return {
      params: params as unknown as MessageCreateParamsStreaming,
      toolNames,
    };
  }

  private makeClient(token: string): Anthropic {
    const version = process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion;
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "sdk-cli";
    const userAgent =
      process.env.ANTHROPIC_USER_AGENT ??
      `claude-cli/${version} (external, ${entrypoint})`;

    return new Anthropic({
      baseURL: CLAUDE_CODE_BASE_URL,
      apiKey: null,
      authToken: token,
      defaultHeaders: {
        accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        "anthropic-beta": requestBetas(this.model, this.longContext).join(","),
        "user-agent": userAgent,
        "x-app": "cli",
      },
    });
  }

  private async openStream(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ) {
    let creds = await this.getCreds();
    const { params, toolNames } = this.buildParams(messages, options);
    const create = (token: string) =>
      this.makeClient(token).messages.create(
        { ...params },
        { signal: options.signal },
      );

    try {
      return { stream: await create(creds.accessToken), toolNames };
    } catch (err) {
      // A timestamp-fresh token can still be rejected (revoked/rotated
      // out-of-band); force one refresh and retry, mirroring the Python 401 path.
      if (err instanceof Anthropic.APIError && err.status === 401) {
        creds = await forceRefreshClaudeCodeCreds(creds);
        return { stream: await create(creds.accessToken), toolNames };
      }
      throw err;
    }
  }

  private resolveToolName(name: string, toolNames: string[]): string {
    const stripped = unprefixToolName(name);
    const lower = stripped.toLowerCase();
    return toolNames.find((n) => n.toLowerCase() === lower) ?? stripped;
  }

  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]) {
    const { stream, toolNames } = await this.openStream(messages, options);

    let text = "";
    const toolCalls: { id: string; name: string; args: unknown }[] = [];
    const toolState = new Map<number, ToolBlock>();
    const usage: AnthropicUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    let stopReason = "stop";

    for await (const event of stream) {
      if (event.type === "message_start") {
        const u = event.message.usage;
        usage.input = u.input_tokens ?? 0;
        usage.output = u.output_tokens ?? 0;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          toolState.set(event.index, {
            id: event.content_block.id,
            name: this.resolveToolName(event.content_block.name, toolNames),
            partialJson: "",
          });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          text += event.delta.text;
        } else if (event.delta.type === "input_json_delta") {
          const block = toolState.get(event.index);
          if (block) block.partialJson += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        const block = toolState.get(event.index);
        if (block) {
          let args: unknown = {};
          try {
            args = JSON.parse(block.partialJson || "{}");
          } catch {
            args = {};
          }
          toolCalls.push({ id: block.id, name: block.name, args });
        }
      } else if (event.type === "message_delta") {
        if (event.delta.stop_reason)
          stopReason = mapStopReason(event.delta.stop_reason);
        if (typeof event.usage.output_tokens === "number")
          usage.output = event.usage.output_tokens;
      }
    }

    const finalText = applyStop(text, options.stop);
    const tool_calls = toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      args: (c.args ?? {}) as Record<string, unknown>,
      type: "tool_call" as const,
    }));
    const metadata = responseMetadata(this.model, stopReason, usage);
    const message = new AIMessage({
      content: finalText,
      tool_calls,
      response_metadata: metadata,
      usage_metadata: usageMetadata(usage),
    });

    return {
      generations: [{ text: finalText, message, generationInfo: metadata }],
      llmOutput: metadata,
    };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ) {
    const { stream, toolNames } = await this.openStream(messages, options);
    const toolState = new Map<number, ToolBlock>();
    const usage: AnthropicUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    let stopReason = "stop";

    for await (const event of stream) {
      if (event.type === "message_start") {
        const u = event.message.usage;
        usage.input = u.input_tokens ?? 0;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          toolState.set(event.index, {
            id: event.content_block.id,
            name: this.resolveToolName(event.content_block.name, toolNames),
            partialJson: "",
          });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          const delta = event.delta.text;
          yield new ChatGenerationChunk({
            text: delta,
            message: new AIMessageChunk({ content: delta }),
          });
          await runManager?.handleLLMNewToken(delta);
        } else if (event.delta.type === "input_json_delta") {
          const block = toolState.get(event.index);
          if (block) block.partialJson += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        const block = toolState.get(event.index);
        if (block) {
          yield new ChatGenerationChunk({
            text: "",
            message: new AIMessageChunk({
              content: "",
              tool_call_chunks: [
                {
                  id: block.id,
                  name: block.name,
                  args: block.partialJson || "{}",
                  index: event.index,
                  type: "tool_call_chunk",
                },
              ],
            }),
          });
        }
      } else if (event.type === "message_delta") {
        if (event.delta.stop_reason)
          stopReason = mapStopReason(event.delta.stop_reason);
        if (typeof event.usage.output_tokens === "number")
          usage.output = event.usage.output_tokens;
      }
    }

    const metadata = responseMetadata(this.model, stopReason, usage);
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({
        content: "",
        response_metadata: metadata,
        usage_metadata: usageMetadata(usage),
      }),
    });
  }
}
