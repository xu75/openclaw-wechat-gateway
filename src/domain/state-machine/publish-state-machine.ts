import type { PublishTaskStatus } from '../../contracts/domain.js';

export const TRANSITION_GRAPH: Readonly<Record<PublishTaskStatus, readonly PublishTaskStatus[]>> = {
  approved: ['publishing'],
  publishing: ['waiting_login', 'published', 'publish_failed'],
  waiting_login: ['publishing', 'manual_intervention'],
  published: [],
  publish_failed: ['manual_intervention'],
  manual_intervention: []
};

export function getAllowedTransitions(from: PublishTaskStatus): readonly PublishTaskStatus[] {
  return TRANSITION_GRAPH[from];
}

export function canTransition(from: PublishTaskStatus, to: PublishTaskStatus): boolean {
  return TRANSITION_GRAPH[from].includes(to);
}

export function assertTransition(from: PublishTaskStatus, to: PublishTaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid transition: ${from} -> ${to}`);
  }
}
