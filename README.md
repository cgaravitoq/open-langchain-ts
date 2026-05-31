# langchain-pi-ts

A LangChain [`BaseChatModel`](https://js.langchain.com/) adapter for
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai).
Use **Pi** — and any provider, model and credential it resolves — from LangChain
and LangGraph, with native tool calling and streaming.

> The TypeScript half of a pair. A Python twin (`langchain-pi`) is planned so the
> same Pi configuration can be reused from LangChain/LangGraph in Python too.

## Install

```sh
npm install langchain-pi-ts @langchain/core
```

`@langchain/core` is a **peer dependency** — your app owns its version (`^1.1.44`).
The package is **ESM-only** and requires **Node >= 22.19.0** (inherited from pi-ai
and pi-coding-agent).

## Usage

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
`AuthStorage`. Any provider authenticated in `~/.pi` works with no key. By default
`ChatPi` lazily builds a shared registry on first use (importing the package
touches no filesystem). Inject your own to customize:

```ts
import { ChatPi, getDefaultAuthStorage, bridgeOpencodeAuth } from "langchain-pi-ts";

// Opt-in: bridge the opencode CLI's Zen key into the default auth storage.
bridgeOpencodeAuth(getDefaultAuthStorage());

const model = new ChatPi({ provider: "opencode", modelId: "deepseek-v4-flash-free" });
```

Or pass a fully custom registry via `new ChatPi({ provider, modelId, registry })`.

## API

- `ChatPi` — the chat model. Fields: `provider`, `modelId`, `reasoning?`, `system?`, `registry?`.
- `getDefaultRegistry()` / `getDefaultAuthStorage()` — lazy, memoized defaults.
- `bridgeOpencodeAuth(authStorage, authPath?)` / `readOpencodeKey(authPath?)` — opt-in opencode key bridge.
- `buildContext`, `toPiTool`, `applyStop`, `usageMetadata`, `responseMetadata` — LangChain ↔ pi-ai mappers for advanced use.

## Notes

- **ESM + Node only.** pi-ai and pi-coding-agent are ESM-only and Node-native; this package cannot run from CommonJS `require()` or in browser/edge runtimes.
- **pi-coding-agent weight.** It exposes no subpath for `AuthStorage`/`ModelRegistry`, so importing the package loads its full runtime to reach those two classes. Lazy instantiation defers credential/filesystem work, not the module load.

## License

MIT
