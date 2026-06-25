import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath } from "node:url";

import { ErrorCode } from "../errors.ts";
import { sanitizeMarkdown } from "../security/redaction.ts";
import {
  getDashboardStats,
  listRecentDeliveries,
  listWorkflowRuns
} from "../state/sqlite-queries.ts";
import { getWorkflowRunSnapshot } from "../state/sqlite-store.ts";
import type { StateDatabase, WorkflowRunSnapshot } from "../state/sqlite-store.ts";
import { buildGitHubLinks } from "./github-links.ts";
import { buildStaleHeadEvidence } from "./stale-head.ts";
import { stateLabelZh } from "./state-labels-zh.ts";

export const defaultUiPort = 23847;
export const defaultUiHost = "127.0.0.1";

export type UiRuntime = {
  readonly close: () => Promise<void>;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly baseUrl: string;
};

export type UiRuntimeOptions = {
  readonly host: string;
  readonly port: number;
  readonly database: StateDatabase;
  readonly databasePath: string;
};

type HttpResponse = {
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string | Buffer) => void;
};

type HttpRequest = {
  readonly method?: string;
  readonly url?: string;
};

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");

function readPublicAsset(relativePath: string): Buffer {
  const normalized = relativePath.replace(/^\/+/, "");
  if (isSea()) {
    const asset = getAsset(`ui/${normalized}`);
    return Buffer.from(asset);
  }
  return readFileSync(join(publicDir, normalized));
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

export function assertUiBindHost(host: string): void {
  if (host === "0.0.0.0" || host === "::") {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: ao ui must bind to localhost; received ${host}`);
  }
}

export async function startUiRuntime(input: UiRuntimeOptions): Promise<UiRuntime> {
  assertUiBindHost(input.host);
  const server = createServer(async (request, response) => {
    try {
      await handleUiRequest(request, response, input);
    } catch (error) {
      const message = sanitizeMarkdown(error instanceof Error ? error.message : String(error));
      writeJson(response, 500, {
        ok: false,
        error: {
          code: ErrorCode.LocalDbUnavailable,
          message
        }
      });
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(input.port, input.host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : input.port;
  const baseUrl = `http://${input.host}:${port}`;

  return {
    host: input.host,
    port,
    databasePath: input.databasePath,
    baseUrl,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          input.database.close();
          resolveClose();
        });
      });
    }
  };
}

async function handleUiRequest(
  request: HttpRequest,
  response: HttpResponse,
  input: UiRuntimeOptions
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/healthz") {
    writeJson(response, 200, { ok: true, service: "agent-orchestrator-ui" });
    return;
  }

  if (request.method === "GET" && pathname === "/api/local/v1/stats") {
    writeJson(response, 200, {
      ...envelope(input),
      ...getDashboardStats(input.database)
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/local/v1/runs") {
    const repo = parseRepoQuery(url.searchParams.get("repo"));
    if (repo.error) {
      writeError(response, 400, ErrorCode.LocalQueryInvalid, repo.error);
      return;
    }
    const result = listWorkflowRuns(input.database, {
      state: url.searchParams.get("state") ?? undefined,
      repoOwner: repo.owner,
      repoName: repo.name,
      limit: parsePositiveInt(url.searchParams.get("limit")),
      offset: parsePositiveInt(url.searchParams.get("offset"))
    });
    writeJson(response, 200, { ...envelope(input), ...result });
    return;
  }

  if (request.method === "GET" && pathname === "/api/local/v1/runs/by-issue") {
    const repo = parseRepoQuery(url.searchParams.get("repo"));
    const issue = Number(url.searchParams.get("issue"));
    if (repo.error || !Number.isInteger(issue) || issue < 1) {
      writeError(response, 400, ErrorCode.LocalQueryInvalid, "repo and issue query parameters are required");
      return;
    }
    const snapshot = getWorkflowRunSnapshot(input.database, {
      repoOwner: repo.owner!,
      repoName: repo.name!,
      issueNumber: issue
    });
    if (!snapshot) {
      writeError(response, 404, ErrorCode.LocalRunNotFound, "run not found");
      return;
    }
    writeJson(response, 200, buildRunDetailPayload(input, snapshot));
    return;
  }

  const runMatch = pathname.match(/^\/api\/local\/v1\/runs\/([^/]+)$/);
  if (request.method === "GET" && runMatch) {
    const runId = decodeURIComponent(runMatch[1] ?? "");
    const snapshot = getWorkflowRunSnapshot(input.database, { runId });
    if (!snapshot) {
      writeError(response, 404, ErrorCode.LocalRunNotFound, "run not found");
      return;
    }
    writeJson(response, 200, buildRunDetailPayload(input, snapshot));
    return;
  }

  if (request.method === "GET" && pathname === "/api/local/v1/deliveries") {
    const repo = parseRepoQuery(url.searchParams.get("repo"));
    if (repo.error) {
      writeError(response, 400, ErrorCode.LocalQueryInvalid, repo.error);
      return;
    }
    const result = listRecentDeliveries(input.database, {
      status: url.searchParams.get("status") ?? undefined,
      repoOwner: repo.owner,
      repoName: repo.name,
      limit: parsePositiveInt(url.searchParams.get("limit")),
      offset: parsePositiveInt(url.searchParams.get("offset"))
    });
    writeJson(response, 200, { ...envelope(input), ...result });
    return;
  }

  if (request.method === "GET" && pathname.startsWith("/ui")) {
    serveStatic(pathname, response);
    return;
  }

  writeError(response, 404, ErrorCode.GitHubNotFound, "NOT_FOUND");
}

function buildRunDetailPayload(input: UiRuntimeOptions, snapshot: WorkflowRunSnapshot) {
  const transitions = snapshot.transitions.map((transition) => ({
    fromState: transition.from_state,
    toState: transition.to_state,
    eventType: transition.event_type,
    headSha: transition.head_sha,
    reason: transition.reason,
    createdAt: transition.created_at
  }));
  return {
    ...envelope(input),
    snapshot: {
      run: snapshot.run,
      transitions,
      actions: snapshot.actions.map((action) => ({
        idempotencyKey: action.idempotency_key,
        actionType: action.action_type,
        targetType: action.target_type,
        targetId: action.target_id,
        responseRef: action.response_ref,
        status: action.status,
        createdAt: action.created_at,
        updatedAt: action.updated_at
      }))
    },
    staleHeadEvidence: buildStaleHeadEvidence(snapshot.run.head_sha, transitions),
    links: buildGitHubLinks({
      repoOwner: snapshot.run.repo_owner,
      repoName: snapshot.run.repo_name,
      issueNumber: snapshot.run.issue_number,
      prNumber: snapshot.run.pr_number
    }),
    stateLabelZh: stateLabelZh(snapshot.run.state)
  };
}

function envelope(input: UiRuntimeOptions) {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    database: input.databasePath
  };
}

function serveStatic(pathname: string, response: HttpResponse): void {
  let relativePath = pathname.slice("/ui".length);
  if (relativePath === "" || relativePath === "/") {
    relativePath = "/index.html";
  } else if (relativePath.startsWith("/runs/") && !relativePath.endsWith(".html") && !relativePath.endsWith(".css") && !relativePath.endsWith(".js")) {
    relativePath = "/run-detail.html";
  } else if (relativePath === "/runs") {
    relativePath = "/runs.html";
  } else if (relativePath === "/deliveries") {
    relativePath = "/deliveries.html";
  }

  const normalizedPath = relativePath.replace(/^\/+/, "");
  if (normalizedPath.includes("..")) {
    writeError(response, 404, ErrorCode.GitHubNotFound, "NOT_FOUND");
    return;
  }

  try {
    const body = readPublicAsset(normalizedPath);
    const extension = extname(normalizedPath);
    response.writeHead(200, { "content-type": contentTypes[extension] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    writeError(response, 404, ErrorCode.GitHubNotFound, "NOT_FOUND");
  }
}

function parseRepoQuery(value: string | null): { owner?: string; name?: string; error?: string } {
  if (!value) {
    return {};
  }
  const [owner, name] = value.split("/");
  if (!owner || !name) {
    return { error: "repo must use owner/name format" };
  }
  return { owner, name };
}

function parsePositiveInt(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function writeJson(response: HttpResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function writeError(response: HttpResponse, status: number, code: string, message: string): void {
  writeJson(response, status, {
    ok: false,
    error: {
      code,
      message: sanitizeMarkdown(message)
    }
  });
}
