import { createServer } from './bootstrap.js';
import { env } from '../config/env.js';
import { logInfo } from '../observability/logger.js';

const app = createServer();

app.listen(env.port, () => {
  logInfo('server_started', {
    stage: 'bootstrap',
    status: 'ok',
    port: env.port,
    agent_base_url: env.agentBaseUrl,
    db_path: env.dbPath
  });
});
