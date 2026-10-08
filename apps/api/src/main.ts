import { createLogger, loadConfig } from '@projecthub/core';
import { createPreviewGateway } from './modules/gateway/gateway.js';
import { createApiServer } from './server.js';

const config = loadConfig();
const logger = createLogger('api', config.LOG_LEVEL);
const server = await createApiServer(config, { logger });
await server.app.listen(config.API_PORT, '0.0.0.0');
logger.info({ port: config.API_PORT }, 'Project Hub API listening');
const gateway = createPreviewGateway(server.ctx);
gateway.listen(config.PREVIEW_PORT, '0.0.0.0', () => logger.info({ port: config.PREVIEW_PORT, domain: config.PREVIEW_BASE_DOMAIN }, 'Preview gateway listening'));

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    gateway.close();
    await server.close();
    process.exit(0);
  });
}
