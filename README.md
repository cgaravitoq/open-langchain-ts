# langchain-pi-ts

A LangChain [`BaseChatModel`](https://js.langchain.com/) adapter for
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai).
Use **Pi** — and any provider, model and credential it resolves — from LangChain
and LangGraph, with native tool calling and streaming.

> The TypeScript half of a pair. A Python twin (`langchain-pi`) reuses the same
> Pi configuration from LangChain/LangGraph in Python.

## Install

```sh
npm install langchain-pi-ts @langchain/core
```

`@langchain/core` is a **peer dependency** — your app owns its version (`^1.1.44`).
The package is **ESM-only** and requires **Node >= 22.19.0** (inherited from pi-ai
and pi-coding-agent).

## Usage

`createChat` is the simplest entry — pass a provider and it routes to the right
backend (`opencode`/`opencode-go` → native Zen, everything else → Pi):

```ts
import { createChat } from "langchain-pi-ts";

const free = createChat({ provider: "opencode", model: "deepseek-v4-flash-free" }); // free, no key
const go = createChat({ provider: "opencode-go", model: "glm-5", apiKey: "..." }); // subscription
const codex = createChat({ provider: "openai-codex", model: "gpt-5.3-codex-spark" }); // via Pi
```

Or construct a backend directly:

```ts
import { ChatPi } from "langchain-pi-ts";

const model = new ChatPi({
  provider: "openai-codex",
  modelId: "gpt-5.3-codex-spark",
  reasoning: "minimal",
  system: "You are a helpful assistant.",
});

const res = await model.invoke("Hello!");
console.log(res.content);
```

### Tool calling

`ChatPi` accepts any LangChain tool (Zod / `tool()`); schemas are converted to the
JSON Schema pi-ai expects.

```ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(({ city }) => `Sunny in ${city}.`, {
  name: "get_weather",
  description: "Get the weather for a city.",
  schema: z.object({ city: z.string() }),
});

const withTools = model.bindTools([getWeather]);
```

### Streaming

```ts
for await (const chunk of await model.stream("Write a haiku.")) {
  process.stdout.write(chunk.content as string);
}
```

### Credentials

Models and credentials resolve through pi-coding-agent's `ModelRegistry` /
`AuthStorage`. Any provider authenticated in `~/.pi` works with no key. `ChatPi`
lazily builds a shared registry on first use (importing the package touches no
filesystem); pass a custom one via `new ChatPi({ provider, modelId, registry })`,
or `getDefaultAuthStorage().setRuntimeApiKey(provider, key)` to inject a key.

For OpenCode Zen, prefer the native `ChatOpencode` below.

## Native opencode/Zen (no Pi)

[OpenCode Zen](https://opencode.ai/docs/zen/) is an OpenAI-compatible endpoint, so
you don't need Pi. The `langchain-pi-ts/opencode` subpath ships `ChatOpencode`, a
thin `ChatOpenAI` subclass pointed at it (`@langchain/openai` ships as a dependency).

The API key is **optional**: free models work with no key (anonymous, IP-rate-
limited). For paid models pass a key via `OPENCODE_API_KEY` (env) or `apiKey`.

```ts
import { ChatOpencode } from "langchain-pi-ts/opencode";

const free = new ChatOpencode({ model: "deepseek-v4-flash-free" }); // no key
const paid = new ChatOpencode({ model: "glm-5" }); // OPENCODE_API_KEY or apiKey
const go = new ChatOpencode({ model: "glm-5", tier: "go" });
```

Free models: `deepseek-v4-flash-free`, `big-pickle`, `mimo-v2.5-free`, `nemotron-3-super-free`.

## Notes

- ESM + Node only. pi-ai / pi-coding-agent are ESM-only and Node-native.
- Tool-call deltas and usage/cost metadata are preserved.

## License

MIT
