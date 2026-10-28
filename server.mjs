import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase, databaseInfo, createAnalysis, getAnalysis, listAnalyses, saveExplanation, saveReview, InputError } from './database.mjs';
import { modelConfig, explainAnalysis } from './llm.mjs';

const root = new URL('./', import.meta.url);
const allowed = new Set(['index.html', 'style.css', 'app.mjs', 'views.mjs', 'engine.mjs', 'data-import.mjs', 'report.mjs',
  'assistant.html', 'assistant.mjs', 'assistant.css', 'DATABASE_LLM.md', 'README.md', 'EXPLORATION.md', 'PROVENANCE.md', 'METHODS.md', 'DATA_FORMAT.md',
  'examples/valid-channel.csv', 'examples/invalid-quality.csv', 'examples/missing-days.csv']);
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.md': 'text/plain', '.csv': 'text/csv' };
function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new InputError('请使用 JSON 请求。', 415);
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw new InputError('请求内容过长。', 413);
    chunks.push(chunk);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
  catch { throw new InputError('JSON 格式无效。'); }
}

export function createAppServer({ db, config = modelConfig(), fetchImpl = fetch }) {
  const pendingModels = new Set();
  return createServer(async (request, response) => {
    try {
      const origin = `http://${request.headers.host}`;
      const url = new URL(request.url, origin);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname) || url.origin !== origin ||
          (request.headers.origin && request.headers.origin !== origin)) throw new InputError('仅允许从本机工作台访问。', 403);
      if (url.pathname.startsWith('/api/')) {
        if (request.method === 'GET' && url.pathname === '/api/status') {
          return json(response, 200, { database: databaseInfo(db), model: { configured: config.configured, name: config.model || null } });
        }
        if (url.pathname === '/api/analyses' && request.method === 'GET') return json(response, 200, listAnalyses(db));
        if (url.pathname === '/api/analyses' && request.method === 'POST') return json(response, 201, createAnalysis(db, await readJson(request)));
        const match = url.pathname.match(/^\/api\/analyses\/([a-f0-9-]{36})(?:\/(explanation|review))?$/);
        if (match && request.method === 'GET' && !match[2]) return json(response, 200, getAnalysis(db, match[1]));
        if (match && request.method === 'POST' && match[2] === 'review') return json(response, 200, saveReview(db, match[1], await readJson(request)));
        if (match && request.method === 'POST' && match[2] === 'explanation') {
          await readJson(request);
          const record = getAnalysis(db, match[1]);
          if (record.explanation) return json(response, 200, record.explanation);
          if (pendingModels.size) throw new InputError('已有一次大模型解读正在生成，请稍后再试。', 409);
          pendingModels.add(record.id);
          try {
            const explanation = await explainAnalysis(record, config, fetchImpl);
            saveExplanation(db, record.id, explanation);
            return json(response, 200, explanation);
          } finally { pendingModels.delete(record.id); }
        }
        throw new InputError('接口不存在或请求方法不支持。', 404);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new InputError('不支持此请求方法。', 405);
      let file;
      try { file = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html'; } catch { throw new InputError('地址格式错误。'); }
      if (!allowed.has(file)) throw new InputError('找不到文件。', 404);
      const body = await readFile(new URL(file, root));
      response.writeHead(200, { 'Content-Type': `${types[file.slice(file.lastIndexOf('.'))] || 'text/plain'}; charset=utf-8`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, error.status || 500, { error: error instanceof InputError ? error.message : '本地服务暂时无法处理请求，请检查数据库和配置。' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.loadEnvFile(fileURLToPath(new URL('.env', root))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = modelConfig();
  const db = openDatabase(process.env.DATABASE_FILE ? resolve(process.env.DATABASE_FILE) : fileURLToPath(new URL('.local/credit-demo.sqlite', root)));
  const port = Number(process.env.PORT || 5174);
  const server = createAppServer({ db, config });
  server.on('error', (error) => { db.close(); console.error(`本地服务启动失败：${error.code || 'unknown'}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`CSV 工作台：http://127.0.0.1:${port}/\n数据库与大模型：http://127.0.0.1:${port}/assistant.html\n大模型：${config.configured ? config.model : '未配置（数据库分析可用）'}`));
  const stop = () => { server.close(() => { db.close(); process.exit(0); }); server.closeAllConnections(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
