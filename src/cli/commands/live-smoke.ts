import { createSignature } from "../../webhooks/signature.ts";
import { ErrorCode } from "../../errors.ts";
import { parseFlags, parseJsonResponse, parsePositiveIntegerFlag, parseRepoFlag, requiredStringFlag, stringFlag } from "../support.ts";
import type { CliIo } from "../types.ts";

export async function runLiveSmoke(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const secret = process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET;
  if (!secret) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: AGENT_ORCHESTRATOR_WEBHOOK_SECRET is required for live-smoke`,
    );
    return 1;
  }
  const serviceUrl = requiredStringFlag(
    flags,
    "url",
    "live-smoke requires --url <service-url>",
  );
  const repo = parseRepoFlag(
    requiredStringFlag(
      flags,
      "repo",
      "live-smoke requires --repo <owner/name>",
    ),
  );
  const issue = parsePositiveIntegerFlag(
    flags,
    "issue",
    "live-smoke requires --issue <number>",
  );
  const delivery =
    stringFlag(flags, "delivery") ??
    `live-smoke-${repo.owner}-${repo.name}-${issue}`;
  const actor = stringFlag(flags, "actor") ?? "agent-orchestrator";
  const payload = JSON.stringify({
    action: "labeled",
    label: { name: "agent:autopilot" },
    repository: { name: repo.name, owner: { login: repo.owner } },
    issue: {
      number: issue,
      title: stringFlag(flags, "title") ?? "Live smoke issue",
      body: stringFlag(flags, "body") ?? "",
      user: { login: actor },
      labels: [{ name: "agent:autopilot" }],
    },
    sender: { login: actor },
  });
  const response = await fetch(`${serviceUrl.replace(/\/+$/, "")}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": delivery,
      "x-hub-signature-256": createSignature(payload, secret),
    },
    body: payload,
  });
  const text = await response.text();
  const body = parseJsonResponse(text);
  io.stdout(
    JSON.stringify({
      ok: response.ok,
      command: "live-smoke",
      status: response.status,
      delivery,
      repo: `${repo.owner}/${repo.name}`,
      issue,
      response: body,
    }),
  );
  return response.ok ? 0 : 1;
}
