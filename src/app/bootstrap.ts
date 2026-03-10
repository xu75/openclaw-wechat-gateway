import express from 'express';
import type { Express } from 'express';
import { SERVICE_NAME } from '../config/constants.js';
import { env } from '../config/env.js';
import { requestId } from '../api/middleware/request-id.js';
import { errorHandler } from '../api/middleware/error-handler.js';
import { PublishOrchestrator } from '../domain/services/publish-orchestrator.js';
import { buildWechatPublishRoutes } from '../api/routes/wechat-publish.routes.js';
import { runMigrations } from '../repo/sqlite/migrations.js';
import { openSqlite } from '../repo/sqlite/client.js';
import { SqlitePublishTaskRepo } from '../repo/sqlite/publish-task.sqlite.repo.js';
import { SqlitePublishEventRepo } from '../repo/sqlite/publish-event.sqlite.repo.js';
import { SqliteAuditLogRepo } from '../repo/sqlite/audit-log.sqlite.repo.js';
import { runContentPipeline } from '../content-pipeline/index.js';
import { PublisherClient } from '../agent-client/publisher-client.js';
import { createReviewToken } from '../agent-client/token.js';
import { AlertNotifier } from '../notifier/alert.js';
import { logError, logInfo } from '../observability/logger.js';
import { emitCounter } from '../observability/metrics.js';
import { setTraceContext } from '../observability/trace.js';

export function createServer(): Express {
  runMigrations(env.dbPath);
  const db = openSqlite(env.dbPath);
  const tasks = new SqlitePublishTaskRepo(db);
  const events = new SqlitePublishEventRepo(db);
  const audits = new SqliteAuditLogRepo(db);
  const publisherClient = new PublisherClient({
    baseUrl: env.agentBaseUrl,
    signingSecret: env.signingSecret
  });
  const alertNotifier = new AlertNotifier({
    webhook: env.alertWebhook,
    service: SERVICE_NAME
  });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(requestId);
  app.use((req, res, next) => {
    const requestIdValue =
      typeof res.locals.requestId === 'string' && res.locals.requestId.trim()
        ? res.locals.requestId.trim()
        : 'unknown';
    const startedAt = Date.now();
    setTraceContext({
      request_id: requestIdValue,
      stage: 'http_request',
      status: 'started'
    });
    logInfo('request_start', {
      request_id: requestIdValue,
      stage: 'http_request',
      status: 'started',
      method: req.method,
      route: req.originalUrl
    });

    res.on('finish', () => {
      const statusCode = res.statusCode;
      const route = req.route?.path ? String(req.route.path) : req.path;
      const labels = {
        method: req.method,
        route,
        status: String(statusCode)
      };
      const durationMs = Date.now() - startedAt;
      const status = statusCode >= 500 ? 'failed' : statusCode >= 400 ? 'client_error' : 'ok';
      emitCounter({ name: 'http_requests_total', labels });
      if (statusCode >= 400) {
        emitCounter({ name: 'http_request_errors_total', labels });
        logError('request_end', {
          request_id: requestIdValue,
          stage: 'http_request',
          status,
          error_code: `HTTP_${statusCode}`,
          method: req.method,
          route: req.originalUrl,
          status_code: statusCode,
          duration_ms: durationMs
        });
        return;
      }

      logInfo('request_end', {
        request_id: requestIdValue,
        stage: 'http_request',
        status,
        method: req.method,
        route: req.originalUrl,
        status_code: statusCode,
        duration_ms: durationMs
      });
    });

    next();
  });

  const orchestrator = new PublishOrchestrator({
    repo: {
      tasks,
      events,
      audits
    },
    agentClient: {
      publish: (payload) => publisherClient.publish(payload)
    },
    contentPipeline: {
      run: (input) => runContentPipeline(input)
    },
    notifier: {
      send: (type, payload) => alertNotifier.send(type, payload)
    },
    reviewTokenFactory: {
      create: ({ taskId, idempotencyKey }) =>
        createReviewToken({
          secret: env.reviewTokenSecret,
          issuer: env.reviewTokenIssuer,
          ttlSeconds: env.reviewTokenTtlSeconds,
          taskId,
          idempotencyKey
        })
    },
    waitingLoginTimeoutSeconds: env.waitingLoginTimeoutSeconds
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: SERVICE_NAME });
  });

  app.use('/wechat', buildWechatPublishRoutes(orchestrator));
  app.use(errorHandler);

  return app;
}
