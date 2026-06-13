import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  buildThinking,
  sanitizeSurrogates,
  toAnthropic,
  toAnthropicTools,
} from "./conversions";
import {
  applyClaudeCodeTransforms,
  buildBillingHeaderValue,
  computeBetas,
  getModelOverride,
  requestBetas,
  unprefixToolName,
} from "@cgaravitoq/claude-code-core";
import { CLAUDE_CODE_MODELS, findClaudeCodeModel } from "./models";

const HEADER_RE =
  /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[a-f0-9]{3}; cc_entrypoint=[^;]+; cch=[a-f0-9]{5};$/;

describe("signing", () => {
  test("billing header format + determinism", () => {
    const messages = [{ role: "user", content: "hello" }];
    const value = buildBillingHeaderValue(messages, "2.1.112", "sdk-cli");
    expect(value).toMatch(HEADER_RE);
    expect(value).toBe(buildBillingHeaderValue(messages, "2.1.112", "sdk-cli"));
  });

  test("empty messages deterministic, cch e3b0c", () => {
    const value = buildBillingHeaderValue([], "2.1.112", "sdk-cli");
    expect(value).toMatch(HEADER_RE);
    expect(value).toContain("cch=e3b0c;");
  });

  test("only first user message text influences output", () => {
    const a = buildBillingHeaderValue(
      [
        { role: "assistant", content: "x" },
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
      "2.1.112",
      "sdk-cli",
    );
    const b = buildBillingHeaderValue(
      [
        { role: "assistant", content: "y" },
        { role: "user", content: "first" },
        { role: "user", content: "changed" },
      ],
      "2.1.112",
      "sdk-cli",
    );
    expect(a).toBe(b);
  });
});

describe("model-config", () => {
  test("opus-4-8 betas include long-context + effort, deduped", () => {
    const betas = computeBetas("claude-opus-4-8");
    expect(betas).toContain("context-1m-2025-08-07");
    expect(betas).toContain("effort-2025-11-24");
    expect(betas.length).toBe(new Set(betas).size);
  });

  test("haiku excludes interleaved-thinking, effort, context-1m", () => {
    const betas = computeBetas("claude-haiku-4-5");
    expect(betas).not.toContain("interleaved-thinking-2025-05-14");
    expect(betas).not.toContain("effort-2025-11-24");
    expect(betas).not.toContain("context-1m-2025-08-07");
  });

  test("override first-match-wins", () => {
    expect(getModelOverride("claude-opus-4-8")?.adaptiveThinking).toBe(true);
    expect(
      getModelOverride("claude-sonnet-4-6")?.adaptiveThinking,
    ).toBeUndefined();
    expect(getModelOverride("claude-haiku-4-5")?.disableEffort).toBe(true);
    expect(getModelOverride("gpt-foo")).toBeNull();
  });

  test("requestBetas gates the 1M-context beta (opt-in)", () => {
    expect(requestBetas("claude-opus-4-8", false)).not.toContain(
      "context-1m-2025-08-07",
    );
    expect(requestBetas("claude-opus-4-8", true)).toContain(
      "context-1m-2025-08-07",
    );
    // interleaved-thinking survives (it is also a base beta)
    expect(requestBetas("claude-opus-4-8", false)).toContain(
      "interleaved-thinking-2025-05-14",
    );
  });

  test("model registry metadata", () => {
    expect(CLAUDE_CODE_MODELS.map((m) => m.id)).toEqual([
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
    expect(findClaudeCodeModel("claude-haiku-4-5")?.reasoning).toBe(false);
    expect(findClaudeCodeModel("claude-opus-4-8")?.maxTokens).toBe(128000);
  });
});

describe("thinking", () => {
  test("opus-4-8 uses adaptive + output_config, no budget_tokens", () => {
    const t = buildThinking("claude-opus-4-8", "medium", true);
    expect(t.thinking).toEqual({ type: "adaptive" });
    expect(t.output_config).toEqual({ effort: "medium" });
    expect(JSON.stringify(t)).not.toContain("budget_tokens");
  });

  test("minimal maps to low effort", () => {
    expect(
      buildThinking("claude-opus-4-8", "minimal", true).output_config,
    ).toEqual({
      effort: "low",
    });
  });

  test("sonnet-4-6 uses budget_tokens, no output_config", () => {
    const t = buildThinking("claude-sonnet-4-6", "medium", true);
    expect(t.thinking).toEqual({ type: "enabled", budget_tokens: 10240 });
    expect(t.output_config).toBeUndefined();
  });

  test("no reasoning support -> empty", () => {
    expect(buildThinking("claude-haiku-4-5", "medium", false)).toEqual({});
  });
});

describe("conversions", () => {
  test("surrogates: emoji collapses to two U+FFFD", () => {
    expect(sanitizeSurrogates("\u{1F600}")).toBe("��");
    expect(sanitizeSurrogates("hi")).toBe("hi");
  });

  test("assistant thinking dropped, placeholder kept", () => {
    const msg = new AIMessage({
      content: [{ type: "thinking", thinking: "secret" } as never],
    });
    const { messages } = toAnthropic([msg]);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "(no content)" },
    ]);
  });

  test("whitespace-only user message is skipped", () => {
    const { messages } = toAnthropic([
      new HumanMessage("   "),
      new HumanMessage("hi"),
    ]);
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("consecutive tool messages merge into one user turn", () => {
    const { messages } = toAnthropic([
      new ToolMessage({ content: "a", tool_call_id: "t1" }),
      new ToolMessage({ content: "b", tool_call_id: "t2" }),
    ]);
    expect(messages.length).toBe(1);
    const content = messages[0]?.content as Array<{ tool_use_id: string }>;
    expect(content.map((b) => b.tool_use_id)).toEqual(["t1", "t2"]);
  });

  test("tool schema wrapped as input_schema", () => {
    const tools = toAnthropicTools([
      {
        type: "function",
        function: {
          name: "f",
          description: "d",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      } as never,
    ]);
    expect(tools[0]).toMatchObject({
      name: "f",
      input_schema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    });
  });
});

describe("transforms", () => {
  function buildParams(
    model: string,
    messages: ReturnType<typeof toAnthropic>["messages"],
    tools?: unknown[],
  ) {
    const params: Record<string, unknown> = {
      model,
      system: [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    };
    if (tools) params.tools = tools;
    return applyClaudeCodeTransforms(params);
  }

  test("system layout: billing[0], identity[1], project moved to first user", () => {
    const params = applyClaudeCodeTransforms({
      model: "claude-sonnet-4-6",
      system: [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: "project rules" },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }) as {
      system: Array<{ text: string }>;
      messages: Array<{ content: Array<{ type?: string; text?: string }> }>;
    };
    expect(params.system.length).toBe(2);
    expect(params.system[0]?.text).toStartWith("x-anthropic-billing-header:");
    expect(params.system[1]?.text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    expect(params.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "project rules",
    });
  });

  test("identity is system[1] verbatim and tools get mcp_ prefix", () => {
    const params = buildParams(
      "claude-sonnet-4-6",
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [{ name: "search" }],
    ) as { system: Array<{ text: string }>; tools: Array<{ name: string }> };
    expect(params.system[0]?.text).toStartWith("x-anthropic-billing-header:");
    expect(params.system[1]?.text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    expect(params.tools[0]?.name).toBe("mcp_Search");
  });

  test("orphan tool_use replaced with placeholder, roles preserved", () => {
    const params = applyClaudeCodeTransforms({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "x", name: "s", input: {} }],
        },
        { role: "user", content: [{ type: "text", text: "n" }] },
      ],
    }) as {
      messages: Array<{
        role: string;
        content: Array<{ type?: string; text?: string }>;
      }>;
    };
    expect(params.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(params.messages[1]?.content).toEqual([
      { type: "text", text: "(no content)" },
    ]);
  });

  test("unprefix reverses tool name", () => {
    expect(unprefixToolName("mcp_Search")).toBe("search");
    expect(unprefixToolName("plain")).toBe("plain");
  });

  test("system-only conversation synthesizes a user message", () => {
    const params = applyClaudeCodeTransforms({
      model: "claude-sonnet-4-6",
      system: [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        { type: "text", text: "rules here" },
      ],
      messages: [],
    }) as { messages: Array<{ role: string; content: string }> };
    expect(params.messages.length).toBe(1);
    expect(params.messages[0]).toEqual({ role: "user", content: "rules here" });
  });
});
