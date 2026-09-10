import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const ZEN_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

const packageVersion: string = createRequire(import.meta.url)(
  "../package.json",
).version;
const userAgent = `open-langchain-ts/${packageVersion}`;

export type ChatOpencodeFields = Omit<ChatOpenAIFields, "configuration"> & {
  model: string;
  tier?: "zen" | "go";
};

// @langchain/openai's getHeadersWithUserAgent prepends
// `langchainjs-openai/<version>` to any User-Agent in defaultHeaders, so the
// client identity is set at the fetch layer. The free tier is anonymous: the
// Zen API accepts requests with no Authorization header, but the OpenAI SDK
// always derives `Authorization: Bearer <apiKey>` and won't drop it via a null
// default header, so strip it here too.
const zenFetch = (stripAuth: boolean) =>
  ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    headers.set("user-agent", userAgent);
    if (stripAuth) headers.delete("authorization");
    return fetch(input, { ...init, headers });
  }) as typeof fetch;

export class ChatOpencode extends ChatOpenAI {
  constructor(fields: ChatOpencodeFields) {
    const { tier = "zen", apiKey, ...rest } = fields;
    const key = apiKey ?? process.env.OPENCODE_API_KEY;
    const baseURL = tier === "go" ? ZEN_GO_BASE_URL : ZEN_BASE_URL;
    // Zen binds a session to one client, so the id is per instance, not per
    // request.
    const sessionId = randomUUID();
    // No key → anonymous free tier (strip auth header); paid models need a
    // key.
    super({
      ...rest,
      apiKey: key ?? "anonymous",
      configuration: {
        baseURL,
        defaultHeaders: { "x-opencode-session": sessionId },
        fetch: zenFetch(!key),
      },
    });
  }
}
