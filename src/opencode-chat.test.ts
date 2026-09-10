import { afterEach, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpencode } from "./opencode-chat";

type CapturedRequest = { url: string; headers: Headers; body: unknown };

const completion = (content: string) =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function captureRequests(content = "ok"): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      ),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return completion(content);
  }) as typeof fetch;
  return captured;
}

async function withoutEnvKey<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previous;
  }
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ChatOpencode", () => {
  test("free tier sends session id, user agent and strips auth", async () => {
    await withoutEnvKey(async () => {
      const captured = captureRequests();
      const chat = new ChatOpencode({ model: "nemotron-3.5-lightning-free" });
      await chat.invoke([new HumanMessage("hi")]);
      await chat.invoke([new HumanMessage("again")]);

      expect(captured).toHaveLength(2);
      for (const request of captured) {
        expect(request.url).toStartWith("https://opencode.ai/zen/v1/");
        expect(request.headers.get("x-opencode-session")).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(request.headers.get("user-agent")).toStartWith(
          "open-langchain-ts/",
        );
        expect(request.headers.get("authorization")).toBeNull();
      }
      const [first, second] = captured;
      expect(second?.headers.get("x-opencode-session")).toBe(
        first?.headers.get("x-opencode-session"),
      );
      expect((first?.body as { model?: string }).model).toBe(
        "nemotron-3.5-lightning-free",
      );
    });
  });

  test("go tier sends the session id and keeps auth", async () => {
    const captured = captureRequests();
    const chat = new ChatOpencode({
      model: "minimax-m3",
      tier: "go",
      apiKey: "test-key",
    });
    await chat.invoke([new HumanMessage("hi")]);
    await chat.invoke([new HumanMessage("again")]);

    expect(captured).toHaveLength(2);
    for (const request of captured) {
      expect(request.url).toStartWith("https://opencode.ai/zen/go/v1/");
      expect(request.headers.get("x-opencode-session")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(request.headers.get("user-agent")).toStartWith(
        "open-langchain-ts/",
      );
      expect(request.headers.get("authorization")).toBe("Bearer test-key");
    }
    const [first, second] = captured;
    expect(second?.headers.get("x-opencode-session")).toBe(
      first?.headers.get("x-opencode-session"),
    );
  });

  test("session id is unique per instance", async () => {
    await withoutEnvKey(async () => {
      const captured = captureRequests();
      await new ChatOpencode({ model: "nemotron-3.5-lightning-free" }).invoke([
        new HumanMessage("hi"),
      ]);
      await new ChatOpencode({ model: "nemotron-3.5-lightning-free" }).invoke([
        new HumanMessage("hi"),
      ]);

      const [first, second] = captured;
      expect(first?.headers.get("x-opencode-session")).not.toBe(
        second?.headers.get("x-opencode-session"),
      );
    });
  });
});
