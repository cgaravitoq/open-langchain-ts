import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";

// opencode keeps its Zen key in its own store, not ~/.pi. This is an opt-in
// helper the consumer invokes explicitly — it never runs at import time.
const DEFAULT_OPENCODE_AUTH = path.join(
  os.homedir(),
  ".local/share/opencode/auth.json",
);

export const readOpencodeKey = (
  authPath: string = DEFAULT_OPENCODE_AUTH,
): string | undefined => {
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<
      string,
      { key?: string }
    >;
    return auth["opencode-go"]?.key;
  } catch {
    return undefined; // opencode CLI not installed or never logged in
  }
};

// Registers the opencode key as a runtime key for the opencode / opencode-go
// providers. Returns true if a key was found and bridged. Pass the AuthStorage
// you build ChatPi's registry from (e.g. getDefaultAuthStorage()).
export const bridgeOpencodeAuth = (
  authStorage: AuthStorage,
  authPath?: string,
): boolean => {
  const key = readOpencodeKey(authPath);
  if (!key) return false;
  for (const provider of ["opencode", "opencode-go"])
    authStorage.setRuntimeApiKey(provider, key);
  return true;
};
