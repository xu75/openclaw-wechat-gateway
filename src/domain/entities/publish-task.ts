import type { PublishTask } from '../../contracts/domain.js';

export function toTaskView(task: PublishTask): PublishTask {
  return { ...task };
}
