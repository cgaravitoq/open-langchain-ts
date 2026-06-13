import { arch, platform, release } from "node:os";
import type { CodexAuth } from "./auth";
import {
  DEFAULT_CODEX_BASE_URL,
  ORIGINATOR,
  REQUEST_TIMEOUT_MS,
} from "./constants";

const USAGE_LIMIT_CODES = new Set([
  "usage_limit_reached",
  "usage_not_included",
  "rate_limit_exceeded",
]);

export class CodexUsageLimitError extends Error {
  resetsAt?: number;
  constructor(message: string, resetsAt?: number) {
    super(message);
    this.resetsAt = resetsAt;
  }
}

function userAgent(): string {
  return `pi (${platform()} ${release()}; ${arch()})`;
}

export function buildHeaders(
  access: string,
  accountId: string,
  sessionId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    "chatgpt-account-id": accountId,
    originator: ORIGINATOR,
    "User-Agent": userAgent(),
    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
  };
  if (sessionId) {
    headers["session-id"] = sessionId;
    headers["x-client-request-id"] = sessionId;
  }
  return headers;
}

export function resolveUrl(base: string): string {
  const b = base.replace(/\/+$/, "");
  if (b.endsWith("/codex/responses")) return b;
  if (b.endsWith("/codex")) return `${b}/responses`;
  return `${b}/codex/responses`;
}

type AnyRecord = Record<string, unknown>;

export type CodexEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; tool_call: AnyRecord }
  | { type: "done"; usage?: AnyRecord; stop_reason?: string }
  | { type: "error"; code?: string; message: string; resets_at?: number };

export function normalizeEvent(payload: AnyRecord): CodexEvent | null {
  const etype = payload.type as string | undefined;
  if (
    etype === "response.output_text.delta" ||
    etype === "response.text.delta"
  ) {
    return { type: "text_delta", delta: (payload.delta as string) ?? "" };
  }
  if (etype === "response.output_item.done") {
    const item = (payload.item as AnyRecord) ?? {};
    if (item.type === "function_call") {
      return { type: "tool_call", tool_call: item };
    }
    return null;
  }
  if (
    etype === "response.completed" ||
    etype === "response.done" ||
    etype === "response.incomplete"
  ) {
    const response = (payload.response as AnyRecord) ?? {};
    return {
      type: "done",
      usage: response.usage as AnyRecord | undefined,
      // Match Python's `status or etype`: an empty status falls back to the event type.
      stop_reason: (response.status as string) || etype,
    };
  }
  if (etype === "error" || etype === "response.failed") {
    const error =
      etype === "response.failed"
        ? (((payload.response as AnyRecord)?.error as AnyRecord) ?? {})
        : payload;
    return {
      type: "error",
      code: error.code as string | undefined,
      message: (error.message as string) ?? "Codex request failed",
      resets_at: error.resets_at as number | undefined,
    };
  }
  return null;
}

async function* iterSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AnyRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const tryParse = (raw: string): AnyRecord | undefined => {
    if (raw.trim() === "[DONE]") return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (dataLines.length) {
          const parsed = tryParse(dataLines.join(""));
          dataLines = [];
          if (parsed) yield parsed;
        }
        continue;
      }
      if (line.startsWith("data:")) {
        let v = line.slice("data:".length);
        if (v.startsWith(" ")) v = v.slice(1);
        dataLines.push(v);
      }
    }
  }

  if (buffer.length) {
    let line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (line.startsWith("data:")) {
      let v = line.slice("data:".length);
      if (v.startsWith(" ")) v = v.slice(1);
      dataLines.push(v);
    }
  }
  if (dataLines.length) {
    const parsed = tryParse(dataLines.join(""));
    if (parsed) yield parsed;
  }
}

export class CodexClient {
  private readonly auth: CodexAuth;
  readonly url: string;

  constructor(auth: CodexAuth, baseUrl: string = DEFAULT_CODEX_BASE_URL) {
    this.auth = auth;
    this.url = resolveUrl(baseUrl);
  }

  private async headers(sessionId?: string): Promise<Record<string, string>> {
    const credential = await this.auth.getAccessToken();
    return buildHeaders(
      credential.access,
      this.auth.accountId(credential),
      sessionId,
    );
  }

  async *stream(
    body: AnyRecord,
    sessionId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<CodexEvent> {
    const content = JSON.stringify(body);
    let headers = await this.headers(sessionId);
    let retried = false;

    while (true) {
      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body: content,
        signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 401 && !retried) {
        await res.text();
        await this.auth.refresh();
        headers = await this.headers(sessionId);
        retried = true;
        continue;
      }
      if (res.status >= 400) {
        await this.raiseForStatus(res);
      }
      if (!res.body) return;

      for await (const payload of iterSse(res.body)) {
        const event = normalizeEvent(payload);
        if (!event) continue;
        if (event.type === "error") this.raiseEventError(event);
        yield event;
        if (event.type === "done") return;
      }
      return;
    }
  }

  private async raiseForStatus(res: Response): Promise<never> {
    const text = await res.text();
    if (res.status === 429) this.maybeUsageLimit(text);
    throw new Error(`Codex request failed (${res.status}): ${text}`);
  }

  private maybeUsageLimit(text: string): void {
    let code: string | undefined;
    let resetsAt: number | undefined;
    try {
      const data = JSON.parse(text);
      const error = (data.error ?? data) as AnyRecord;
      code = error.code as string | undefined;
      resetsAt = error.resets_at as number | undefined;
    } catch {
      // not JSON
    }
    if (code && USAGE_LIMIT_CODES.has(code)) {
      throw new CodexUsageLimitError(
        "You hit your ChatGPT usage limit.",
        resetsAt,
      );
    }
  }

  private raiseEventError(event: CodexEvent & { type: "error" }): never {
    if (event.code && USAGE_LIMIT_CODES.has(event.code)) {
      throw new CodexUsageLimitError(
        "You hit your ChatGPT usage limit.",
        event.resets_at,
      );
    }
    throw new Error(event.message || "Codex request failed");
  }
}
