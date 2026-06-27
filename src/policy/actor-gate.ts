import type { RepoPolicy } from "../contracts/validation.ts";
import { DomainEventType } from "../webhooks/domain-event.ts";
import type { DomainEvent } from "../webhooks/domain-event.ts";

export function isActorGatedDomainEvent(event: DomainEvent): boolean {
  return (
    event.event_type === DomainEventType.IssueAutopilotRequested ||
    event.event_type === DomainEventType.IssueCommentDispatchRequested ||
    event.event_type === DomainEventType.ControlPause ||
    event.event_type === DomainEventType.ControlResume ||
    event.event_type === DomainEventType.ControlNoMerge ||
    event.event_type === DomainEventType.ControlAutopilotRemoved
  );
}

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
