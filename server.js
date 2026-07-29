require("dotenv").config();
const fastify = require('fastify')({ logger: false });

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TARGET_API_KEY = process.env.TARGET_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || 'deepseek-chat';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'dylan123';

// ========================
// 启动 wake_up.js 子进程（简单版）
// ========================
if (process.env.ENABLE_WAKEUP === 'true') {
  const { fork } = require('child_process');
  const wakeProcess = fork('wake_up.js', [], {
    detached: true,
    stdio: 'ignore',
  });
  wakeProcess.unref();
  console.log('[server] wake_up.js 子进程已启动 (ENABLE_WAKEUP=true)');
}

// ========================
// 路由
// ========================

// 健康检查
fastify.get('/', async () => {
  return { status: 'ok', service: 'dylan-gateway' };
});

// 管理后台（简单认证）
fastify.get('/admin', async (req, reply) => {
  const auth = req.headers.authorization;
  if (!auth) {
    reply.header('WWW-Authenticate', 'Basic realm="Admin"');
    reply.status(401).send('需要认证');
    return;
  }
  const base64 = auth.split(' ')[1];
  const [user, pass] = Buffer.from(base64, 'base64').toString().split(':');
  if (user === 'admin' && pass === 'admin123') {
    return { status: 'ok', message: '管理后台' };
  }
  reply.status(401).send('认证失败');
});

// 主聊天接口（简单转发，只验证 Gateway API Key）
fastify.post('/v1/chat/completions', async (req, reply) => {
  const apiKey = req.headers['x-api-key'] || req.headers.authorization?.split(' ')[1] || '';

  // 验证 Gateway API Key（如果设置了的话）
  if (GATEWAY_API_KEY && apiKey !== GATEWAY_API_KEY) {
    reply.status(401).send({ error: 'Gateway API Key 无效或缺失' });
    return;
  }

  if (!TARGET_API_URL || !TARGET_API_KEY) {
    reply.status(500).send({ error: 'TARGET_API_URL 或 TARGET_API_KEY 未设置' });
    return;
  }

  try {
    const response = await fetch(TARGET_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TARGET_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: req.body.messages || [],
        temperature: req.body.temperature || 0.7,
        max_tokens: req.body.max_tokens || 2048,
        stream: req.body.stream || false,
      }),
    });
    const data = await response.json();
    reply.send(data);
  } catch (err) {
    console.error('上游请求失败:', err);
    reply.status(500).send({ error: err.message });
  }
});

// ========================
// 启动服务（监听 0.0.0.0）
// ========================
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ Gateway 运行在 ${address}`);
});