# @cgaravitoq/open-langchain-ts

Native LangChain [`BaseChatModel`](https://js.langchain.com/) adapters for coding-agent
subscriptions — **no Pi, no API key**:

- **`ChatClaudeCode`** — Anthropic Messages API billed against your Claude Code OAuth subscription.
- **`ChatCodex`** — OpenAI Codex (ChatGPT Plus/Pro) over the responses API.
- **`ChatOpencode`** — [OpenCode Zen](https://opencode.ai/docs/zen/), an OpenAI-compatible endpoint.

Tool calling and streaming work across all three. The TypeScript half of a pair; a Python
twin ([`open-langchain`](https://github.com/cgaravitoq/open-langchain)) ships the same models.

## Install

```sh
npm install @cgaravitoq/open-langchain-ts @langchain/core
```

`@langchain/core` is a **peer dependency** (`^1.1.44`). ESM-only, **Node >= 22.19.0**.

## Usage

`createChat` routes by provider:

```ts
import { createChat } from "@cgaravitoq/open-langchain-ts";

const free = createChat({ provider: "opencode", model: "deepseek-v4-flash-free" }); // no key
const go = createChat({ provider: "opencode-go", model: "glm-5", apiKey: "..." });
const codex = createChat({ provider: "openai-codex", model: "gpt-5.3-codex-spark" });
const claude = createChat({ provider: "claude-code", model: "claude-sonnet-4-6" });
```

Unknown providers throw. Or import a model directly from its subpath
(`/claude-code`, `/codex`, `/opencode`).

### Tool calling & streaming

```ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(({ city }) => `Sunny in ${city}.`, {
  name: "get_weather",
  description: "Get the weather for a city.",
  schema: z.object({ city: z.string() }),
});

const model = createChat({ provider: "claude-code", model: "claude-sonnet-4-6" });
const withTools = model.bindTools([getWeather]);

for await (const chunk of await model.stream("Write a haiku.")) {
  process.stdout.write(chunk.content as string);
}
```

## Claude Code (Anthropic subscription)

```ts
import { ChatClaudeCode } from "@cgaravitoq/open-langchain-ts/claude-code";

const opus = new ChatClaudeCode({ model: "claude-opus-4-8", reasoning: "medium" });
```

Reads the Claude Code OAuth session at `~/.claude/.credentials.json` (log in once with the
`claude` CLI). Models: `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`,
`claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`. Adaptive thinking on the
Claude 5 family and Opus 4.8/4.7; the 1M-context beta is opt-in via `longContext: true`. The native Claude Code stack (OAuth refresh, signed billing header,
betas, payload transforms) lives in [`@cgaravitoq/claude-code-core`](https://github.com/cgaravitoq/claude-code-core).

## OpenAI Codex (ChatGPT subscription)

```ts
import { ChatCodex } from "@cgaravitoq/open-langchain-ts/codex";

const codex = new ChatCodex({ model: "gpt-5.4", reasoning: "low" });
```

Reads the Codex OAuth session at `~/.pi/agent/auth.json` (sign in via `pi` or the Python
twin's `codex-login`). Models: `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`,
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.

## OpenCode Zen

```ts
import { ChatOpencode } from "@cgaravitoq/open-langchain-ts/opencode";

const free = new ChatOpencode({ model: "deepseek-v4-flash-free" }); // no key
const paid = new ChatOpencode({ model: "glm-5" }); // OPENCODE_API_KEY or apiKey
```

## Notes

Using a subscription OAuth session from a third-party app may violate the provider's terms
and risk your account. See the
[`pi-claude-code-auth`](https://github.com/cgaravitoq/pi-claude-code-auth) README for the
Claude Code caveats.

## License

MIT
