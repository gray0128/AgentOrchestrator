import { strict as assert } from "node:assert";
import { createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  ErrorCode,
  GitHubAppTokenProvider,
  createGitHubAppJwt,
  getGitHubAppCredentialRefs,
  requestInstallationToken,
  resolveGitHubAppCredentials,
  validateLocalConfig
} from "../src/index.ts";
import type { LocalConfig, TokenFetch } from "../src/index.ts";

test("local config can reference GitHub App credential environment variables", () => {
  const config = localConfig();
  const result = validateLocalConfig(config);

  assert.deepEqual(result, { ok: true, value: config });
  assert.deepEqual(getGitHubAppCredentialRefs(config), {
    appIdEnv: "APP_ID",
    privateKeyEnv: "APP_PRIVATE_KEY",
    installationIdEnv: "APP_INSTALLATION_ID",
    apiBaseUrl: "https://api.github.test"
  });
});

test("GitHub App credentials resolve from env references without exposing secret values", () => {
  const { privateKey } = keyPair();
  const credentials = resolveGitHubAppCredentials(getGitHubAppCredentialRefs(localConfig())!, {
    APP_ID: "12345",
    APP_PRIVATE_KEY: Buffer.from(privateKey).toString("base64"),
    APP_INSTALLATION_ID: "67890"
  });

  assert.equal(credentials.appId, "12345");
  assert.equal(credentials.installationId, "67890");
  assert.equal(credentials.apiBaseUrl, "https://api.github.test");
  assert.match(credentials.privateKey, /BEGIN PRIVATE KEY/);
});

test("missing GitHub App env values fail with registered auth error", () => {
  assert.throws(
    () => resolveGitHubAppCredentials(getGitHubAppCredentialRefs(localConfig())!, {}),
    (error) => {
      assert.equal((error as { code?: string }).code, ErrorCode.GitHubAuthInvalid);
      assert.match(String(error), /APP_ID/);
      return true;
    }
  );
});

test("GitHub App JWT is RS256 signed and uses bounded lifetime", () => {
  const { privateKey, publicKey } = keyPair();
  const now = new Date("2026-06-24T08:00:00.000Z");
  const jwt = createGitHubAppJwt({ appId: "12345", privateKey, now });
  const [header, payload, signature] = jwt.split(".");

  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), {
    alg: "RS256",
    typ: "JWT"
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), {
    iat: 1782287940,
    exp: 1782288480,
    iss: "12345"
  });

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
});

test("installation token request posts JWT auth and caches token until refresh window", async () => {
  const { privateKey } = keyPair();
  const calls: string[] = [];
  const fetch: TokenFetch = async (url, init) => {
    calls.push(`${init.method} ${url} ${init.headers.authorization.startsWith("Bearer ")}`);
    return jsonResponse(201, {
      token: `token-${calls.length}`,
      expires_at: "2026-06-24T09:00:00.000Z"
    });
  };
  const provider = new GitHubAppTokenProvider({
    credentials: {
      appId: "12345",
      privateKey,
      installationId: "67890",
      apiBaseUrl: "https://api.github.test"
    },
    fetch,
    now: () => new Date("2026-06-24T08:00:00.000Z")
  });

  assert.equal((await provider.getToken()).token, "token-1");
  assert.equal((await provider.getToken()).token, "token-1");
  assert.deepEqual(calls, ["POST https://api.github.test/app/installations/67890/access_tokens true"]);
});

test("installation token request maps malformed responses to auth errors", async () => {
  const { privateKey } = keyPair();

  await assert.rejects(
    () =>
      requestInstallationToken({
        credentials: {
          appId: "12345",
          privateKey,
          installationId: "67890",
          apiBaseUrl: "https://api.github.test"
        },
        fetch: async () => jsonResponse(201, { token: "token" }),
        now: new Date("2026-06-24T08:00:00.000Z")
      }),
    (error) => {
      assert.equal((error as { code?: string }).code, ErrorCode.GitHubAuthInvalid);
      return true;
    }
  );
});

function localConfig(): LocalConfig {
  const agent = {
    adapter: "codex" as const,
    command: "codex",
    args: [],
    mode: "read_only" as const,
    network: "deny" as const
  };

  return {
    version: 1,
    github: {
      api_base_url: "https://api.github.test",
      auth: {
        mode: "app",
        app_id_env: "APP_ID",
        private_key_env: "APP_PRIVATE_KEY",
        installation_id_env: "APP_INSTALLATION_ID"
      }
    },
    database: {
      path: ".agent-orchestrator/state.sqlite"
    },
    workspaces: {
      root: ".agent-orchestrator/workspaces"
    },
    repositories: [
      {
        owner: "octo",
        name: "repo",
        local_path: "/tmp/repo",
        default_branch: "main",
        policy_file: ".agent-orchestrator/policy.json"
      }
    ],
    agents: {
      planner: agent,
      plan_reviewer: agent,
      implementer: agent,
      pr_reviewer: agent,
      merge_agent: {
        adapter: "builtin",
        mode: "deterministic"
      }
    }
  };
}

function keyPair(): { readonly privateKey: string; readonly publicKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
}

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<TokenFetch>> {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}
