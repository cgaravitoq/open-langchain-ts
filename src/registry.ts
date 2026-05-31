import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

// Lazy + memoized: importing the package touches no filesystem and does not load
// the heavy pi-coding-agent runtime. The default registry is built on first use
// (i.e. the first ChatPi invocation that did not receive an injected registry).
let defaults: { authStorage: AuthStorage; registry: ModelRegistry } | undefined;

const getDefaults = () => {
  if (!defaults) {
    const authStorage = AuthStorage.create();
    defaults = { authStorage, registry: ModelRegistry.create(authStorage) };
  }
  return defaults;
};

export const getDefaultRegistry = (): ModelRegistry => getDefaults().registry;

export const getDefaultAuthStorage = (): AuthStorage =>
  getDefaults().authStorage;
