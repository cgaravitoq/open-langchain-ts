import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/opencode-chat.ts",
    "src/claude-code-chat.ts",
    "src/codex-chat.ts",
  ],
  format: ["esm"],
  dts: true,
  target: "node22",
  clean: true,
  sourcemap: true,
});
