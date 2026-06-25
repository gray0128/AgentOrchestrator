import type { RepoPolicy } from "../contracts/validation.ts";

export function isActorAllowed(
  actor: string | undefined,
  policy: Pick<RepoPolicy["autopilot"], "allowed_actors">,
): boolean {
  const allowedActors = policy.allowed_actors;
  if (!allowedActors || allowedActors.length === 0) {
    return true;
  }
  if (!actor) {
    return false;
  }
  return allowedActors.includes(actor);
}

export function shouldDiscardActor(
  actor: string | undefined,
  policy: Pick<RepoPolicy["autopilot"], "allowed_actors">,
): boolean {
  return !isActorAllowed(actor, policy);
}
