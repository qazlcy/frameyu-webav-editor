// Isolated E2E process: no environment file, no credentials, no provider network.
import { createServer as createViteServer } from 'vite';
import { createServer } from '../server/index.mjs';
import { configuration } from '../server/service.mjs';

const proxy = createServer(configuration({}), async () => {
  throw new Error('External API access is forbidden in E2E tests');
}, { host: '127.0.0.1:8789', origins: ['http://127.0.0.1:5175'] });
await new Promise((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(8789, '127.0.0.1', resolve);
});
let vite;
try {
  vite = await createViteServer({ server: {
    host: '127.0.0.1', port: 5175, strictPort: true,
    proxy: { '/api/ai': { target: 'http://127.0.0.1:8789', changeOrigin: true } },
  } });
  await vite.listen();
} catch (error) {
  proxy.close();
  throw error;
}
async function close() { proxy.closeAllConnections(); proxy.close(); await vite.close(); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
