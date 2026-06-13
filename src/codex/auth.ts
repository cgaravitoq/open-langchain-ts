import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLIENT_ID,
  JWT_CLAIM_PATH,
  PROVIDER_ID,
  REFRESH_TIMEOUT_MS,
  TOKEN_URL,
} from "./constants";

export class CodexAuthError extends Error {}

export interface CodexCredential {
  type?: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

export function resolveAuthPath(explicit?: string): string {
  if (explicit) return expandHome(explicit);
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir) return join(expandHome(agentDir), "auth.json");
  const configDir = process.env.PI_CONFIG_DIR_NAME ?? ".pi";
  return join(homedir(), configDir, "agent", "auth.json");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const raw = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;
  const auth = payload[JWT_CLAIM_PATH];
  if (!auth || typeof auth !== "object") return null;
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId ? accountId : null;
}

export class CodexAuth {
  readonly path: string;

  constructor(authPath?: string) {
    this.path = resolveAuthPath(authPath);
  }

  load(): Record<string, CodexCredential> {
    if (!existsSync(this.path)) {
      throw new CodexAuthError(
        `No auth.json found at ${this.path}. Sign in with \`pi\` or \`codex-login\`.`,
      );
    }
    return JSON.parse(readFileSync(this.path, "utf-8"));
  }

  getCredential(): CodexCredential {
    const entry = this.load()[PROVIDER_ID];
    if (!entry) {
      throw new CodexAuthError(
        `No \`${PROVIDER_ID}\` credential in ${this.path}. Sign in with your ChatGPT subscription.`,
      );
    }
    return entry;
  }

  async getAccessToken(): Promise<CodexCredential> {
    let credential = this.getCredential();
    if (Date.now() >= Number(credential.expires ?? 0)) {
      credential = await this.refresh();
    }
    return credential;
  }

  accountId(credential?: CodexCredential): string {
    const cred = credential ?? this.getCredential();
    if (typeof cred.accountId === "string" && cred.accountId) {
      return cred.accountId;
    }
    const accountId = extractAccountId(cred.access ?? "");
    if (!accountId) {
      throw new CodexAuthError("Failed to extract accountId from token");
    }
    return accountId;
  }

  async refresh(): Promise<CodexCredential> {
    const credentials = this.load();
    const entry = credentials[PROVIDER_ID];
    if (!entry) {
      throw new CodexAuthError(
        `No \`${PROVIDER_ID}\` credential in ${this.path}. Sign in first.`,
      );
    }
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: entry.refresh,
        client_id: CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (res.status >= 400) {
      throw new CodexAuthError(
        `OpenAI Codex token refresh failed (${res.status}): ${await res.text()}`,
      );
    }
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (
      !data.access_token ||
      !data.refresh_token ||
      typeof data.expires_in !== "number"
    ) {
      throw new CodexAuthError("Token refresh response missing fields");
    }
    const credential: CodexCredential = {
      type: "oauth",
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000,
      accountId: extractAccountId(data.access_token) ?? undefined,
    };
    credentials[PROVIDER_ID] = credential;
    this.write(credentials);
    return credential;
  }

  private write(credentials: Record<string, CodexCredential>): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Atomic write: tmp file + rename, then tighten perms.
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(credentials, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      if (process.platform !== "win32") chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw err;
    }
  }
}
