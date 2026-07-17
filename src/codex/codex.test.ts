import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ChatCodex } from "../codex-chat";
import { CodexAuth, extractAccountId, resolveAuthPath } from "./auth";
import {
  buildHeaders,
  CodexClient,
  normalizeEvent,
  resolveUrl,
} from "./client";
import {
  applyStop,
  buildRequestBody,
  messagesToResponses,
  toolToResponses,
  toToolCalls,
} from "./conversions";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  thinkingWireValue,
} from "./models";

const enc = new TextEncoder();
function sseStream(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(body));
      controller.close();
    },
  });
}

function makeAuthFile(): { authPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codex-test-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "tok",
        refresh: "r",
        expires: Date.now() + 3_600_000,
        accountId: "acc-1",
      },
    }),
  );
  return {
    authPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("conversions", () => {
  test("system folds into instructions", () => {
    const { instructions, input } = messagesToResponses(
      [new SystemMessage("Be terse."), new HumanMessage("hi")],
      "Top system.",
    );
    expect(instructions).toBe("Top system.\n\nBe terse.");
    expect(input).toHaveLength(1);
    expect(input[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });
  });

  test("default instructions when none", () => {
    const { instructions } = messagesToResponses([new HumanMessage("hi")]);
    expect(instructions).toBe("You are a helpful assistant.");
  });

  test("image block becomes input_image", () => {
    const { input } = messagesToResponses([
      new HumanMessage({
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "http://x/y.png" } },
        ],
      }),
    ]);
    expect(input[0]?.content).toEqual([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "http://x/y.png" },
    ]);
  });

  test("ai tool call becomes function_call", () => {
    const { input } = messagesToResponses([
      new AIMessage({
        content: "ok",
        tool_calls: [
          { name: "f", args: { a: 1 }, id: "c1", type: "tool_call" },
        ],
      }),
    ]);
    expect(input[0]).toEqual({
      role: "assistant",
      content: [{ type: "output_text", text: "ok" }],
    });
    expect(input[1]).toEqual({
      type: "function_call",
      name: "f",
      arguments: '{"a":1}',
      call_id: "c1",
    });
  });

  test("tool message becomes function_call_output", () => {
    const { input } = messagesToResponses([
      new ToolMessage({ content: "result", tool_call_id: "c1" }),
    ]);
    expect(input[0]).toEqual({
      type: "function_call_output",
      call_id: "c1",
      output: "result",
    });
  });

  test("toolToResponses has strict null", () => {
    const out = toolToResponses({
      type: "function",
      function: {
        name: "f",
        description: "d",
        parameters: { type: "object", properties: {} },
      },
    });
    expect(out.type).toBe("function");
    expect(out.name).toBe("f");
    expect(out.strict).toBeNull();
  });

  test("buildRequestBody shape", () => {
    const body = buildRequestBody({
      model: "gpt-5.4",
      instructions: "i",
      input: [],
      toolChoice: { type: "function", name: "f" },
      reasoningEffort: "medium",
      sessionId: "sess-1",
    });
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.text).toEqual({ verbosity: "low" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.tool_choice).toEqual({ type: "function", name: "f" });
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.prompt_cache_key).toBe("sess-1");
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  test("buildRequestBody defaults tool_choice to auto", () => {
    const body = buildRequestBody({
      model: "gpt-5.4",
      instructions: "i",
      input: [],
    });
    expect(body.tool_choice).toBe("auto");
  });

  test("off omits reasoning and cache key", () => {
    const body = buildRequestBody({
      model: "gpt-5.4",
      instructions: "i",
      input: [],
      reasoningEffort: "off",
    });
    expect("reasoning" in body).toBe(false);
    expect("prompt_cache_key" in body).toBe(false);
  });

  test("toToolCalls parses json args", () => {
    const calls = toToolCalls([
      { name: "f", arguments: '{"a":1}', call_id: "c1" },
    ]);
    expect(calls[0]).toEqual({
      name: "f",
      args: { a: 1 },
      id: "c1",
      type: "tool_call",
    });
  });

  test("applyStop truncates at first stop sequence", () => {
    expect(applyStop("hello world", ["world"])).toBe("hello ");
    expect(applyStop("hello", undefined)).toBe("hello");
  });
});

describe("models", () => {
  test("thinking wire values", () => {
    expect(thinkingWireValue("gpt-5.6-sol", "minimal")).toBe("low");
    expect(thinkingWireValue("gpt-5.6-sol", "high")).toBe("high");
    expect(thinkingWireValue("gpt-5.6-sol", "xhigh")).toBe("xhigh");
    expect(thinkingWireValue("gpt-5.6-sol", "off")).toBeNull();
  });

  test("supported levels and clamp", () => {
    expect(getSupportedThinkingLevels("gpt-5.5")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(clampThinkingLevel("gpt-5.5", "medium")).toBe("medium");
  });
});

describe("auth", () => {
  test("resolveAuthPath explicit wins", () => {
    expect(resolveAuthPath("/tmp/x/auth.json")).toBe("/tmp/x/auth.json");
  });

  test("resolveAuthPath env override", () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/tmp/agent";
    try {
      expect(resolveAuthPath()).toBe("/tmp/agent/auth.json");
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  test("extractAccountId from JWT", () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-9" },
      }),
    ).toString("base64url");
    const token = `h.${payload}.s`;
    expect(extractAccountId(token)).toBe("acc-9");
  });

  test("extractAccountId invalid returns null", () => {
    expect(extractAccountId("not-a-jwt")).toBeNull();
  });
});

describe("client pure", () => {
  test("resolveUrl appends codex/responses", () => {
    expect(resolveUrl("https://chatgpt.com/backend-api")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(resolveUrl("https://x/codex")).toBe("https://x/codex/responses");
    expect(resolveUrl("https://x/codex/responses")).toBe(
      "https://x/codex/responses",
    );
  });

  test("buildHeaders sets auth + account + session", () => {
    const h = buildHeaders("tok", "acc-1", "sess-9");
    expect(h.Authorization).toBe("Bearer tok");
    expect(h["chatgpt-account-id"]).toBe("acc-1");
    expect(h.originator).toBe("pi");
    expect(h["session-id"]).toBe("sess-9");
    expect(h["User-Agent"]).toStartWith("pi (");
  });

  test("normalizeEvent maps event types", () => {
    expect(
      normalizeEvent({ type: "response.output_text.delta", delta: "hi" }),
    ).toEqual({ type: "text_delta", delta: "hi" });
    expect(
      normalizeEvent({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 1 } },
      }),
    ).toEqual({
      type: "done",
      usage: { input_tokens: 1 },
      stop_reason: "completed",
    });
    expect(normalizeEvent({ type: "response.created" })).toBeNull();
  });
});

describe("client stream", () => {
  test("text and done", async () => {
    const { authPath, cleanup } = makeAuthFile();
    globalThis.fetch = (async () =>
      new Response(
        sseStream(
          'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":5}}}\n\n',
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const client = new CodexClient(new CodexAuth(authPath));
      const events = [];
      for await (const e of client.stream({}, undefined)) events.push(e);
      expect(events[0]).toEqual({ type: "text_delta", delta: "Hello" });
      expect(events[1]?.type).toBe("done");
    } finally {
      cleanup();
    }
  });

  test("tool call event", async () => {
    const { authPath, cleanup } = makeAuthFile();
    globalThis.fetch = (async () =>
      new Response(
        sseStream(
          'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"search","arguments":"{\\"q\\":\\"hi\\"}","call_id":"call-1"}}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const client = new CodexClient(new CodexAuth(authPath));
      const events = [];
      for await (const e of client.stream({}, undefined)) events.push(e);
      const tc = events.find((e) => e.type === "tool_call");
      expect(tc).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("401 triggers one refresh and retry", async () => {
    const { authPath, cleanup } = makeAuthFile();
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      calls++;
      if (url.includes("oauth/token")) {
        const payload = Buffer.from(
          JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" },
          }),
        ).toString("base64url");
        return new Response(
          JSON.stringify({
            access_token: `h.${payload}.s`,
            refresh_token: "r2",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      if (calls === 1) return new Response("", { status: 401 });
      return new Response(
        sseStream(
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const client = new CodexClient(new CodexAuth(authPath));
      const events = [];
      for await (const e of client.stream({}, undefined)) events.push(e);
      expect(events.at(-1)?.type).toBe("done");
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      cleanup();
    }
  });
});

describe("ChatCodex", () => {
  test("invoke streams text via mocked fetch", async () => {
    const { authPath, cleanup } = makeAuthFile();
    globalThis.fetch = (async () =>
      new Response(
        sseStream(
          'data: {"type":"response.output_text.delta","delta":"Hi there"}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":2}}}\n\n',
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const chat = new ChatCodex({ model: "gpt-5.4", authPath });
      const res = await chat.invoke([new HumanMessage("hi")]);
      expect(res.content).toBe("Hi there");
    } finally {
      cleanup();
    }
  });
});
