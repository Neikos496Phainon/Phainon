require("dotenv").config();
const Fastify = require("fastify");
const fs = require("fs-extra");
const path = require("path");

const DEFAULT_BODY_LIMIT_MB = 50;

function readBodyLimitBytes() {
  const configured = Number(process.env.REQUEST_BODY_LIMIT_MB);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BODY_LIMIT_MB;
  return Math.floor(mb * 1024 * 1024);
}

const app = Fastify({
  logger: true,
  bodyLimit: readBodyLimitBytes()
});

app.register(require("@fastify/formbody"));

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TIMELINE_FILE = "enhanced_messages.json";
const TIMESTAMP_DB_FILE = "./message_timestamps.json";

// 批注 2026-07-17：管理页保存 .env 后要让 PM2 刷新进程环境；
// 保留原进程名，只补 --update-env，避免用户改完推送配置却继续运行旧值。
const DEFAULT_RESTART_COMMAND = "pm2 restart gateway wake-up --update-env";

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function configuredModelName() {
  // 批注 2026-07-15：/v1/models 要暴露部署者实际配置的模型名；
  // 不能继续硬编码示例模型，否则 Kelivo 模型选择会和真实上游不一致。
  return String(process.env.MODEL_NAME || "gateway-model").trim() || "gateway-model";
}

// ========================
// 多模态消息处理
// ========================

function shouldForwardMultimodalContent() {
  // 批注 2026-07-15：默认把 Kelivo 的图片 content 数组原样交给视觉模型；
  // 如果上游不是多模态模型，部署者仍可显式设 MULTIMODAL_MODE=text 退回旧的 [图片] 占位模式。
  const mode = (process.env.MULTIMODAL_MODE || "passthrough").trim().toLowerCase();
  return !["text", "plain", "placeholder", "false", "off", "0"].includes(mode);
}

function isDataImageUrl(value) {
  return typeof value === "string" && /^data:image\//i.test(value);
}

function isImageContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.image_url) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("image");
}

function isFileContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.file) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("file");
}

function getTextFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  if (type === "text" || type === "input_text") return part.text || part.content || "";
  if (typeof part.text === "string") return part.text;
  return "";
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    const parts = content
      .map(part => {
        const text = getTextFromContentPart(part).trim();
        if (text) return text;
        if (isImageContentPart(part)) return "[图片]";
        if (isFileContentPart(part)) return "[文件]";
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }

  if (isImageContentPart(content)) return "[图片]";
  if (isFileContentPart(content)) return "[文件]";
  return "[非文本内容]";
}

function normalizeMessageForTimeline(msg) {
  return {
    ...msg,
    content: normalizeContentToText(msg.content)
  };
}

function prepareMessageForLLM(msg) {
  if (msg.role === "assistant" && msg.tool_calls) return msg;
  if (msg.role === "tool") return msg;
  if (msg.role === "system") return {
    ...msg,
    content: normalizeContentToText(msg.content)
  };
  if (typeof msg.content === "string") return msg;
  if (Array.isArray(msg.content) && shouldForwardMultimodalContent()) return msg;
  const textContent = normalizeContentToText(msg.content);
  if (!textContent) return null;
  return {
    ...msg,
    content: textContent
  };
}

function sanitizeForLog(value) {
  if (typeof value === "string") {
    if (isDataImageUrl(value)) {
      const commaIndex = value.indexOf(",");
      const prefix = commaIndex >= 0 ? value.slice(0, commaIndex + 1) : value.slice(0, 40);
      return `${prefix}[base64 image omitted]`;
    }
    if (value.length > 1000) return `${value.slice(0, 1000)}... [truncated ${value.length - 1000} chars]`;
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeForLog);
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = sanitizeForLog(child);
    }
    return sanitized;
  }
  return value;
}

function summarizeMessageForLog(msg) {
  const parts = Array.isArray(msg?.content) ? msg.content : [msg?.content];
  const textChars = parts.reduce((sum, part) => sum + getTextFromContentPart(part).length, 0);
  return {
    role: msg?.role || "",
    content_type: Array.isArray(msg?.content) ? "multimodal" : typeof msg?.content,
    text_chars: textChars || normalizeContentToText(msg?.content).length,
    image_parts: parts.filter(isImageContentPart).length,
    file_parts: parts.filter(isFileContentPart).length,
    tool_calls: Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0
  };
}

function summarizeMessagesForLog(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let imageParts = 0;
  let fileParts = 0;
  let textChars = 0;
  for (const msg of list) {
    const item = summarizeMessageForLog(msg);
    roles[item.role] = (roles[item.role] || 0) + 1;
    imageParts += item.image_parts;
    fileParts += item.file_parts;
    textChars += item.text_chars;
  }
  return {
    total: list.length,
    roles,
    text_chars: textChars,
    image_parts: imageParts,
    file_parts: fileParts
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, """)
    .replace(/'/g, "'");
}

function safeJsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ========================
// 读取 timeline
// ========================

function loadTimeline() {
  if (!fs.existsSync(TIMELINE_FILE)) return [];
  try {
    return fs.readJsonSync(TIMELINE_FILE);
  } catch {
    return [];
  }
}

// ========================
// 保存 timeline（保留 SP）
// ========================

function saveTimeline(messages) {
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(m => m.role !== "system");
  const trimmed = nonSP.slice(-49);
  const final = sp ? [sp, ...trimmed] : trimmed;
  fs.writeJsonSync(TIMELINE_FILE, final, { spaces: 2 });
}

// ========================
// 提取时间戳（支持多种格式）
// ========================

function parseTimestampLabel(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  const normalized = `${yyyy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${minute}`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stripLeadingTimestamp(content) {
  // 批注 2026-07-15：兼容 Kelivo 有时把日期和时间贴在一起的前缀；
  // 旧格式 "YYYY-MM-DD HH:mm" 继续保留，新格式 "YYYY-MM-DDHH:mm" 不再导致时间记忆/排序失效。
  return String(content || "")
    .replace(/^（?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}[）\s]*/, "")
    .trim();
}

function extractTimestamp(content) {
  return parseTimestampLabel(content);
}

// ========================
// 时间戳记忆库
// ========================

function loadTimestampDB() {
  if (!fs.existsSync(TIMESTAMP_DB_FILE)) return {};
  try {
    return fs.readJsonSync(TIMESTAMP_DB_FILE);
  } catch {
    return {};
  }
}

function saveTimestampDB(db) {
  fs.writeJsonSync(TIMESTAMP_DB_FILE, db, { spaces: 2 });
}

function makeFingerprint(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = raw.trim().slice(0, 150);
  return `${msg.role}::${content}`;
}

function makeFingerprintStripped(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = stripLeadingTimestamp(raw).slice(0, 150);
  return `${msg.role}::${content}`;
}

function extractTimestampWithMemory(msg, tsDB) {
  const fromContent = extractTimestamp(normalizeContentToText(msg.content));
  if (fromContent) return fromContent;
  const fp = makeFingerprint(msg);
  if (tsDB[fp]) return new Date(tsDB[fp]);
  const fpStripped = makeFingerprintStripped(msg);
  if (tsDB[fpStripped]) return new Date(tsDB[fpStripped]);
  return null;
}

// ========================
// 消息判断
// ========================

function isSpecialEvent(msg) {
  if (msg.role !== "assistant") return false;
  const c = normalizeContentToText(msg.content);
  // 批注 2026-07-11：推送渠道从 Bark 扩展到 ntfy；
  // 继续兼容早期时间线里的 Bark/宝宝事件，避免升级后旧唤醒事件丢失。
  return (
    c.includes("刚刚给宝宝发了 Bark") ||
    c.includes("刚刚给用户发了 Bark") ||
    c.includes("自动唤醒：本次未发送 Bark") ||
    c.includes("自动唤醒：本次未发送推送") ||
    (c.includes("刚刚给用户发了") && c.includes("推送"))
  );
}

function isRealMessageForTimeline(msg) {
  if (msg.role === "system") return false;
  if (msg.tool_calls) return false;
  if (isSpecialEvent(msg)) return false;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("")) return false;
  return msg.role === "user" || msg.role === "assistant";
}

function isSystemRule(msg) {
  if (msg.role === "system") return true;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("")) return true;
  return false;
}

// ========================
// 构建 Timeline
// ========================

function buildTimeline(kelivoMessages, tsDB) {
  const oldTimeline = loadTimeline();

  const newSystemMessages = kelivoMessages
    .filter(msg => msg.role === "system")
    .map(normalizeMessageForTimeline);
  const latestSP = newSystemMessages.length > 0 ? newSystemMessages[newSystemMessages.length - 1] : null;
  const oldSP = oldTimeline.find(msg => msg.role === "system");

  const newRealMessages = kelivoMessages
    .filter(isRealMessageForTimeline)
    .map(normalizeMessageForTimeline);

  const oldSpecialEvents = oldTimeline
    .filter(isSpecialEvent)
    .sort((a, b) => {
      const timeA = extractTimestampWithMemory(a, tsDB);
      const timeB = extractTimestampWithMemory(b, tsDB);
      if (timeA && timeB) return timeA - timeB;
      return 0;
    });

  const merged = [...newRealMessages];
  for (const event of oldSpecialEvents) {
    const eventTime = extractTimestampWithMemory(event, tsDB);
    if (!eventTime) {
      merged.push(event);
      continue;
    }
    let inserted = false;
    for (let i = 0; i < merged.length; i++) {
      const msgTime = extractTimestampWithMemory(merged[i], tsDB);
      if (msgTime && msgTime >= eventTime) {
        merged.splice(i, 0, event);
        inserted = true;
        break;
      }
    }
    if (!inserted) merged.push(event);
  }

  const seen = new Set();
  const unique = merged.filter(msg => {
    const key = JSON.stringify({ role: msg.role, content: msg.content });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const result = [];
  if (latestSP) result.push({ ...latestSP, position: 0 });
  else if (oldSP) result.push({ ...oldSP, position: 0 });

  let realPos = 1;
  const finalMessages = [];
  let pendingSpecial = [];

  for (const msg of unique) {
    if (isSpecialEvent(msg)) {
      pendingSpecial.push(msg);
    } else {
      if (pendingSpecial.length > 0) {
        const prevRealPos = realPos - 1;
        const step = 1 / (pendingSpecial.length + 1);
        for (let i = 0; i < pendingSpecial.length; i++) {
          finalMessages.push({
            ...pendingSpecial[i],
            position: parseFloat((prevRealPos + step * (i + 1)).toFixed(4))
          });
        }
        pendingSpecial = [];
      }
      finalMessages.push({ ...msg, position: realPos });
      realPos++;
    }
  }

  if (pendingSpecial.length > 0) {
    const lastRealPos = realPos - 1;
    for (let i = 0; i < pendingSpecial.length; i++) {
      finalMessages.push({
        ...pendingSpecial[i],
        position: parseFloat((lastRealPos + 0.3 * (i + 1)).toFixed(4))
      });
    }
  }

  result.push(...finalMessages);
  return result;
}

// ========================
// 追加特殊事件
// ========================

function appendSpecialEvent(content) {
  const timeline = loadTimeline();
  let maxPos = 0;
  for (const msg of timeline) {
    if (msg.position && msg.position > maxPos) maxPos = msg.position;
  }
  const newEvent = {
    role: "assistant",
    content,
    position: maxPos + 0.5
  };
  timeline.push(newEvent);
  saveTimeline(timeline);
  // 批注 2026-07-15：特殊事件可能包含推送正文；日志只记录长度，避免公开部署时泄漏私密内容。
  console.log(`\n已记录特殊事件 (position ${newEvent.position}, chars ${normalizeContentToText(content).length})\n`);
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

let wakeUpLastHeartbeat = null;

// ========================
// 预设方案
// ========================

const PRESETS_FILE = "./presets.json";
const ENV_FILE = ".env";

const PREFERRED_ENV_ORDER = [
  "TARGET_API_URL",
  "TARGET_API_KEY",
  "GATEWAY_API_KEY",
  "MODEL_NAME",
  "BARK_KEY",
  "CUSTOM_ICON_URL",
  "ALLOW_PUBLIC_API",
  "PUSH_PROVIDER",
  "NTFY_SERVER_URL",
  "NTFY_TOPIC",
  "NTFY_TOKEN",
  "NTFY_PRIORITY",
  "NTFY_TAGS",
  "DIARY_ENABLED",
  "DIARY_DIR",
  "REQUEST_BODY_LIMIT_MB",
  "MULTIMODAL_MODE",
  "DAY_WAKE_AFTER_MINUTES",
  "NIGHT_WAKE_AFTER_MINUTES",
  "DAY_CHECK_INTERVAL_MINUTES",
  "NIGHT_CHECK_INTERVAL_MINUTES",
  "WAKE_DAY_START_HOUR",
  "WAKE_DAY_END_HOUR",
  "WEATHER_ENABLED",
  "WEATHER_LOCATION_NAME",
  "WEATHER_LAT",
  "WEATHER_LON",
  "WEATHER_UNITS",
  "PORT",
  "GATEWAY_BASE_URL",
  "TIME_ZONE",
  "RESTART_COMMAND",
  "ADMIN_USER",
  "ADMIN_PASSWORD"
];

function loadPresets() {
  if (!fs.existsSync(PRESETS_FILE)) return [];
  try {
    return fs.readJsonSync(PRESETS_FILE);
  } catch {
    return [];
  }
}

function savePresets(presets) {
  fs.writeJsonSync(PRESETS_FILE, presets, { spaces: 2 });
}

function wantsJsonResponse(req) {
  const contentType = req.headers["content-type"] || "";
  const accept = req.headers.accept || "";
  return contentType.includes("application/json") || accept.includes("application/json");
}

function loadEnvFileObject() {
  const result = {};
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      result[key] = value;
    }
  } catch {}
  return result;
}

function serializeEnvValue(value) {
  return String(value ?? "").replace(/\r?\n/g, "\\n");
}

function writeEnvUpdates(updates) {
  const merged = { ...loadEnvFileObject(), ...updates };
  const orderedKeys = [
    ...PREFERRED_ENV_ORDER.filter(key => Object.prototype.hasOwnProperty.call(merged, key)),
    ...Object.keys(merged).filter(key => !PREFERRED_ENV_ORDER.includes(key)).sort()
  ];
  const lines = orderedKeys.map(key => `${key}=${serializeEnvValue(merged[key])}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

function readRestartCommand() {
  return readEnvValue("RESTART_COMMAND") || DEFAULT_RESTART_COMMAND;
}

// ========================
// 安全：放行 /admin，其他仅本地/局域网
// ========================

app.addHook("onRequest", (req, reply, done) => {
  if (req.url.startsWith("/admin")) return done();

  // 批注 2026-07-15：公网部署常经过反代，真实公网请求可能在 Node 侧显示为 127/10 网段；
  // 所以 ALLOW_PUBLIC_API=true 后必须先验 /v1 的网关 key，避免被云平台内网 IP 绕过。
  if (readBooleanEnv("ALLOW_PUBLIC_API", false) && req.url.startsWith("/v1/")) {
    const configuredKey = readEnvValue("GATEWAY_API_KEY");
    if (!configuredKey) {
      reply.code(401).send({ error: "公网 /v1 已开启，但 GATEWAY_API_KEY 未配置" });
      return;
    }
    const auth = String(req.headers.authorization || "");
    const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
    const headerKey = String(req.headers["x-gateway-api-key"] || req.headers["x-api-key"] || "").trim();
    if (bearer === configuredKey || headerKey === configuredKey) return done();
    reply.code(401).send({ error: "Gateway API Key 无效或缺失" });
    return;
  }

  const ip = req.ip || req.connection.remoteAddress;
  const isTrustedNetwork = ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
  if (isTrustedNetwork) return done();
  reply.code(403).send("Forbidden");
});

// ========================
// Models
// ========================

app.get("/v1/models", async (req, reply) => {
  reply.send({
    object: "list",
    data: [{
      id: configuredModelName(),
      object: "model",
      created: 0,
      owned_by: "gateway"
    }]
  });
});

// ========================
// Chat Completions
// ========================

app.post("/v1/chat/completions", async (req, reply) => {
  try {
    const body = req.body;

    // 批注 2026-07-15：公开部署时日志不能默认写入完整上下文；
    // 这里只保留请求摘要，避免 system prompt、记忆和聊天正文进入 pm2 日志。
    console.log(JSON.stringify({
      event: "kelivo_request",
      model: body?.model || "",
      stream: body?.stream === true,
      messages: summarizeMessagesForLog(body?.messages || [])
    }));

    const kelivoMessages = body.messages || [];

    const oldTimeline = loadTimeline();
    const tsDB = loadTimestampDB();
    let tsDBDirty = false;

    for (const msg of kelivoMessages) {
      if (msg.role === "system") continue;
      if (msg.role === "tool") continue;
      const ts = extractTimestamp(normalizeContentToText(msg.content));
      if (!ts) continue;
      const fp = makeFingerprint(msg);
      const fpStripped = makeFingerprintStripped(msg);
      if (!tsDB[fp]) {
        tsDB[fp] = ts.toISOString();
        tsDBDirty = true;
      }
      if (!tsDB[fpStripped]) {
        tsDB[fpStripped] = ts.toISOString();
        tsDBDirty = true;
      }
    }

    if (tsDBDirty) saveTimestampDB(tsDB);

    const finalTimeline = buildTimeline(kelivoMessages, tsDB);
    saveTimeline(finalTimeline);

    // Kelivo 发图时 content 常是数组。默认原样透传给视觉模型；
    // 如上游不支持图片，可设置 MULTIMODAL_MODE=text 退回文本占位。
    const llmMessages = kelivoMessages
      .map(prepareMessageForLLM)
      .filter(Boolean);

    const oldEvents = stripPosition(
      oldTimeline.filter(isSpecialEvent).sort((a, b) => {
        const timeA = extractTimestampWithMemory(a, tsDB);
        const timeB = extractTimestampWithMemory(b, tsDB);
        if (timeA && timeB) return timeA - timeB;
        return 0;
      })
    );

    console.log("本次注入的特殊事件数量:", oldEvents.length);

    for (const event of oldEvents) {
      const eventTime = extractTimestampWithMemory(event, tsDB);
      if (!eventTime) {
        llmMessages.push(event);
        continue;
      }
      let inserted = false;
      for (let i = 0; i < llmMessages.length; i++) {
        const msgTime = extractTimestampWithMemory(llmMessages[i], tsDB);
        if (msgTime && msgTime >= eventTime) {
          llmMessages.splice(i, 0, event);
          inserted = true;
          break;
        }
      }
      if (!inserted) llmMessages.push(event);
    }

    console.log(JSON.stringify({
      event: "llm_forward_summary",
      messages: summarizeMessagesForLog(llmMessages)
    }));

    // ---- 自动修复不完整的 tool 调用（双向清理） ----
    // 第一遍：标记需要移除的索引
    const removeSet = new Set();

    // 检查 assistant tool_calls 是否完整
    for (let i = 0; i < llmMessages.length; i++) {
      const msg = llmMessages[i];
      if (msg.role !== "assistant" || !msg.tool_calls) continue;

      const expectedIds = msg.tool_calls.map(tc => tc.id);
      const followingTools = [];
      for (let j = i + 1; j < llmMessages.length; j++) {
        const nxt = llmMessages[j];
        if (nxt.role === "tool") {
          followingTools.push(nxt);
        } else {
          break;
        }
      }
      const foundIds = followingTools.map(t => t.tool_call_id);
      const complete = expectedIds.every(id => foundIds.includes(id));

      if (!complete) {
        // 标记这条 assistant 为移除，同时标记它后面的所有 tool 消息也移除
        removeSet.add(i);
        for (let j = i + 1; j < llmMessages.length; j++) {
          if (llmMessages[j].role === "tool") {
            removeSet.add(j);
          } else {
            break;
          }
        }
        console.log(`⚠️ 自动修复：移除不完整的 tool_calls (索引 ${i})`);
      }
    }

    // 检查孤立 tool 消息（前面没有对应的 tool_calls）
    for (let i = 0; i < llmMessages.length; i++) {
      if (llmMessages[i].role !== "tool") continue;
      // 向前查找最近的 assistant
      let hasMatchingToolCalls = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = llmMessages[j];
        if (prev.role === "assistant" && prev.tool_calls) {
          // 检查这个 tool_call_id 是否在 assistant 的 tool_calls 中
          const ids = prev.tool_calls.map(tc => tc.id);
          if (ids.includes(llmMessages[i].tool_call_id)) {
            hasMatchingToolCalls = true;
          }
          break;
        } else if (prev.role === "tool") {
          continue; // 继续向前找
        } else {
          break; // 遇到 user 或其他消息，停止
        }
      }
      if (!hasMatchingToolCalls) {
        removeSet.add(i);
        console.log(`⚠️ 自动修复：移除孤立的 tool 消息 (索引 ${i})`);
      }
    }

    // 按索引从大到小删除，避免索引错乱
    const sortedRemove = Array.from(removeSet).sort((a, b) => b - a);
    for (const idx of sortedRemove) {
      llmMessages.splice(idx, 1);
    }

    if (!TARGET_API_URL || !process.env.TARGET_API_KEY) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY 未配置" });
    }

    const requestedStream = body?.stream === true;

    // 请求模型
    const response = await fetch(TARGET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TARGET_API_KEY}`
      },
      body: JSON.stringify({
        ...body,
        messages: llmMessages
      })
    });

    const upstreamContentType = response.headers.get("content-type") || "";
    const shouldStreamResponse = requestedStream || upstreamContentType.includes("text/event-stream");

    // 批注 2026-07-11：Kelivo 关闭 stream 时需要收到普通 JSON；
    // 只在请求或上游确认为 SSE 时才按流式直通。
    if (!shouldStreamResponse) {
      const responseText = await response.text();
      return reply
        .code(response.status)
        .header("Content-Type", upstreamContentType || "application/json")
        .send(responseText);
    }

    if (!response.body) {
      return reply.code(response.status).send({ error: "上游 API 没有返回可读取的响应体" });
    }

    reply.raw.writeHead(response.status, {
      "Content-Type": upstreamContentType || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.raw.write(value);
    }
    reply.raw.end();

  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 内部接口：记录唤醒事件
// ========================

app.post("/internal/wake-event", async (req, reply) => {
  try {
    const { content } = req.body;
    if (!content) return reply.code(400).send({ error: "content is required" });
    appendSpecialEvent(content);
    reply.send({ success: true });
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 读取 .env 值
// ========================

function readEnvValue(key) {
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(key + "=")) return trimmed.substring(key.length + 1).trim();
    }
  } catch {}
  return process.env[key] || "";
}

function readEnvValueOrDefault(key, fallback) {
  const value = readEnvValue(key);
  return value === "" ? fallback : value;
}

function normalizePositiveInteger(value, key, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1) return String(Math.floor(n));
  return readEnvValueOrDefault(key, fallback);
}

function normalizeHour(value, key, fallback, min, max) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= min && n <= max) return String(Math.floor(n));
  return readEnvValueOrDefault(key, fallback);
}

function normalizeBooleanString(value, key, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return "true";
  if (["false", "0", "no", "off"].includes(raw)) return "false";
  return readEnvValueOrDefault(key, fallback);
}

function normalizeWeatherUnits(value) {
  return String(value || "").trim().toLowerCase() === "fahrenheit" ? "fahrenheit" : "metric";
}

function diaryDirectoryPath() {
  const configured = readEnvValueOrDefault("DIARY_DIR", "diary");
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function readDiaryEntries(limit = 20) {
  const dir = diaryDirectoryPath();
  try {
    if (!fs.existsSync(dir)) return [];

    // 批注 2026-07-15：管理页只读展示 wake-up 生成的本地日记；
    // 只读取 DIARY_DIR 下的 .md 文件，避免把任意路径内容暴露到 admin 页面。
    return fs.readdirSync(dir)
      .filter(name => /^[^/\\]+\.md$/i.test(name))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit)
      .map(name => {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf-8").slice(0, 24000);
        return { name, updated_at: stat.mtime.toISOString(), content };
      });
  } catch (err) {
    return [{
      name: "读取日记失败",
      updated_at: new Date().toISOString(),
      content: err.message || String(err)
    }];
  }
}

// ========================
// HTTP Basic Auth
// ========================

function basicAuth(req, reply, done) {
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
    return;
  }

  const decoded = Buffer.from(encoded, "base64").toString();
  const colonIndex = decoded.indexOf(":");
  const user = decoded.substring(0, colonIndex);
  const password = decoded.substring(colonIndex + 1);

  if (user === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
    done();
  } else {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
  }
}

// ========================
// 管理页面 GET /admin
// ========================

app.get("/admin", { preHandler: basicAuth }, async (req, reply) => {
  const serverUptime = Math.floor(process.uptime());
  const wakeUpStatus = wakeUpLastHeartbeat ?
    `在线（上次心跳: ${new Date(wakeUpLastHeartbeat).toLocaleString("zh-CN")}）` :
    "离线或未启动";

  const currentUrl = readEnvValue("TARGET_API_URL");
  const currentModel = readEnvValue("MODEL_NAME");
  const currentIcon = readEnvValue("CUSTOM_ICON_URL");
  const gatewayKeyStatus = readEnvValue("GATEWAY_API_KEY") ? "已配置" : "未配置";

  const wakeConfig = {
    dayWakeAfter: readEnvValueOrDefault("DAY_WAKE_AFTER_MINUTES", "60"),
    nightWakeAfter: readEnvValueOrDefault("NIGHT_WAKE_AFTER_MINUTES", "120"),
    dayCheckInterval: readEnvValueOrDefault("DAY_CHECK_INTERVAL_MINUTES", "10"),
    nightCheckInterval: readEnvValueOrDefault("NIGHT_CHECK_INTERVAL_MINUTES", "120"),
    dayStartHour: readEnvValueOrDefault("WAKE_DAY_START_HOUR", "10"),
    dayEndHour: readEnvValueOrDefault("WAKE_DAY_END_HOUR", "24")
  };

  const weatherConfig = {
    enabled: readEnvValueOrDefault("WEATHER_ENABLED", "false"),
    locationName: readEnvValue("WEATHER_LOCATION_NAME"),
    lat: readEnvValue("WEATHER_LAT"),
    lon: readEnvValue("WEATHER_LON"),
    units: readEnvValueOrDefault("WEATHER_UNITS", "metric")
  };

  const diaryEntries = readDiaryEntries(20);
  const diaryHtml = diaryEntries.length ?
    diaryEntries.map(entry => `
      <tr>
        <td>${escapeHtml(entry.name)}</td>
        <td>${escapeHtml(new Date(entry.updated_at).toLocaleString("zh-CN"))}</td>
        <td><pre>${escapeHtml(entry.content)}</pre></td>
      </tr>
    `).join("") :
    `<tr><td colspan="3">还没有日记。模型在 wake-up 回复里输出 [DIARY]...[/DIARY] 后会保存到这里。</td></tr>`;

  const authToken = Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString("base64");
  const presets = loadPresets();
  const presetsJson = safeJsonForInlineScript(presets);
  const authHeaderJson = safeJsonForInlineScript(`Basic ${authToken}`);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HEARTBEAT · Runtime</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1.5rem; background: #f9fafb; color: #111827; }
    h1 { font-size: 1.8rem; margin-bottom: 0.5rem; color: #0b3b5c; }
    .subtitle { color: #4b5563; margin-top: -0.25rem; margin-bottom: 1.5rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.75rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 2rem; }
    @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
    .card { background: #ffffff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); padding: 1.25rem 1.5rem; border: 1px solid #e5e7eb; }
    .card h2 { font-size: 1rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.025em; color: #6b7280; margin-top: 0; margin-bottom: 0.75rem; }
    .label { font-size: 0.85rem; color: #6b7280; margin-top: 0.5rem; }
    .value { font-weight: 500; word-break: break-all; }
    .status-badge { display: inline-block; background: #10b981; color: white; font-size: 0.75rem; padding: 0.15rem 0.7rem; border-radius: 9999px; }
    .status-offline { background: #ef4444; }
    pre { background: #f3f4f6; padding: 0.75rem; border-radius: 8px; overflow: auto; font-size: 0.85rem; max-height: 180px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th { text-align: left; padding: 0.5rem 0.25rem; border-bottom: 1px solid #e5e7eb; color: #4b5563; }
    td { padding: 0.5rem 0.25rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    .action-btn { background: #2563eb; color: white; border: none; padding: 0.4rem 1rem; border-radius: 6px; font-size: 0.8rem; cursor: pointer; }
    .action-btn:hover { background: #1d4ed8; }
    .danger-btn { background: #dc2626; }
    .danger-btn:hover { background: #b91c1c; }
    .mt-2 { margin-top: 0.75rem; }
    .flex { display: flex; gap: 0.75rem; flex-wrap: wrap; }
    input, select { border: 1px solid #d1d5db; border-radius: 6px; padding: 0.3rem 0.6rem; font-size: 0.85rem; width: 100%; box-sizing: border-box; }
    .form-row { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
    .form-row label { min-width: 7rem; font-size: 0.85rem; }
    .form-row input { flex: 1; }
  </style>
</head>
<body>
  <h1>⚡ HEARTBEAT · Runtime</h1>
  <div class="subtitle">Dylan Gateway 管理面板</div>

  <div class="grid">
    <div class="card">
      <h2>📡 服务状态</h2>
      <div><span class="status-badge">● 运行中</span></div>
      <div class="label">运行时间</div>
      <div class="value">${Math.floor(serverUptime / 60)}m ${serverUptime % 60}s</div>
      <div class="label">唤醒服务</div>
      <div class="value">${wakeUpStatus}</div>
    </div>

    <div class="card">
      <h2>🔑 当前配置</h2>
      <div class="label">上游模型 URL</div>
      <div class="value">${escapeHtml(currentUrl || '未配置')}</div>
      <div class="label">模型名称</div>
      <div class="value">${escapeHtml(currentModel || '未配置')}</div>
      <div class="label">Gateway Key</div>
      <div class="value">${gatewayKeyStatus}</div>
    </div>
  </div>

  <div class="card" style="margin-bottom: 1.5rem;">
    <h2>🌤️ 唤醒配置</h2>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.5rem;">
      <div><span class="label">白天唤醒间隔</span><br><span class="value">${wakeConfig.dayWakeAfter} 分钟</span></div>
      <div><span class="label">夜间唤醒间隔</span><br><span class="value">${wakeConfig.nightWakeAfter} 分钟</span></div>
      <div><span class="label">白天检查间隔</span><br><span class="value">${wakeConfig.dayCheckInterval} 分钟</span></div>
      <div><span class="label">夜间检查间隔</span><br><span class="value">${wakeConfig.nightCheckInterval} 分钟</span></div>
      <div><span class="label">唤醒时段</span><br><span class="value">${wakeConfig.dayStartHour}:00 - ${wakeConfig.dayEndHour}:00</span></div>
    </div>
    ${weatherConfig.enabled === 'true' ? `
      <div style="margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid #e5e7eb;">
        <span class="label">天气位置</span>
        <span class="value">${escapeHtml(weatherConfig.locationName || '未设置')} (${weatherConfig.lat || '?'}, ${weatherConfig.lon || '?'})</span>
      </div>
    ` : ''}
  </div>

  <div class="card" style="margin-bottom: 1.5rem;">
    <h2>📖 最近日记</h2>
    <table>
      <thead><tr><th>文件</th><th>更新</th><th>内容预览</th></tr></thead>
      <tbody>${diaryHtml}</tbody>
    </table>
  </div>

  <div class="card" style="margin-bottom: 1.5rem;">
    <h2>⚙️ 预设方案</h2>
    <div id="presets-container"></div>
    <div class="flex mt-2">
      <button class="action-btn" onclick="applyPreset()">应用选中预设</button>
      <button class="action-btn" onclick="reloadEnv()">重新加载 .env</button>
      <button class="action-btn" onclick="restartService()">重启服务</button>
      <button class="action-btn danger-btn" onclick="clearTimeline()">清空 Timeline</button>
    </div>
    <div id="preset-result" style="margin-top: 0.75rem; font-size: 0.9rem;"></div>
  </div>

  <script>
    const presets = ${presetsJson};
    const authHeader = ${authHeaderJson};

    function renderPresets() {
      const container = document.getElementById('presets-container');
      if (!presets || presets.length === 0) {
        container.innerHTML = '<p style="color: #6b7280;">暂无预设方案。可在 presets.json 中定义。</p>';
        return;
      }
      let html = '<select id="preset-select" style="width: 100%; padding: 0.4rem; border-radius: 6px; border: 1px solid #d1d5db;">';
      for (const p of presets) {
        html += `<option value="${p.id || p.name || ''}">${p.name || p.id || '未命名'}</option>`;
      }
      html += '</select>';
      container.innerHTML = html;
    }

    async function apiCall(endpoint, method = 'POST', body = null) {
      const options = {
        method,
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        }
      };
      if (body) options.body = JSON.stringify(body);
      const resp = await fetch(endpoint, options);
      return resp.json();
    }

    async function applyPreset() {
      const select = document.getElementById('preset-select');
      const id = select.value;
      const result = document.getElementById('preset-result');
      if (!id) {
        result.textContent = '请选择一个预设方案';
        return;
      }
      try {
        const data = await apiCall('/admin/apply-preset', 'POST', { id });
        result.textContent = data.message || '预设已应用';
        if (data.changes) {
          result.textContent += ' 变更: ' + JSON.stringify(data.changes);
        }
      } catch (err) {
        result.textContent = '错误: ' + err.message;
      }
    }

    async function reloadEnv() {
      const result = document.getElementById('preset-result');
      try {
        const data = await apiCall('/admin/reload-env', 'POST');
        result.textContent = data.message || '.env 已重新加载';
      } catch (err) {
        result.textContent = '错误: ' + err.message;
      }
    }

    async function restartService() {
      const result = document.getElementById('preset-result');
      if (!confirm('确定要重启服务吗？')) return;
      try {
        const data = await apiCall('/admin/restart', 'POST');
        result.textContent = data.message || '重启命令已执行';
      } catch (err) {
        result.textContent = '错误: ' + err.message;
      }
    }

    async function clearTimeline() {
      const result = document.getElementById('preset-result');
      if (!confirm('确定要清空 Timeline 吗？此操作不可恢复！')) return;
      try {
        const data = await apiCall('/admin/clear-timeline', 'POST');
        result.textContent = data.message || 'Timeline 已清空';
      } catch (err) {
        result.textContent = '错误: ' + err.message;
      }
    }

    renderPresets();
  </script>
</body>
</html>
  `;

  reply.header("Content-Type", "text/html");
  reply.send(html);
});

// ========================
// 管理接口
// ========================

app.post("/admin/apply-preset", { preHandler: basicAuth }, async (req, reply) => {
  const { id } = req.body;
  if (!id) return reply.code(400).send({ error: "缺少 preset id" });

  const presets = loadPresets();
  const preset = presets.find(p => (p.id || p.name) === id);
  if (!preset) return reply.code(404).send({ error: "预设方案不存在" });

  const updates = {};
  const changed = [];
  for (const key of Object.keys(preset)) {
    if (key === "id" || key === "name") continue;
    if (preset[key] !== undefined && preset[key] !== null) {
      updates[key] = String(preset[key]);
      changed.push(key);
    }
  }

  writeEnvUpdates(updates);
  return reply.send({
    message: `预设 "${preset.name || id}" 已应用，重启后生效`,
    changes: changed
  });
});

app.post("/admin/reload-env", { preHandler: basicAuth }, async (req, reply) => {
  // 重新读取 .env 文件到 process.env
  const envContent = fs.readFileSync(ENV_FILE, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    process.env[key] = value;
  }
  return reply.send({ message: ".env 已重新加载" });
});

app.post("/admin/restart", { preHandler: basicAuth }, async (req, reply) => {
  // 使用预设或默认重启命令
  const cmd = readRestartCommand();
  try {
    const { exec } = require("child_process");
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`重启执行失败: ${error}`);
        return;
      }
      console.log(`重启命令输出: ${stdout}`);
    });
    return reply.send({ message: `已执行重启命令: ${cmd}` });
  } catch (err) {
    return reply.code(500).send({ error: err.message });
  }
});

app.post("/admin/clear-timeline", { preHandler: basicAuth }, async (req, reply) => {
  try {
    fs.writeJsonSync(TIMELINE_FILE, [], { spaces: 2 });
    return reply.send({ message: "Timeline 已清空" });
  } catch (err) {
    return reply.code(500).send({ error: err.message });
  }
});

// ========================
// 启动服务
// ========================

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ Gateway 运行在 ${address}`);
});