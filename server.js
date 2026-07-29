require("dotenv").config();

const fastify = require('fastify')({ logger: false });
const path = require('path');
const fs = require('fs-extra');
const cron = require('node-cron');

// ========================
// 环境变量
// ========================
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'default-key-change-me';
const ALLOW_PUBLIC_API = process.env.ALLOW_PUBLIC_API === 'true';
const TARGET_API_URL = process.env.TARGET_API_URL;
const TARGET_API_KEY = process.env.TARGET_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || 'deepseek-chat';
const TIMELINE_PATH = path.join(__dirname, 'enhanced_messages.json');

// ========================
// 数据存储
// ========================
let timeline = [];
let wakeEvents = [];

function loadTimeline() {
  try {
    if (fs.existsSync(TIMELINE_PATH)) {
      const data = fs.readFileSync(TIMELINE_PATH, 'utf8');
      timeline = JSON.parse(data);
      if (!Array.isArray(timeline)) timeline = [];
    } else {
      timeline = [];
      fs.writeJsonSync(TIMELINE_PATH, timeline);
    }
  } catch (e) {
    console.error('加载 timeline 失败:', e);
    timeline = [];
  }
}

function saveTimeline() {
  try {
    fs.writeJsonSync(TIMELINE_PATH, timeline, { spaces: 2 });
  } catch (e) {
    console.error('保存 timeline 失败:', e);
  }
}

// ========================
// 启动 wake_up.js 子进程（带错误隔离）
// ========================
if (process.env.ENABLE_WAKEUP === 'true') {
  const { fork } = require('child_process');
  const wakeProcess = fork('wake_up.js', [], {
    detached: true,
    stdio: 'ignore',
  });
  wakeProcess.unref();
  wakeProcess.on('error', (err) => {
    console.log('[server] wake_up.js 子进程启动失败，继续运行主服务:', err.message);
  });
  wakeProcess.on('exit', (code) => {
    if (code !== 0) {
      console.log(`[server] wake_up.js 子进程退出 (code ${code})，主服务继续运行`);
    }
  });
  console.log('[server] wake_up.js 子进程已启动 (ENABLE_WAKEUP=true)');
}

// ========================
// API 路由
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
  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) {
    return {
      status: 'ok',
      message: '管理后台',
      timeline_length: timeline.length,
      wake_events: wakeEvents.slice(-20),
    };
  }
  reply.status(401).send('认证失败');
});

// 内部：记录唤醒事件
fastify.post('/internal/wake-event', async (req, reply) => {
  const { content } = req.body;
  if (!content) {
    reply.status(400).send({ error: 'content 不能为空' });
    return;
  }
  const entry = {
    time: new Date().toISOString(),
    content,
  };
  wakeEvents.push(entry);
  if (wakeEvents.length > 100) wakeEvents.shift();

  timeline.push({
    role: 'system',
    content: `[唤醒事件] ${content}`,
  });
  saveTimeline();

  reply.send({ success: true });
});

// 内部：心跳
fastify.post('/internal/heartbeat', async () => {
  return { ok: true };
});

// ========================
// 主聊天接口（只定义一次！）
// ========================
fastify.post('/v1/chat/completions', async (req, reply) => {
  const apiKey = req.headers['x-api-key'] || req.headers.authorization?.split(' ')[1] || '';

  // 1. 检查是否允许公网访问
  if (!ALLOW_PUBLIC_API) {
    const ip = req.ip || req.connection.remoteAddress;
    if (!ip.startsWith('192.168.') && !ip.startsWith('10.') && !ip.startsWith('127.0.0.1')) {
      reply.status(403).send({ error: 'Forbidden: 仅允许局域网访问，如需公网请设置 ALLOW_PUBLIC_API=true' });
      return;
    }
  } else {
    // 2. 公网模式下，验证 Gateway API Key
    if (apiKey !== GATEWAY_API_KEY) {
      reply.status(401).send({ error: 'Gateway API Key 无效或缺失' });
      return;
    }
  }

  // 3. 检查上游配置
  if (!TARGET_API_URL || !TARGET_API_KEY) {
    reply.status(500).send({ error: 'TARGET_API_URL 或 TARGET_API_KEY 未设置' });
    return;
  }

  // 4. 转发请求到上游模型
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
// 启动服务
// ========================
loadTimeline();

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ Gateway 运行在 ${address}`);
});