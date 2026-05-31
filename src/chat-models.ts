import {
  streamSimple,
  type ThinkingLevel,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
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
  applyStop,
  buildContext,
  responseMetadata,
  toPiTool,
  usageMetadata,
} from "./pi-conversions";
import { getDefaultRegistry } from "./registry";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

export type ChatPiFields = BaseChatModelParams & {
  provider: string;
  modelId: string;
  reasoning?: ThinkingLevel;
  system?: string;
  registry?: ModelRegistry;
};

export type ChatPiCallOptions = BaseChatModelCallOptions & { tools?: Tool[] };

export class ChatPi extends BaseChatModel<ChatPiCallOptions> {
  provider: string;
  modelId: string;
  reasoning: ThinkingLevel;
  system?: string;
  private readonly registry?: ModelRegistry;

  constructor(fields: ChatPiFields) {
    super(fields);
    this.provider = fields.provider;
    this.modelId = fields.modelId;
    this.reasoning = fields.reasoning ?? "low";
    this.system = fields.system ?? DEFAULT_SYSTEM_PROMPT;
    this.registry = fields.registry;
  }

  _llmType() {
    return "pi";
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<ChatPiCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, ChatPiCallOptions> {
    return this.withConfig({ tools: tools.map(toPiTool), ...kwargs });
  }

  private async openStream(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ) {
    const registry = this.registry ?? getDefaultRegistry();
    const model = registry.find(this.provider, this.modelId);
    if (!model)
      throw new Error(`Unknown model "${this.provider}/${this.modelId}"`);

    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);

    return streamSimple(
      model,
      buildContext(messages, model, this.system, options.tools),
      {
        reasoning: this.reasoning,
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: options.signal,
      },
    );
  }

  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]) {
    const result = await (await this.openStream(messages, options)).result();

    if (result.stopReason === "error" || result.stopReason === "aborted")
      throw new Error(
        result.errorMessage ?? `pi-ai request ${result.stopReason}`,
      );

    const text = applyStop(
      result.content.reduce(
        (acc, item) => (item.type === "text" ? acc + item.text : acc),
        "",
      ),
      options.stop,
    );
    const tool_calls = result.content
      .filter((c): c is ToolCall => c.type === "toolCall")
      .map((c) => ({
        id: c.id,
        name: c.name,
        args: c.arguments,
        type: "tool_call" as const,
      }));
    const metadata = responseMetadata(
      this.provider,
      this.modelId,
      result.stopReason,
      result.usage,
    );

    const message = new AIMessage({
      content: text,
      tool_calls,
      response_metadata: metadata,
      usage_metadata: usageMetadata(result.usage),
    });

    return {
      generations: [{ text, message, generationInfo: metadata }],
      llmOutput: metadata,
    };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ) {
    for await (const event of await this.openStream(messages, options)) {
      if (event.type === "text_delta") {
        yield new ChatGenerationChunk({
          text: event.delta,
          message: new AIMessageChunk({ content: event.delta }),
        });
        await runManager?.handleLLMNewToken(event.delta);
      } else if (event.type === "toolcall_end") {
        const tc = event.toolCall;
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: "",
            tool_call_chunks: [
              {
                id: tc.id,
                name: tc.name,
                args: JSON.stringify(tc.arguments),
                index: event.contentIndex,
                type: "tool_call_chunk",
              },
            ],
          }),
        });
      } else if (event.type === "done") {
        const usage = event.message.usage;
        const metadata = responseMetadata(
          this.provider,
          this.modelId,
          event.message.stopReason,
          usage,
        );
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: "",
            response_metadata: metadata,
            usage_metadata: usageMetadata(usage),
          }),
        });
      } else if (event.type === "error")
        throw new Error(
          event.error.errorMessage ?? `pi-ai stream ${event.error.stopReason}`,
        );
    }
  }
}
