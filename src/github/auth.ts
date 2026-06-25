import { createSign } from "node:crypto";

import { ErrorCode, OrchestratorError } from "../errors.ts";
import type { LocalConfig } from "../contracts/validation.ts";

export type GitHubAppCredentialRefs = {
  readonly appIdEnv: string;
  readonly privateKeyEnv: string;
  readonly installationIdEnv: string;
  readonly apiBaseUrl: string;
};

export type GitHubAppCredentials = {
  readonly appId: string;
  readonly privateKey: string;
  readonly installationId: string;
  readonly apiBaseUrl: string;
};

export type GitHubInstallationToken = {
  readonly token: string;
  readonly expiresAt: Date;
};

export type GitHubAppTokenProviderInput = {
  readonly credentials: GitHubAppCredentials;
  readonly fetch: TokenFetch;
  readonly now?: () => Date;
};

export type TokenFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
  }
) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const defaultGitHubApiBaseUrl = "https://api.github.com";
const tokenRefreshSkewMs = 60_000;

export class GitHubAppTokenProvider {
  readonly #credentials: GitHubAppCredentials;
  readonly #fetch: TokenFetch;
  readonly #now: () => Date;
  #cached?: GitHubInstallationToken;

  constructor(input: GitHubAppTokenProviderInput) {
    this.#credentials = input.credentials;
    this.#fetch = input.fetch;
    this.#now = input.now ?? (() => new Date());
  }

  async getToken(): Promise<GitHubInstallationToken> {
    const now = this.#now();
    if (this.#cached && this.#cached.expiresAt.getTime() - tokenRefreshSkewMs > now.getTime()) {
      return this.#cached;
    }

    this.#cached = await requestInstallationToken({
      credentials: this.#credentials,
      fetch: this.#fetch,
      now
    });
    return this.#cached;
  }
}

export function getGitHubAppCredentialRefs(config: LocalConfig): GitHubAppCredentialRefs | undefined {
  if (!config.github) {
    return undefined;
  }

  return {
    appIdEnv: config.github.auth.app_id_env,
    privateKeyEnv: config.github.auth.private_key_env,
    installationIdEnv: config.github.auth.installation_id_env,
    apiBaseUrl: config.github.api_base_url ?? defaultGitHubApiBaseUrl
  };
}

export function resolveGitHubAppCredentials(
  refs: GitHubAppCredentialRefs,
  env: Record<string, string | undefined>
): GitHubAppCredentials {
  const appId = requiredEnv(env, refs.appIdEnv);
  const privateKey = normalizePrivateKey(requiredEnv(env, refs.privateKeyEnv));
  const installationId = requiredEnv(env, refs.installationIdEnv);

  return {
    appId,
    privateKey,
    installationId,
    apiBaseUrl: refs.apiBaseUrl.replace(/\/+$/, "")
  };
}

export function createGitHubAppJwt(input: {
  readonly appId: string;
  readonly privateKey: string;
  readonly now: Date;
}): string {
  const issuedAt = Math.floor(input.now.getTime() / 1000) - 60;
  const expiresAt = issuedAt + 540;
  const encodedHeader = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const encodedPayload = base64UrlJson({
    iat: issuedAt,
    exp: expiresAt,
    iss: input.appId
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  try {
    const signature = createSign("RSA-SHA256").update(signingInput).end().sign(input.privateKey);
    return `${signingInput}.${base64Url(signature)}`;
  } catch (error) {
    throw new OrchestratorError(
      ErrorCode.GitHubAuthInvalid,
      `GitHub App private key could not sign JWT: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function requestInstallationToken(input: {
  readonly credentials: GitHubAppCredentials;
  readonly fetch: TokenFetch;
  readonly now: Date;
}): Promise<GitHubInstallationToken> {
  const jwt = createGitHubAppJwt({
    appId: input.credentials.appId,
    privateKey: input.credentials.privateKey,
    now: input.now
  });

  const response = await input.fetch(
    `${input.credentials.apiBaseUrl}/app/installations/${input.credentials.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28"
      }
    }
  );

  if (response.status === 403) {
    throw new OrchestratorError(ErrorCode.GitHubForbidden, "GitHub App installation token request was forbidden");
  }
  if (response.status === 429 || response.status === 403) {
    throw new OrchestratorError(ErrorCode.GitHubRateLimited, "GitHub App installation token request was rate limited");
  }
  if (!response.ok) {
    throw new OrchestratorError(
      ErrorCode.GitHubAuthInvalid,
      `GitHub App installation token request failed with HTTP ${response.status}`
    );
  }

  const body = await response.json();
  if (!isRecord(body) || typeof body.token !== "string" || typeof body.expires_at !== "string") {
    throw new OrchestratorError(ErrorCode.GitHubAuthInvalid, "GitHub App installation token response was malformed");
  }

  const expiresAt = new Date(body.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new OrchestratorError(ErrorCode.GitHubAuthInvalid, "GitHub App installation token expiry was malformed");
  }

  return {
    token: body.token,
    expiresAt
  };
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new OrchestratorError(ErrorCode.GitHubAuthInvalid, `Required GitHub App environment variable is missing: ${name}`);
  }
  return value;
}

function normalizePrivateKey(value: string): string {
  if (value.includes("BEGIN")) {
    return value.replace(/\\n/g, "\n");
  }
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return value;
  }
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
