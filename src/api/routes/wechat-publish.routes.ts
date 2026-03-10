import { Router } from 'express';
import type { IPublishOrchestrator } from '../../domain/services/publish-orchestrator.js';
import { PublishHandler } from '../handlers/publish.handler.js';

export function buildWechatPublishRoutes(orchestrator: IPublishOrchestrator): Router {
  const router = Router();
  const handler = new PublishHandler(orchestrator);

  router.post('/publish', handler.createAndPublish);
  router.post('/publish/:task_id/confirm-login', handler.confirmLogin);
  router.get('/publish/:task_id', handler.getTask);

  return router;
}
