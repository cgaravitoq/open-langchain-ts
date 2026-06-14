import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const ZEN_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

export type ChatOpencodeFields = Omit<ChatOpenAIFields, "configuration"> & {
  model: string;
  tier?: "zen" | "go";
};

// The free tier is anonymous: the Zen API accepts requests with no Authorization
// header. The OpenAI SDK always derives `Authorization: Bearer <apiKey>` and won't
// drop it via a null default header, so strip it with a custom fetch.
const stripAuthFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const headers = new Headers(init?.headers ?? {});
  headers.delete("authorization");
  return fetch(input, { ...init, headers });
}) as typeof fetch;

export class ChatOpencode extends ChatOpenAI {
  constructor(fields: ChatOpencodeFields) {
    const { tier = "zen", apiKey, ...rest } = fields;
    const key = apiKey ?? process.env.OPENCODE_API_KEY;
    const baseURL = tier === "go" ? ZEN_GO_BASE_URL : ZEN_BASE_URL;
    // No key → anonymous free tier (strip auth header); paid models need a key.
    super({
      ...rest,
      apiKey: key ?? "anonymous",
      configuration: key ? { baseURL } : { baseURL, fetch: stripAuthFetch },
    });
  }
}
