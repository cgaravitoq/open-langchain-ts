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
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import { CodexAuth } from "./codex/auth";
import { CodexClient } from "./codex/client";
import { DEFAULT_CODEX_BASE_URL } from "./codex/constants";
import {
  applyStop,
  buildRequestBody,
  messagesToResponses,
  toResponseMetadata,
  toToolCalls,
  toUsageMetadata,
  toolToResponses,
} from "./codex/conversions";
import { clampThinkingLevel } from "./codex/models";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

type AnyRecord = Record<string, unknown>;

export type ChatCodexFields = BaseChatModelParams & {
  model: string;
  reasoning?: string;
  system?: string;
  authPath?: string;
  baseUrl?: string;
  sessionId?: string;
};

export type ChatCodexCallOptions = BaseChatModelCallOptions & {
  tools?: AnyRecord[];
  tool_choice?: unknown;
};

export class ChatCodex extends BaseChatModel<ChatCodexCallOptions> {
  model: string;
  reasoning: string;
  system?: string;
  authPath?: string;
  baseUrl: string;
  sessionId?: string;
  private client?: CodexClient;

  constructor(fields: ChatCodexFields) {
    super(fields);
    this.model = fields.model;
    this.reasoning = fields.reasoning ?? "low";
    this.system = fields.system ?? DEFAULT_SYSTEM_PROMPT;
    this.authPath = fields.authPath;
    this.baseUrl = fields.baseUrl ?? DEFAULT_CODEX_BASE_URL;
    this.sessionId = fields.sessionId;
  }

  _llmType() {
    return "openai-codex";
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<ChatCodexCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, ChatCodexCallOptions> {
    return this.withConfig({ tools: tools.map(toolToResponses), ...kwargs });
  }

  private getClient(): CodexClient {
    if (!this.client) {
      this.client = new CodexClient(new CodexAuth(this.authPath), this.baseUrl);
    }
    return this.client;
  }

  private buildBody(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): AnyRecord {
    const { instructions, input } = messagesToResponses(messages, this.system);
    const effort = clampThinkingLevel(this.model, this.reasoning);
    return buildRequestBody({
      model: this.model,
      instructions,
      input,
      tools: options.tools,
      toolChoice: options.tool_choice,
      reasoningEffort: effort,
      sessionId: this.sessionId,
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const textParts: string[] = [];
    const rawToolCalls: AnyRecord[] = [];
    let usage: AnyRecord | undefined;
    let stopReason: string | undefined;

    const body = this.buildBody(messages, options);
    for await (const event of this.getClient().stream(
      body,
      this.sessionId,
      options.signal,
    )) {
      if (event.type === "text_delta") textParts.push(event.delta);
      else if (event.type === "tool_call") rawToolCalls.push(event.tool_call);
      else if (event.type === "done") {
        usage = event.usage;
        stopReason = event.stop_reason;
      }
    }

    const text = applyStop(textParts.join(""), options.stop);
    const message = new AIMessage({
      content: text,
      tool_calls: toToolCalls(rawToolCalls),
      usage_metadata: toUsageMetadata(usage),
      response_metadata: toResponseMetadata(this.model, stopReason, usage),
    });
    return { generations: [{ text, message }] };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const body = this.buildBody(messages, options);
    for await (const event of this.getClient().stream(
      body,
      this.sessionId,
      options.signal,
    )) {
      if (event.type === "text_delta") {
        await runManager?.handleLLMNewToken(event.delta);
        yield new ChatGenerationChunk({
          text: event.delta,
          message: new AIMessageChunk({ content: event.delta }),
        });
      } else if (event.type === "tool_call") {
        const tc = event.tool_call;
        const args =
          typeof tc.arguments === "string"
            ? tc.arguments
            : JSON.stringify(tc.arguments ?? {});
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: "",
            tool_call_chunks: [
              {
                name: tc.name as string | undefined,
                args,
                id: (tc.call_id ?? tc.id) as string | undefined,
                index: 0,
                type: "tool_call_chunk",
              },
            ],
          }),
        });
      } else if (event.type === "done") {
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: "",
            usage_metadata: toUsageMetadata(event.usage),
            response_metadata: toResponseMetadata(
              this.model,
              event.stop_reason,
              event.usage,
            ),
          }),
        });
      }
    }
  }
}
