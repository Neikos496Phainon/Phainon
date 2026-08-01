require("dotenv").config();

const Fastify = require("fastify");
const fs = require("fs-extra");
const path = require("path");
const {
  formatDateTimeInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");

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
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const TIME_ZONE = resolveTimeZone();
const IS_RAILWAY_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID
);
const TIMELINE_FILE = path.join(DATA_DIR, "enhanced_messages.json");
const TIMESTAMP_DB_FILE = path.join(DATA_DIR, "message_timestamps.json");
// Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-17Ã¯Â¼ÂÃ§Â®Â¡Ã§ÂÂÃ©Â¡ÂµÃ¤Â¿ÂÃ¥Â­Â .env Ã¥ÂÂÃ¨Â¦ÂÃ¨Â®Â© PM2 Ã¥ÂÂ·Ã¦ÂÂ°Ã¨Â¿ÂÃ§Â¨ÂÃ§ÂÂ¯Ã¥Â¢ÂÃ¯Â¼ÂÃ¤Â¿ÂÃ§ÂÂÃ¥ÂÂÃ¨Â¿ÂÃ§Â¨ÂÃ¥ÂÂÃ¯Â¼Â
// Ã¥ÂÂªÃ¨Â¡Â¥ --update-envÃ¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ§ÂÂ¨Ã¦ÂÂ·Ã¦ÂÂ¹Ã¥Â®ÂÃ¦ÂÂ¨Ã©ÂÂÃ©ÂÂÃ§Â½Â®Ã¥ÂÂ´Ã§Â»Â§Ã§Â»Â­Ã¨Â¿ÂÃ¨Â¡ÂÃ¦ÂÂ§Ã¥ÂÂ¼Ã£ÂÂ
const DEFAULT_RESTART_COMMAND = "pm2 restart gateway wake-up --update-env";

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function configuredModelName() {
  // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼Â/v1/models Ã¨Â¦ÂÃ¦ÂÂ´Ã©ÂÂ²Ã©ÂÂ¨Ã§Â½Â²Ã¨ÂÂÃ¥Â®ÂÃ©ÂÂÃ©ÂÂÃ§Â½Â®Ã§ÂÂÃ¦Â¨Â¡Ã¥ÂÂÃ¥ÂÂÃ¯Â¼Â
  // Ã¤Â¸ÂÃ¨ÂÂ½Ã§Â»Â§Ã§Â»Â­Ã§Â¡Â¬Ã§Â¼ÂÃ§Â ÂÃ§Â¤ÂºÃ¤Â¾ÂÃ¦Â¨Â¡Ã¥ÂÂÃ¯Â¼ÂÃ¥ÂÂ¦Ã¥ÂÂ Kelivo Ã¦Â¨Â¡Ã¥ÂÂÃ©ÂÂÃ¦ÂÂ©Ã¤Â¼ÂÃ¥ÂÂÃ§ÂÂÃ¥Â®ÂÃ¤Â¸ÂÃ¦Â¸Â¸Ã¤Â¸ÂÃ¤Â¸ÂÃ¨ÂÂ´Ã£ÂÂ
  return String(process.env.MODEL_NAME || "gateway-model").trim() || "gateway-model";
}

// ========================
// Ã¥Â¤ÂÃ¦Â¨Â¡Ã¦ÂÂÃ¦Â¶ÂÃ¦ÂÂ¯Ã¥Â¤ÂÃ§ÂÂ
// ========================
function shouldForwardMultimodalContent() {
  // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼ÂÃ©Â»ÂÃ¨Â®Â¤Ã¦ÂÂ Kelivo Ã§ÂÂÃ¥ÂÂ¾Ã§ÂÂ content Ã¦ÂÂ°Ã§Â»ÂÃ¥ÂÂÃ¦Â Â·Ã¤ÂºÂ¤Ã§Â»ÂÃ¨Â§ÂÃ¨Â§ÂÃ¦Â¨Â¡Ã¥ÂÂÃ¯Â¼Â
  // Ã¥Â¦ÂÃ¦ÂÂÃ¤Â¸ÂÃ¦Â¸Â¸Ã¤Â¸ÂÃ¦ÂÂ¯Ã¥Â¤ÂÃ¦Â¨Â¡Ã¦ÂÂÃ¦Â¨Â¡Ã¥ÂÂÃ¯Â¼ÂÃ©ÂÂ¨Ã§Â½Â²Ã¨ÂÂÃ¤Â»ÂÃ¥ÂÂ¯Ã¦ÂÂ¾Ã¥Â¼ÂÃ¨Â®Â¾ MULTIMODAL_MODE=text Ã©ÂÂÃ¥ÂÂÃ¦ÂÂ§Ã§ÂÂ [Ã¥ÂÂ¾Ã§ÂÂ] Ã¥ÂÂ Ã¤Â½ÂÃ¦Â¨Â¡Ã¥Â¼ÂÃ£ÂÂ
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
        if (isImageContentPart(part)) return "[Ã¥ÂÂ¾Ã§ÂÂ]";
        if (isFileContentPart(part)) return "[Ã¦ÂÂÃ¤Â»Â¶]";
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }

  if (isImageContentPart(content)) return "[Ã¥ÂÂ¾Ã§ÂÂ]";
  if (isFileContentPart(content)) return "[Ã¦ÂÂÃ¤Â»Â¶]";
  return "[Ã©ÂÂÃ¦ÂÂÃ¦ÂÂ¬Ã¥ÂÂÃ¥Â®Â¹]";
}

function normalizeMessageForTimeline(msg) {
  return { ...msg, content: normalizeContentToText(msg.content) };
}

function prepareMessageForLLM(msg) {
  if (msg.role === "assistant" && msg.tool_calls) return msg;
  if (msg.role === "tool") return msg;
  if (msg.role === "system") return { ...msg, content: normalizeContentToText(msg.content) };
  if (typeof msg.content === "string") return msg;

  if (Array.isArray(msg.content) && shouldForwardMultimodalContent()) return msg;

  const textContent = normalizeContentToText(msg.content);
  if (!textContent) return null;
  return { ...msg, content: textContent };
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
  return { total: list.length, roles, text_chars: textChars, image_parts: imageParts, file_parts: fileParts };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
// Ã¨Â¯Â»Ã¥ÂÂ timeline
// ========================
function loadTimeline() {
  if (!fs.existsSync(TIMELINE_FILE)) return [];
  try { return fs.readJsonSync(TIMELINE_FILE); } catch { return []; }
}

// ========================
// Ã¤Â¿ÂÃ¥Â­Â timelineÃ¯Â¼ÂÃ¤Â¿ÂÃ§ÂÂ SPÃ¯Â¼Â
// ========================
function saveTimeline(messages) {
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(m => m.role !== "system");
  const trimmed = nonSP.slice(-49);
  const final = sp ? [sp, ...trimmed] : trimmed;
  fs.writeJsonSync(TIMELINE_FILE, final, { spaces: 2 });
}

// ========================
// Ã¦ÂÂÃ¥ÂÂÃ¦ÂÂ¶Ã©ÂÂ´Ã¦ÂÂ³Ã¯Â¼ÂÃ¦ÂÂ¯Ã¦ÂÂÃ¥Â¤ÂÃ§Â§ÂÃ¦Â Â¼Ã¥Â¼ÂÃ¯Â¼Â
// ========================
function parseTimestampLabel(value) {
  const text = String(value || "");
  const match = text.match(/Ã¯Â¼Â?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:Ã¯Â¼Â](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-30Ã¯Â¼ÂKelivo Ã¥ÂÂÃ¨Â¿ÂÃ¦Â¶ÂÃ¦ÂÂ¯Ã¥ÂÂÃ§Â¼ÂÃ§ÂÂÃ¦ÂÂ¯Ã§ÂÂ¨Ã¦ÂÂ·Ã©ÂÂÃ§Â½Â®Ã¦ÂÂ¶Ã¥ÂÂºÃ§ÂÂÃ¥Â¢ÂÃ¤Â¸ÂÃ¦ÂÂ¶Ã©ÂÂ´Ã¯Â¼Â
  // Ã¥ÂÂ¬Ã§Â½Â/Railway Ã¤Â¸ÂÃ¨ÂÂ½Ã¦ÂÂÃ¦ÂÂÃ¥ÂÂ¡Ã¥ÂÂ¨ UTC Ã¨Â§Â£Ã¦ÂÂÃ¯Â¼ÂÃ¥ÂÂ¦Ã¥ÂÂÃ¦ÂÂ¶Ã©ÂÂ´Ã§ÂºÂ¿Ã¥ÂÂÃ¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂÃ©ÂÂ½Ã¤Â¼ÂÃ¨Â¢Â«Ã¦ÂÂ¨Ã¨Â¿ÂÃ£ÂÂ
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function stripLeadingTimestamp(content) {
  // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼ÂÃ¥ÂÂ¼Ã¥Â®Â¹ Kelivo Ã¦ÂÂÃ¦ÂÂ¶Ã¦ÂÂÃ¦ÂÂ¥Ã¦ÂÂÃ¥ÂÂÃ¦ÂÂ¶Ã©ÂÂ´Ã¨Â´Â´Ã¥ÂÂ¨Ã¤Â¸ÂÃ¨ÂµÂ·Ã§ÂÂÃ¥ÂÂÃ§Â¼ÂÃ¯Â¼Â
  // Ã¦ÂÂ§Ã¦Â Â¼Ã¥Â¼Â "YYYY-MM-DD HH:mm" Ã§Â»Â§Ã§Â»Â­Ã¤Â¿ÂÃ§ÂÂÃ¯Â¼ÂÃ¦ÂÂ°Ã¦Â Â¼Ã¥Â¼Â "YYYY-MM-DDHH:mm" Ã¤Â¸ÂÃ¥ÂÂÃ¥Â¯Â¼Ã¨ÂÂ´Ã¦ÂÂ¶Ã©ÂÂ´Ã¨Â®Â°Ã¥Â¿Â/Ã¦ÂÂÃ¥ÂºÂÃ¥Â¤Â±Ã¦ÂÂÃ£ÂÂ
  return String(content || "")
    .replace(/^Ã¯Â¼Â?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:Ã¯Â¼Â]\d{2}[Ã¯Â¼Â\s]*/, "")
    .trim();
}

function extractTimestamp(content) {
  return parseTimestampLabel(content);
}

// ========================
// Ã¦ÂÂ¶Ã©ÂÂ´Ã¦ÂÂ³Ã¨Â®Â°Ã¥Â¿ÂÃ¥ÂºÂ
// ========================
function loadTimestampDB() {
  if (!fs.existsSync(TIMESTAMP_DB_FILE)) return {};
  try { return fs.readJsonSync(TIMESTAMP_DB_FILE); } catch { return {}; }
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
// Ã¦Â¶ÂÃ¦ÂÂ¯Ã¥ÂÂ¤Ã¦ÂÂ­
// ========================
function isSpecialEvent(msg) {
  if (msg.role !== "assistant") return false;
  const c = normalizeContentToText(msg.content);
  // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-11Ã¯Â¼ÂÃ¦ÂÂ¨Ã©ÂÂÃ¦Â¸Â Ã©ÂÂÃ¤Â»Â Bark Ã¦ÂÂ©Ã¥Â±ÂÃ¥ÂÂ° ntfyÃ¯Â¼ÂÃ§Â»Â§Ã§Â»Â­Ã¥ÂÂ¼Ã¥Â®Â¹Ã¦ÂÂ©Ã¦ÂÂÃ¦ÂÂ¶Ã©ÂÂ´Ã§ÂºÂ¿Ã©ÂÂÃ§ÂÂ Bark/Ã¥Â®ÂÃ¥Â®ÂÃ¤ÂºÂÃ¤Â»Â¶Ã¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ¥ÂÂÃ§ÂºÂ§Ã¥ÂÂÃ¦ÂÂ§Ã¥ÂÂ¤Ã©ÂÂÃ¤ÂºÂÃ¤Â»Â¶Ã¤Â¸Â¢Ã¥Â¤Â±Ã£ÂÂ
  return (
    c.includes("Ã¥ÂÂÃ¥ÂÂÃ§Â»ÂÃ¥Â®ÂÃ¥Â®ÂÃ¥ÂÂÃ¤ÂºÂ Bark") ||
    c.includes("Ã¥ÂÂÃ¥ÂÂÃ§Â»ÂÃ§ÂÂ¨Ã¦ÂÂ·Ã¥ÂÂÃ¤ÂºÂ Bark") ||
    c.includes("Ã¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¦ÂÂªÃ¥ÂÂÃ©ÂÂ Bark") ||
    c.includes("Ã¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¦ÂÂªÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂ") ||
    (c.includes("Ã¥ÂÂÃ¥ÂÂÃ§Â»ÂÃ§ÂÂ¨Ã¦ÂÂ·Ã¥ÂÂÃ¤ÂºÂ") && c.includes("Ã¦ÂÂ¨Ã©ÂÂ"))
  );
}

function isRealMessageForTimeline(msg) {
  if (msg.role === "system") return false;
  if (msg.tool_calls) return false;
  if (isSpecialEvent(msg)) return false;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return false;
  return msg.role === "user" || msg.role === "assistant";
}

function isSystemRule(msg) {
  if (msg.role === "system") return true;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return true;
  return false;
}

// ========================
// Ã¦ÂÂÃ¥Â»Âº Timeline
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

  const oldSpecialEvents = oldTimeline.filter(isSpecialEvent).sort((a, b) => {
    const timeA = extractTimestampWithMemory(a, tsDB);
    const timeB = extractTimestampWithMemory(b, tsDB);
    if (timeA && timeB) return timeA - timeB;
    return 0;
  });

  const merged = [...newRealMessages];
  for (const event of oldSpecialEvents) {
    const eventTime = extractTimestampWithMemory(event, tsDB);
    if (!eventTime) { merged.push(event); continue; }
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
          finalMessages.push({ ...pendingSpecial[i], position: parseFloat((prevRealPos + step * (i + 1)).toFixed(4)) });
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
      finalMessages.push({ ...pendingSpecial[i], position: parseFloat((lastRealPos + 0.3 * (i + 1)).toFixed(4)) });
    }
  }

  result.push(...finalMessages);
  return result;
}

// ========================
// Ã¨Â¿Â½Ã¥ÂÂ Ã§ÂÂ¹Ã¦Â®ÂÃ¤ÂºÂÃ¤Â»Â¶
// ========================
function appendSpecialEvent(content) {
  const timeline = loadTimeline();
  let maxPos = 0;
  for (const msg of timeline) {
    if (msg.position && msg.position > maxPos) maxPos = msg.position;
  }
  const newEvent = { role: "assistant", content, position: maxPos + 0.5 };
  timeline.push(newEvent);
  saveTimeline(timeline);
  // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼ÂÃ§ÂÂ¹Ã¦Â®ÂÃ¤ÂºÂÃ¤Â»Â¶Ã¥ÂÂ¯Ã¨ÂÂ½Ã¥ÂÂÃ¥ÂÂ«Ã¦ÂÂ¨Ã©ÂÂÃ¦Â­Â£Ã¦ÂÂÃ¯Â¼ÂÃ¦ÂÂ¥Ã¥Â¿ÂÃ¥ÂÂªÃ¨Â®Â°Ã¥Â½ÂÃ©ÂÂ¿Ã¥ÂºÂ¦Ã¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ¥ÂÂ¬Ã¥Â¼ÂÃ©ÂÂ¨Ã§Â½Â²Ã¦ÂÂ¶Ã¦Â³ÂÃ¦Â¼ÂÃ§Â§ÂÃ¥Â¯ÂÃ¥ÂÂÃ¥Â®Â¹Ã£ÂÂ
  console.log(`\nÃ¥Â·Â²Ã¨Â®Â°Ã¥Â½ÂÃ§ÂÂ¹Ã¦Â®ÂÃ¤ÂºÂÃ¤Â»Â¶ (position ${newEvent.position}, chars ${normalizeContentToText(content).length})\n`);
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

let wakeUpLastHeartbeat = null;

// ========================
// Ã©Â¢ÂÃ¨Â®Â¾Ã¦ÂÂ¹Ã¦Â¡Â
// ========================
const PRESETS_FILE = path.join(DATA_DIR, "presets.json");
const ENV_FILE = path.join(DATA_DIR, ".env");
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
  try { return fs.readJsonSync(PRESETS_FILE); } catch { return []; }
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
    ...Object.keys(merged)
      .filter(key => !PREFERRED_ENV_ORDER.includes(key))
      .sort()
  ];
  const lines = orderedKeys.map(key => `${key}=${serializeEnvValue(merged[key])}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

function readRestartCommand() {
  return readEnvValue("RESTART_COMMAND") || DEFAULT_RESTART_COMMAND;
}

// ========================
// Ã¥Â®ÂÃ¥ÂÂ¨Ã¯Â¼ÂÃ¦ÂÂ¾Ã¨Â¡Â /adminÃ¯Â¼ÂÃ¥ÂÂ¶Ã¤Â»ÂÃ¤Â»ÂÃ¦ÂÂ¬Ã¥ÂÂ°/Ã¥Â±ÂÃ¥ÂÂÃ§Â½Â
// ========================
app.addHook("onRequest", (req, reply, done) => {
  if (req.url.startsWith("/admin")) return done();
  // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼ÂÃ¥ÂÂ¬Ã§Â½ÂÃ©ÂÂ¨Ã§Â½Â²Ã¥Â¸Â¸Ã§Â»ÂÃ¨Â¿ÂÃ¥ÂÂÃ¤Â»Â£Ã¯Â¼ÂÃ§ÂÂÃ¥Â®ÂÃ¥ÂÂ¬Ã§Â½ÂÃ¨Â¯Â·Ã¦Â±ÂÃ¥ÂÂ¯Ã¨ÂÂ½Ã¥ÂÂ¨ Node Ã¤Â¾Â§Ã¦ÂÂ¾Ã§Â¤ÂºÃ¤Â¸Âº 127/10 Ã§Â½ÂÃ¦Â®ÂµÃ¯Â¼Â
  // Ã¦ÂÂÃ¤Â»Â¥ ALLOW_PUBLIC_API=true Ã¥ÂÂÃ¥Â¿ÂÃ©Â¡Â»Ã¥ÂÂÃ©ÂªÂ /v1 Ã§ÂÂÃ§Â½ÂÃ¥ÂÂ³ keyÃ¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ¨Â¢Â«Ã¤ÂºÂÃ¥Â¹Â³Ã¥ÂÂ°Ã¥ÂÂÃ§Â½Â IP Ã§Â»ÂÃ¨Â¿ÂÃ£ÂÂ
  if (readBooleanEnv("ALLOW_PUBLIC_API", false) && req.url.startsWith("/v1/")) {
    const configuredKey = readEnvValue("GATEWAY_API_KEY");
    if (!configuredKey) {
      reply.code(401).send({ error: "Ã¥ÂÂ¬Ã§Â½Â /v1 Ã¥Â·Â²Ã¥Â¼ÂÃ¥ÂÂ¯Ã¯Â¼ÂÃ¤Â½Â GATEWAY_API_KEY Ã¦ÂÂªÃ©ÂÂÃ§Â½Â®" });
      return;
    }
    const auth = String(req.headers.authorization || "");
    const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
    const headerKey = String(req.headers["x-gateway-api-key"] || req.headers["x-api-key"] || "").trim();
    if (bearer === configuredKey || headerKey === configuredKey) return done();
    // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-30Ã¯Â¼ÂKelivo Ã¥ÂÂ¯Ã¨ÂÂ½Ã¥ÂÂ¨Ã¦Â¨Â¡Ã¥ÂÂÃ¦ÂÂ¢Ã¦ÂµÂÃ¦ÂÂÃ¦ÂÂ§Ã©Â¢ÂÃ¨Â®Â¾Ã©ÂÂÃ§Â»Â§Ã§Â»Â­Ã¥Â¸Â¦Ã©ÂÂ keyÃ¯Â¼Â
    // Ã¥ÂÂªÃ¨Â®Â°Ã¨Â·Â¯Ã¥Â¾ÂÃ¥ÂÂ header Ã§Â±Â»Ã¥ÂÂÃ¯Â¼ÂÃ¥Â¸Â®Ã¥ÂÂ©Ã¦ÂÂÃ¦ÂÂ¥Ã§Â¼ÂÃ¥Â­Â/Ã©ÂÂÃ¥Â¤ÂÃ¨Â¯Â·Ã¦Â±ÂÃ¯Â¼ÂÃ§Â»ÂÃ¤Â¸ÂÃ¦ÂÂÃ¤Â»Â»Ã¦ÂÂÃ¥Â¯ÂÃ©ÂÂ¥Ã¥ÂÂÃ¥ÂÂ¥Ã¦ÂÂ¥Ã¥Â¿ÂÃ£ÂÂ
    console.warn(JSON.stringify({
      event: "gateway_auth_rejected",
      path: req.url.split("?")[0],
      auth_source: bearer ? "bearer" : headerKey ? "x-api-key" : "missing"
    }));
    reply.code(401).send({ error: "Gateway API Key Ã¦ÂÂ Ã¦ÂÂÃ¦ÂÂÃ§Â¼ÂºÃ¥Â¤Â±" });
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
    data: [{ id: configuredModelName(), object: "model", created: 0, owned_by: "gateway" }]
  });
});

// ========================
// Chat Completions
// ========================
app.post("/v1/chat/completions", async (req, reply) => {
  try {
    const body = req.body;
    // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼ÂÃ¥ÂÂ¬Ã¥Â¼ÂÃ©ÂÂ¨Ã§Â½Â²Ã¦ÂÂ¶Ã¦ÂÂ¥Ã¥Â¿ÂÃ¤Â¸ÂÃ¨ÂÂ½Ã©Â»ÂÃ¨Â®Â¤Ã¥ÂÂÃ¥ÂÂ¥Ã¥Â®ÂÃ¦ÂÂ´Ã¤Â¸ÂÃ¤Â¸ÂÃ¦ÂÂÃ¯Â¼Â
    // Ã¨Â¿ÂÃ©ÂÂÃ¥ÂÂªÃ¤Â¿ÂÃ§ÂÂÃ¨Â¯Â·Ã¦Â±ÂÃ¦ÂÂÃ¨Â¦ÂÃ¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂ system promptÃ£ÂÂÃ¨Â®Â°Ã¥Â¿ÂÃ¥ÂÂÃ¨ÂÂÃ¥Â¤Â©Ã¦Â­Â£Ã¦ÂÂÃ¨Â¿ÂÃ¥ÂÂ¥ pm2 Ã¦ÂÂ¥Ã¥Â¿ÂÃ£ÂÂ
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
      if (!tsDB[fp]) { tsDB[fp] = ts.toISOString(); tsDBDirty = true; }
      if (!tsDB[fpStripped]) { tsDB[fpStripped] = ts.toISOString(); tsDBDirty = true; }
    }
    if (tsDBDirty) saveTimestampDB(tsDB);

    const finalTimeline = buildTimeline(kelivoMessages, tsDB);
    saveTimeline(finalTimeline);

    // Kelivo Ã¥ÂÂÃ¥ÂÂ¾Ã¦ÂÂ¶ content Ã¥Â¸Â¸Ã¦ÂÂ¯Ã¦ÂÂ°Ã§Â»ÂÃ£ÂÂÃ©Â»ÂÃ¨Â®Â¤Ã¥ÂÂÃ¦Â Â·Ã©ÂÂÃ¤Â¼Â Ã§Â»ÂÃ¨Â§ÂÃ¨Â§ÂÃ¦Â¨Â¡Ã¥ÂÂÃ¯Â¼Â
    // Ã¥Â¦ÂÃ¤Â¸ÂÃ¦Â¸Â¸Ã¤Â¸ÂÃ¦ÂÂ¯Ã¦ÂÂÃ¥ÂÂ¾Ã§ÂÂÃ¯Â¼ÂÃ¥ÂÂ¯Ã¨Â®Â¾Ã§Â½Â® MULTIMODAL_MODE=text Ã©ÂÂÃ¥ÂÂÃ¦ÂÂÃ¦ÂÂ¬Ã¥ÂÂ Ã¤Â½ÂÃ£ÂÂ
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

    console.log("Ã¦ÂÂ¬Ã¦Â¬Â¡Ã¦Â³Â¨Ã¥ÂÂ¥Ã§ÂÂÃ§ÂÂ¹Ã¦Â®ÂÃ¤ÂºÂÃ¤Â»Â¶Ã¦ÂÂ°Ã©ÂÂ:", oldEvents.length);

    for (const event of oldEvents) {
      const eventTime = extractTimestampWithMemory(event, tsDB);
      if (!eventTime) { llmMessages.push(event); continue; }
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

    // ---- Ã¨ÂÂªÃ¥ÂÂ¨Ã¤Â¿Â®Ã¥Â¤ÂÃ¤Â¸ÂÃ¥Â®ÂÃ¦ÂÂ´Ã§ÂÂ tool Ã¨Â°ÂÃ§ÂÂ¨Ã¯Â¼ÂÃ¥ÂÂÃ¥ÂÂÃ¦Â¸ÂÃ§ÂÂÃ¯Â¼Â ----
    // Ã§Â¬Â¬Ã¤Â¸ÂÃ©ÂÂÃ¯Â¼ÂÃ¦Â ÂÃ¨Â®Â°Ã©ÂÂÃ¨Â¦ÂÃ§Â§Â»Ã©ÂÂ¤Ã§ÂÂÃ§Â´Â¢Ã¥Â¼Â
    const removeSet = new Set();

    // Ã¦Â£ÂÃ¦ÂÂ¥ assistant tool_calls Ã¦ÂÂ¯Ã¥ÂÂ¦Ã¥Â®ÂÃ¦ÂÂ´
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
        // Ã¦Â ÂÃ¨Â®Â°Ã¨Â¿ÂÃ¦ÂÂ¡ assistant Ã¤Â¸ÂºÃ§Â§Â»Ã©ÂÂ¤Ã¯Â¼ÂÃ¥ÂÂÃ¦ÂÂ¶Ã¦Â ÂÃ¨Â®Â°Ã¥Â®ÂÃ¥ÂÂÃ©ÂÂ¢Ã§ÂÂÃ¦ÂÂÃ¦ÂÂ tool Ã¦Â¶ÂÃ¦ÂÂ¯Ã¤Â¹ÂÃ§Â§Â»Ã©ÂÂ¤
        removeSet.add(i);
        for (let j = i + 1; j < llmMessages.length; j++) {
          if (llmMessages[j].role === "tool") {
            removeSet.add(j);
          } else {
            break;
          }
        }
        console.log(`Ã¢ÂÂ Ã¯Â¸Â Ã¨ÂÂªÃ¥ÂÂ¨Ã¤Â¿Â®Ã¥Â¤ÂÃ¯Â¼ÂÃ§Â§Â»Ã©ÂÂ¤Ã¤Â¸ÂÃ¥Â®ÂÃ¦ÂÂ´Ã§ÂÂ tool_calls (Ã§Â´Â¢Ã¥Â¼Â ${i})`);
      }
    }

    // Ã¦Â£ÂÃ¦ÂÂ¥Ã¥Â­Â¤Ã§Â«Â tool Ã¦Â¶ÂÃ¦ÂÂ¯Ã¯Â¼ÂÃ¥ÂÂÃ©ÂÂ¢Ã¦Â²Â¡Ã¦ÂÂÃ¥Â¯Â¹Ã¥ÂºÂÃ§ÂÂ tool_callsÃ¯Â¼Â
    for (let i = 0; i < llmMessages.length; i++) {
      if (llmMessages[i].role !== "tool") continue;
      // Ã¥ÂÂÃ¥ÂÂÃ¦ÂÂ¥Ã¦ÂÂ¾Ã¦ÂÂÃ¨Â¿ÂÃ§ÂÂ assistant
      let hasMatchingToolCalls = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = llmMessages[j];
        if (prev.role === "assistant" && prev.tool_calls) {
          // Ã¦Â£ÂÃ¦ÂÂ¥Ã¨Â¿ÂÃ¤Â¸Âª tool_call_id Ã¦ÂÂ¯Ã¥ÂÂ¦Ã¥ÂÂ¨ assistant Ã§ÂÂ tool_calls Ã¤Â¸Â­
          const ids = prev.tool_calls.map(tc => tc.id);
          if (ids.includes(llmMessages[i].tool_call_id)) {
            hasMatchingToolCalls = true;
          }
          break;
        } else if (prev.role === "tool") {
          continue; // Ã§Â»Â§Ã§Â»Â­Ã¥ÂÂÃ¥ÂÂÃ¦ÂÂ¾
        } else {
          break; // Ã©ÂÂÃ¥ÂÂ° user Ã¦ÂÂÃ¥ÂÂ¶Ã¤Â»ÂÃ¦Â¶ÂÃ¦ÂÂ¯Ã¯Â¼ÂÃ¥ÂÂÃ¦Â­Â¢
        }
      }
      if (!hasMatchingToolCalls) {
        removeSet.add(i);
        console.log(`Ã¢ÂÂ Ã¯Â¸Â Ã¨ÂÂªÃ¥ÂÂ¨Ã¤Â¿Â®Ã¥Â¤ÂÃ¯Â¼ÂÃ§Â§Â»Ã©ÂÂ¤Ã¥Â­Â¤Ã§Â«ÂÃ§ÂÂ tool Ã¦Â¶ÂÃ¦ÂÂ¯ (Ã§Â´Â¢Ã¥Â¼Â ${i})`);
      }
    }

    // Ã¦ÂÂÃ§Â´Â¢Ã¥Â¼ÂÃ¤Â»ÂÃ¥Â¤Â§Ã¥ÂÂ°Ã¥Â°ÂÃ¥ÂÂ Ã©ÂÂ¤Ã¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ§Â´Â¢Ã¥Â¼ÂÃ©ÂÂÃ¤Â¹Â±
    const sortedRemove = Array.from(removeSet).sort((a, b) => b - a);
    for (const idx of sortedRemove) {
      llmMessages.splice(idx, 1);
    }

    if (!TARGET_API_URL || !process.env.TARGET_API_KEY) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY Ã¦ÂÂªÃ©ÂÂÃ§Â½Â®" });
    }

    const requestedStream = body?.stream === true;

    // Ã¨Â¯Â·Ã¦Â±ÂÃ¦Â¨Â¡Ã¥ÂÂ
    const response = await fetch(TARGET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TARGET_API_KEY}`
      },
      body: JSON.stringify({ ...body, messages: llmMessages })
    });

    const upstreamContentType = response.headers.get("content-type") || "";
    const shouldStreamResponse = requestedStream || upstreamContentType.includes("text/event-stream");

    // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-11Ã¯Â¼ÂKelivo Ã¥ÂÂ³Ã©ÂÂ­ stream Ã¦ÂÂ¶Ã©ÂÂÃ¨Â¦ÂÃ¦ÂÂ¶Ã¥ÂÂ°Ã¦ÂÂ®Ã©ÂÂ JSONÃ¯Â¼ÂÃ¥ÂÂªÃ¥ÂÂ¨Ã¨Â¯Â·Ã¦Â±ÂÃ¦ÂÂÃ¤Â¸ÂÃ¦Â¸Â¸Ã§Â¡Â®Ã¨Â®Â¤Ã¤Â¸Âº SSE Ã¦ÂÂ¶Ã¦ÂÂÃ¦ÂÂÃ¦ÂµÂÃ¥Â¼ÂÃ§ÂÂ´Ã©ÂÂÃ£ÂÂ
    if (!shouldStreamResponse) {
      const responseText = await response.text();
      return reply
        .code(response.status)
        .header("Content-Type", upstreamContentType || "application/json")
        .send(responseText);
    }

    if (!response.body) {
      return reply.code(response.status).send({ error: "Ã¤Â¸ÂÃ¦Â¸Â¸ API Ã¦Â²Â¡Ã¦ÂÂÃ¨Â¿ÂÃ¥ÂÂÃ¥ÂÂ¯Ã¨Â¯Â»Ã¥ÂÂÃ§ÂÂÃ¥ÂÂÃ¥ÂºÂÃ¤Â½Â" });
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
// Ã¥ÂÂÃ©ÂÂ¨Ã¦ÂÂ¥Ã¥ÂÂ£Ã¯Â¼ÂÃ¨Â®Â°Ã¥Â½ÂÃ¥ÂÂ¤Ã©ÂÂÃ¤ÂºÂÃ¤Â»Â¶
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
// Ã¨Â¯Â»Ã¥ÂÂ .env Ã¥ÂÂ¼
// ========================
function readEnvValue(key) {
  // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-30Ã¯Â¼ÂRailway Variables Ã¦ÂÂ¯Ã¤ÂºÂÃ§Â«Â¯Ã©ÂÂ¨Ã§Â½Â²Ã§ÂÂÃ¦ÂÂÃ¥Â¨ÂÃ©ÂÂÃ§Â½Â®Ã¦ÂºÂÃ¯Â¼Â
  // Ã¥Â®Â¹Ã¥ÂÂ¨Ã¥ÂÂ .env Ã¥ÂÂªÃ¤Â½ÂÃ¥ÂÂÃ¥ÂºÂÃ¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ§Â®Â¡Ã§ÂÂÃ©Â¡ÂµÃ¤Â¿ÂÃ¥Â­ÂÃ¥ÂÂºÃ§ÂÂÃ¤Â¸Â´Ã¦ÂÂ¶Ã¦ÂÂÃ¤Â»Â¶Ã¨Â¦ÂÃ§ÂÂÃ¥Â¹Â³Ã¥ÂÂ°Ã¥ÂÂÃ©ÂÂÃ£ÂÂ
  if (IS_RAILWAY_RUNTIME && process.env[key]) return process.env[key];
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
    // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼ÂÃ§Â®Â¡Ã§ÂÂÃ©Â¡ÂµÃ¥ÂÂªÃ¨Â¯Â»Ã¥Â±ÂÃ§Â¤Âº wake-up Ã§ÂÂÃ¦ÂÂÃ§ÂÂÃ¦ÂÂ¬Ã¥ÂÂ°Ã¦ÂÂ¥Ã¨Â®Â°Ã¯Â¼Â
    // Ã¥ÂÂªÃ¨Â¯Â»Ã¥ÂÂ DIARY_DIR Ã¤Â¸ÂÃ§ÂÂ .md Ã¦ÂÂÃ¤Â»Â¶Ã¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ¦ÂÂÃ¤Â»Â»Ã¦ÂÂÃ¨Â·Â¯Ã¥Â¾ÂÃ¥ÂÂÃ¥Â®Â¹Ã¦ÂÂ´Ã©ÂÂ²Ã¥ÂÂ° admin Ã©Â¡ÂµÃ©ÂÂ¢Ã£ÂÂ
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
    return [{ name: "Ã¨Â¯Â»Ã¥ÂÂÃ¦ÂÂ¥Ã¨Â®Â°Ã¥Â¤Â±Ã¨Â´Â¥", updated_at: new Date().toISOString(), content: err.message || String(err) }];
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
// Ã§Â®Â¡Ã§ÂÂÃ©Â¡ÂµÃ©ÂÂ¢ GET /admin
// ========================
app.get("/admin", { preHandler: basicAuth }, async (req, reply) => {
  const serverUptime = Math.floor(process.uptime());
  const wakeUpStatus = wakeUpLastHeartbeat
    ? `Ã¥ÂÂ¨Ã§ÂºÂ¿Ã¯Â¼ÂÃ¤Â¸ÂÃ¦Â¬Â¡Ã¥Â¿ÂÃ¨Â·Â³: ${formatDateTimeInTimeZone(new Date(wakeUpLastHeartbeat), TIME_ZONE)}Ã¯Â¼Â`
    : "Ã§Â¦Â»Ã§ÂºÂ¿Ã¦ÂÂÃ¦ÂÂªÃ¥ÂÂ¯Ã¥ÂÂ¨";

  const currentUrl = readEnvValue("TARGET_API_URL");
  const currentModel = readEnvValue("MODEL_NAME");
  const currentIcon = readEnvValue("CUSTOM_ICON_URL");
  const gatewayKeyStatus = readEnvValue("GATEWAY_API_KEY") ? "Ã¥Â·Â²Ã©ÂÂÃ§Â½Â®" : "Ã¦ÂÂªÃ©ÂÂÃ§Â½Â®";
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
  const diaryHtml = diaryEntries.length
    ? diaryEntries.map(entry => `
      <details class="diary-entry">
        <summary>
          <span>${escapeHtml(entry.name)}</span>
          <em>${escapeHtml(formatDateTimeInTimeZone(new Date(entry.updated_at), TIME_ZONE))}</em>
        </summary>
        <pre>${escapeHtml(entry.content)}</pre>
      </details>
    `).join("")
    : `<div class="diary-empty">Ã¨Â¿ÂÃ¦Â²Â¡Ã¦ÂÂÃ¦ÂÂ¥Ã¨Â®Â°Ã£ÂÂÃ¦Â¨Â¡Ã¥ÂÂÃ¥ÂÂ¨ wake-up Ã¥ÂÂÃ¥Â¤ÂÃ©ÂÂÃ¨Â¾ÂÃ¥ÂÂº [DIARY]...[/DIARY] Ã¥ÂÂÃ¤Â¼ÂÃ¤Â¿ÂÃ¥Â­ÂÃ¥ÂÂ°Ã¨Â¿ÂÃ©ÂÂÃ£ÂÂ</div>`;

  const authToken = Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString("base64");
  const runtimeConfigNotice = IS_RAILWAY_RUNTIME
    ? `<div class="hint">Railway Ã¦Â£ÂÃ¦ÂµÂÃ¥ÂÂ°Ã¯Â¼ÂÃ¦Â­Â¤Ã©Â¡ÂµÃ©ÂÂ¢Ã¤Â¿ÂÃ¥Â­ÂÃ§ÂÂÃ¦ÂÂ¯Ã¥Â½ÂÃ¥ÂÂÃ¥Â®Â¹Ã¥ÂÂ¨Ã§ÂÂ .envÃ£ÂÂRailway Variables Ã¤Â¼ÂÃ¤Â¼ÂÃ¥ÂÂÃ¦ÂÂÃ¤Â¾ÂÃ¨Â¿ÂÃ¨Â¡ÂÃ¦ÂÂ¶Ã©ÂÂÃ§Â½Â®Ã¯Â¼ÂÃ¤Â¸ÂÃ¦ÂÂªÃ¦ÂÂÃ¨Â½Â½ Volume Ã§ÂÂÃ¦ÂÂÃ¤Â»Â¶Ã¤Â¼ÂÃ¥ÂÂ¨Ã©ÂÂÃ¦ÂÂ°Ã©ÂÂ¨Ã§Â½Â²Ã¥ÂÂÃ¤Â¸Â¢Ã¥Â¤Â±Ã¯Â¼ÂÃ¨Â¯Â·Ã¥ÂÂ¨ Railway Variables Ã¤Â¿Â®Ã¦ÂÂ¹Ã¥ÂÂ¤Ã©ÂÂÃ¦ÂÂ°Ã¥ÂÂ¼Ã¥Â¹Â¶Ã©ÂÂÃ¦ÂÂ°Ã©ÂÂ¨Ã§Â½Â²Ã£ÂÂ</div>`
    : "";

  const presets = loadPresets();
  const presetsJson = safeJsonForInlineScript(presets);
  const authHeaderJson = safeJsonForInlineScript(`Basic ${authToken}`);

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HEARTBEAT ÃÂ· Runtime</title>
  <!-- Ã¥Â¼ÂÃ¥ÂÂ¥Ã¦ÂÂÃ¦ÂºÂÃ¥Â®ÂÃ¤Â½Â -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: "Noto Serif SC", Georgia, "Times New Roman", serif;
      background: linear-gradient(135deg, #f8f0f3 0%, #f5e6eb 100%);
      background-image: 
        radial-gradient(circle at 20% 80%, rgba(230, 190, 200, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(210, 170, 180, 0.1) 0%, transparent 50%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 30px 20px;
    }

    .container {
      max-width: 480px;
      width: 100%;
      background: rgba(255, 255, 255, 0.75);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 40px 32px;
      box-shadow: 
        0 2px 10px rgba(180, 120, 130, 0.05),
        0 15px 40px rgba(180, 120, 130, 0.15),
        0 0 0 1px rgba(255, 255, 255, 0.8) inset;
      transition: all 0.4s ease;
    }

    .container:hover {
      box-shadow: 
        0 2px 10px rgba(180, 120, 130, 0.08),
        0 20px 50px rgba(180, 120, 130, 0.2),
        0 0 0 1px rgba(255, 255, 255, 0.9) inset;
    }

    h2 {
      text-align: center;
      font-size: 32px;
      font-weight: 700;
      color: #8a4a58;
      margin-bottom: 4px;
      letter-spacing: 6px;
      font-family: "Times New Roman", "Georgia", "Noto Serif SC", serif;
      font-style: normal;
      text-transform: uppercase;
    }

    .subtitle {
      text-align: center;
      font-size: 12px;
      color: #a87a85;
      margin-bottom: 32px;
      letter-spacing: 4px;
      text-transform: uppercase;
      font-style: italic;
      opacity: 0.85;
    }

    .status {
      background: rgba(255, 250, 252, 0.6);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 14px;
      padding: 16px 20px;
      margin-bottom: 24px;
      border: 1px solid rgba(230, 200, 208, 0.4);
    }

    .status p {
      margin: 6px 0;
      font-size: 13px;
      color: #6d5057;
      font-weight: 400;
      line-height: 1.5;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .status strong {
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    label {
      display: block;
      margin-top: 16px;
      font-weight: 500;
      font-size: 11px;
      color: #8b6b72;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    input {
      width: 100%;
      padding: 10px 14px;
      margin-top: 6px;
      border: 1px solid rgba(200, 160, 170, 0.3);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.7);
      font-family: "Noto Serif SC", serif;
      font-size: 13px;
      color: #5a4046;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    input:focus {
      outline: none;
      border-color: #c89aa6;
      box-shadow: 0 0 0 3px rgba(200, 154, 166, 0.1);
      background: rgba(255, 255, 255, 0.95);
      transform: translateY(-1px);
    }

    input::placeholder {
      color: #b8a0a6;
      font-style: italic;
      font-size: 12px;
    }

    select {
      width: 100%;
      padding: 10px 14px;
      margin-top: 6px;
      border: 1px solid rgba(200, 160, 170, 0.3);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.7);
      font-family: "Noto Serif SC", serif;
      font-size: 13px;
      color: #5a4046;
    }

    button {
      width: 100%;
      margin-top: 16px;
      padding: 12px;
      border: none;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      letter-spacing: 1.5px;
      font-family: "Noto Serif SC", serif;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      text-transform: uppercase;
    }

    button.save {
      background: linear-gradient(135deg, #d8a0ad 0%, #c8909d 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(180, 120, 130, 0.2);
    }

    button.save:hover {
      background: linear-gradient(135deg, #c8909d 0%, #b8808d 100%);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(180, 120, 130, 0.3);
    }

    button.save:active {
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(180, 120, 130, 0.2);
    }

    button.restart {
      background: linear-gradient(135deg, #e8909d 0%, #d8808d 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(200, 100, 120, 0.25);
      margin-top: 28px;
    }

    button.restart:hover {
      background: linear-gradient(135deg, #d8808d 0%, #c8707d 100%);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(200, 100, 120, 0.35);
    }

    button.restart:active {
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(200, 100, 120, 0.25);
    }

    .note {
      margin-top: 16px;
      font-size: 10px;
      color: #a88a92;
      text-align: center;
      font-style: italic;
      letter-spacing: 1px;
      opacity: 0.7;
    }

    /* Ã©Â¢ÂÃ¨Â®Â¾Ã¥ÂÂºÃ¥ÂÂ */
    .presets-box {
      background: rgba(255, 250, 252, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
      border: 1px solid rgba(230, 200, 208, 0.3);
    }

    .presets-box h3 {
      margin: 0 0 14px 0;
      font-size: 12px;
      color: #8a4a58;
      font-weight: 500;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .preset-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }

    .preset-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .preset-btn {
      flex: 1;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      border: 1px solid rgba(220, 180, 190, 0.3);
      border-radius: 10px;
      text-align: left;
      font-size: 13px;
      color: #6d5057;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      font-family: "Noto Serif SC", serif;
    }

    .preset-btn:hover {
      background: rgba(255, 245, 248, 0.9);
      border-color: #c89aa6;
      box-shadow: 0 4px 12px rgba(180, 120, 130, 0.15);
      transform: translateY(-1px);
    }

    .preset-btn span {
      color: #9a7a82;
      font-size: 11px;
      margin-left: 8px;
      font-style: italic;
    }

    .preset-del {
      padding: 8px 12px;
      background: rgba(255, 240, 243, 0.6);
      border: 1px solid rgba(240, 200, 210, 0.4);
      border-radius: 8px;
      font-size: 11px;
      color: #a85a68;
      cursor: pointer;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .preset-del:hover {
      background: rgba(255, 230, 235, 0.8);
      border-color: #e8a0b0;
      color: #9a4a58;
    }

    .add-preset {
      border-top: 1px solid rgba(220, 180, 190, 0.3);
      padding-top: 16px;
    }

    .add-preset strong {
      font-size: 11px;
      color: #8a4a58;
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .add-preset input {
      margin-top: 6px;
      background: rgba(255, 255, 255, 0.8);
    }

    .add-preset button {
      background: linear-gradient(135deg, #c89aa6 0%, #b88a96 100%);
      color: white;
      box-shadow: 0 4px 10px rgba(160, 100, 110, 0.2);
      font-size: 12px;
      padding: 10px;
    }

    .add-preset button:hover {
      background: linear-gradient(135deg, #b88a96 0%, #a87a86 100%);
    }

    .config-box {
      background: rgba(255, 250, 252, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 20px;
      border: 1px solid rgba(230, 200, 208, 0.3);
    }

    .diary-box {
      background: rgba(255, 250, 252, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
      border: 1px solid rgba(230, 200, 208, 0.3);
    }

    .diary-box h3 {
      margin: 0 0 12px 0;
      font-size: 12px;
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .diary-entry {
      border: 1px solid rgba(220, 180, 190, 0.3);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.58);
      margin-top: 10px;
      overflow: hidden;
    }

    .diary-entry summary {
      cursor: pointer;
      padding: 12px 14px;
      color: #6d5057;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }

    .diary-entry summary span {
      font-weight: 600;
    }

    .diary-entry summary em {
      color: #a88a92;
      font-style: normal;
      font-size: 10px;
      white-space: nowrap;
    }

    .diary-entry pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      padding: 0 14px 14px;
      color: #5a4046;
      font-family: "Noto Serif SC", Georgia, "Times New Roman", serif;
      font-size: 12px;
      line-height: 1.8;
      max-height: 360px;
      overflow: auto;
    }

    .diary-empty {
      color: #9a7a82;
      font-size: 12px;
      line-height: 1.7;
      background: rgba(255, 255, 255, 0.55);
      border-radius: 12px;
      padding: 12px 14px;
    }

    .section-title {
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid rgba(220, 180, 190, 0.3);
      font-size: 12px;
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .hint {
      margin-top: 8px;
      font-size: 11px;
      color: #9a7a82;
      line-height: 1.6;
    }

    /* Ã¥ÂÂ Ã¨Â½Â½Ã¥ÂÂ¨Ã§ÂÂ» */
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .container {
      animation: fadeIn 0.6s ease-out;
    }

    .status, .presets-box, .config-box {
      animation: fadeIn 0.8s ease-out;
    }

    .restart {
      animation: fadeIn 1s ease-out;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>HEARTBEAT</h2>
    <div class="subtitle">Runtime ÃÂ· AI Residency</div>

    <div class="status">
      <p>Gateway <strong>Ã¨Â¿ÂÃ¨Â¡ÂÃ¤Â¸Â­ (${serverUptime}Ã§Â§Â)</strong></p>
      <p>Auto Wakeup <strong>${wakeUpStatus}</strong></p>
    </div>
    ${runtimeConfigNotice}

    <div class="diary-box">
      <h3>Wake Diary</h3>
      ${diaryHtml}
    </div>

    <!-- Ã©Â¢ÂÃ¨Â®Â¾Ã¦ÂÂ¹Ã¦Â¡Â -->
    <div class="presets-box">
      <h3>Ã©Â¢ÂÃ¨Â®Â¾Ã¦ÂÂ¹Ã¦Â¡Â</h3>
      <div class="preset-list" id="presetList"></div>
      <div class="add-preset">
        <strong>Ã¤Â¿ÂÃ¥Â­ÂÃ¥Â½ÂÃ¥ÂÂÃ©ÂÂÃ§Â½Â®Ã¤Â¸ÂºÃ¦ÂÂ°Ã©Â¢ÂÃ¨Â®Â¾</strong>
        <input id="presetName" placeholder="Ã©Â¢ÂÃ¨Â®Â¾Ã¥ÂÂÃ§Â§Â°Ã¯Â¼ÂÃ¤Â¾ÂÃ¥Â¦ÂÃ¯Â¼ÂDeepSeek / Claude">
        <button onclick="savePreset()">Ã¤Â¿ÂÃ¥Â­ÂÃ¤Â¸ÂºÃ©Â¢ÂÃ¨Â®Â¾</button>
      </div>
    </div>

    <!-- Ã©ÂÂÃ§Â½Â®Ã¨Â¡Â¨Ã¥ÂÂ -->
    <div class="config-box">
      <form id="configForm" onsubmit="saveConfig(event)">
        <label>API URL</label>
        <input name="target_url" id="f_url" value="${escapeHtml(currentUrl)}">
        <label>API Key</label>
        <input name="target_key" id="f_key" placeholder="Ã§ÂÂÃ§Â©ÂºÃ¤Â¸ÂÃ¤Â¿Â®Ã¦ÂÂ¹">
        <label>Gateway API Key</label>
        <input name="gateway_api_key" id="f_gateway_key" placeholder="Ã¥ÂÂ¬Ã§Â½Â /v1 Ã©ÂÂ´Ã¦ÂÂ keyÃ¯Â¼ÂÃ§ÂÂÃ§Â©ÂºÃ¤Â¸ÂÃ¤Â¿Â®Ã¦ÂÂ¹">
        <div class="hint">Ã¥Â½ÂÃ¥ÂÂÃ§ÂÂ¶Ã¦ÂÂÃ¯Â¼Â${escapeHtml(gatewayKeyStatus)}Ã£ÂÂÃ¥ÂÂ¬Ã¥Â¼ÂÃ©ÂÂ¨Ã§Â½Â²Ã¥Â¹Â¶Ã¥Â¼ÂÃ¥ÂÂ¯ ALLOW_PUBLIC_API=true Ã¦ÂÂ¶Ã¯Â¼ÂKelivo Ã§ÂÂ API Key Ã¨Â¯Â·Ã¥Â¡Â«Ã¥ÂÂÃ¨Â¿ÂÃ¤Â¸Âª Gateway API KeyÃ¯Â¼ÂÃ¤Â¸ÂÃ¨Â¦ÂÃ¥Â¡Â«Ã¥ÂÂÃ¤Â¸ÂÃ¦Â¸Â¸ API KeyÃ£ÂÂ</div>
        <label>Model Name</label>
        <input name="model_name" id="f_model" value="${escapeHtml(currentModel)}">
        <label>Bark Key</label>
        <input name="bark_key" id="f_bark" placeholder="Ã§ÂÂÃ§Â©ÂºÃ¤Â¸ÂÃ¤Â¿Â®Ã¦ÂÂ¹">
        <label>Bark Icon URL</label>
        <input name="custom_icon" id="f_icon" value="${escapeHtml(currentIcon)}" placeholder="Ã¥ÂÂ¯Ã©ÂÂ">

        <div class="section-title">Wake Settings</div>
        <div class="grid-2">
          <div>
            <label>Ã§ÂÂ½Ã¥Â¤Â©Ã¥Â¤ÂÃ¤Â¹ÂÃ¦ÂÂªÃ¥ÂÂÃ¥Â¤ÂÃ¥ÂÂÃ¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¥ÂÂÃ©ÂÂÃ¯Â¼Â</label>
            <input type="number" min="1" name="day_wake_after" id="f_day_wake_after" value="${escapeHtml(wakeConfig.dayWakeAfter)}">
          </div>
          <div>
            <label>Ã¥Â¤ÂÃ©ÂÂ´Ã¥Â¤ÂÃ¤Â¹ÂÃ¦ÂÂªÃ¥ÂÂÃ¥Â¤ÂÃ¥ÂÂÃ¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¥ÂÂÃ©ÂÂÃ¯Â¼Â</label>
            <input type="number" min="1" name="night_wake_after" id="f_night_wake_after" value="${escapeHtml(wakeConfig.nightWakeAfter)}">
          </div>
          <div>
            <label>Ã§ÂÂ½Ã¥Â¤Â©Ã¦Â£ÂÃ¦ÂÂ¥Ã©ÂÂ´Ã©ÂÂÃ¯Â¼ÂÃ¥ÂÂÃ©ÂÂÃ¯Â¼Â</label>
            <input type="number" min="1" name="day_check_interval" id="f_day_check_interval" value="${escapeHtml(wakeConfig.dayCheckInterval)}">
          </div>
          <div>
            <label>Ã¥Â¤ÂÃ©ÂÂ´Ã¦Â£ÂÃ¦ÂÂ¥Ã©ÂÂ´Ã©ÂÂÃ¯Â¼ÂÃ¥ÂÂÃ©ÂÂÃ¯Â¼Â</label>
            <input type="number" min="1" name="night_check_interval" id="f_night_check_interval" value="${escapeHtml(wakeConfig.nightCheckInterval)}">
          </div>
          <div>
            <label>Ã§ÂÂ½Ã¥Â¤Â©Ã¥Â¼ÂÃ¥Â§ÂÃ¥Â°ÂÃ¦ÂÂ¶</label>
            <input type="number" min="0" max="23" name="wake_day_start_hour" id="f_wake_day_start_hour" value="${escapeHtml(wakeConfig.dayStartHour)}">
          </div>
          <div>
            <label>Ã§ÂÂ½Ã¥Â¤Â©Ã§Â»ÂÃ¦ÂÂÃ¥Â°ÂÃ¦ÂÂ¶</label>
            <input type="number" min="1" max="24" name="wake_day_end_hour" id="f_wake_day_end_hour" value="${escapeHtml(wakeConfig.dayEndHour)}">
          </div>
        </div>

        <div class="section-title">Weather</div>
        <label>Ã¥Â¤Â©Ã¦Â°ÂÃ¦Â³Â¨Ã¥ÂÂ¥</label>
        <select name="weather_enabled" id="f_weather_enabled">
          <option value="false" ${weatherConfig.enabled === "true" ? "" : "selected"}>Ã¥ÂÂ³Ã©ÂÂ­</option>
          <option value="true" ${weatherConfig.enabled === "true" ? "selected" : ""}>Ã¥Â¼ÂÃ¥ÂÂ¯</option>
        </select>
        <label>Ã¤Â½ÂÃ§Â½Â®Ã¥ÂÂÃ§Â§Â°</label>
        <input name="weather_location_name" id="f_weather_location_name" value="${escapeHtml(weatherConfig.locationName)}" placeholder="Ã¤Â¾ÂÃ¥Â¦ÂÃ¯Â¼ÂBeijing">
        <div class="grid-2">
          <div>
            <label>Ã§ÂºÂ¬Ã¥ÂºÂ¦ Latitude</label>
            <input name="weather_lat" id="f_weather_lat" value="${escapeHtml(weatherConfig.lat)}" placeholder="Ã¤Â¾ÂÃ¥Â¦ÂÃ¯Â¼Â39.9042">
          </div>
          <div>
            <label>Ã§Â»ÂÃ¥ÂºÂ¦ Longitude</label>
            <input name="weather_lon" id="f_weather_lon" value="${escapeHtml(weatherConfig.lon)}" placeholder="Ã¤Â¾ÂÃ¥Â¦ÂÃ¯Â¼Â116.4074">
          </div>
        </div>
        <label>Ã¥ÂÂÃ¤Â½Â</label>
        <select name="weather_units" id="f_weather_units">
          <option value="metric" ${weatherConfig.units === "fahrenheit" ? "" : "selected"}>Ã¦ÂÂÃ¦Â°ÂÃ¥ÂºÂ¦ / km/h</option>
          <option value="fahrenheit" ${weatherConfig.units === "fahrenheit" ? "selected" : ""}>Ã¥ÂÂÃ¦Â°ÂÃ¥ÂºÂ¦ / mph</option>
        </select>
        <div class="hint">Ã¥Â¤Â©Ã¦Â°ÂÃ¤Â½Â¿Ã§ÂÂ¨ Open-Meteo Ã¥ÂÂÃ¨Â´Â¹Ã¦ÂÂ¥Ã¥ÂÂ£Ã¯Â¼ÂÃ¤Â¸ÂÃ©ÂÂÃ¨Â¦Â API KeyÃ¯Â¼ÂÃ¥ÂÂªÃ¦ÂÂÃ¥Â¼ÂÃ¥ÂÂ¯Ã¥ÂÂÃ¦ÂÂÃ¤Â¼ÂÃ¦ÂÂÃ¤Â½Â Ã¥Â¡Â«Ã¥ÂÂÃ§ÂÂÃ§Â»ÂÃ§ÂºÂ¬Ã¥ÂºÂ¦Ã¨Â¯Â»Ã¥ÂÂÃ¥Â¤Â©Ã¦Â°ÂÃ£ÂÂ</div>
        <button type="submit" class="save">Ã¤Â¿ÂÃ¥Â­ÂÃ©ÂÂÃ§Â½Â®</button>
      </form>
    </div>

    <button onclick="restartServices()" class="restart">Ã¤Â¸ÂÃ©ÂÂ®Ã©ÂÂÃ¥ÂÂ¯Ã¦ÂÂÃ¦ÂÂÃ¦ÂÂÃ¥ÂÂ¡</button>
    <div class="note">Ã¤Â¿Â®Ã¦ÂÂ¹Ã©ÂÂÃ§Â½Â®Ã¥ÂÂÃ¥ÂÂÃ¤Â¿ÂÃ¥Â­ÂÃ¯Â¼ÂÃ¥ÂÂÃ§ÂÂ¹Ã©ÂÂÃ¥ÂÂ¯Ã¦ÂÂÃ©ÂÂ®Ã§ÂÂÃ¦ÂÂ</div>
  </div>

  <script>
    // ====== Ã¤Â»Â¥Ã¤Â¸ÂÃ¨ÂÂÃ¦ÂÂ¬Ã¤Â¿ÂÃ¦ÂÂÃ¤Â¸ÂÃ¥ÂÂ ======
    const AUTH_HEADER = ${authHeaderJson};
    let presets = ${presetsJson};

    function escapeHtmlText(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderPresets() {
      const list = document.getElementById("presetList");
      if (!presets.length) {
        list.innerHTML = '<div style="color:#aaa;font-size:12px;font-style:italic;">Ã¨Â¿ÂÃ¦Â²Â¡Ã¦ÂÂÃ©Â¢ÂÃ¨Â®Â¾Ã¯Â¼ÂÃ¤Â¿ÂÃ¥Â­ÂÃ¥Â½ÂÃ¥ÂÂÃ©ÂÂÃ§Â½Â®Ã¥ÂÂ³Ã¥ÂÂ¯Ã¥ÂÂÃ¥Â»ÂºÃ£ÂÂ</div>';
        return;
      }
      list.innerHTML = presets.map((p, idx) => {
        return '<div class="preset-item">' +
          '<button class="preset-btn" onclick="applyPreset(' + idx + ')">' + escapeHtmlText(p.name) + '<span>' + escapeHtmlText(p.model_name) + '</span></button>' +
          '<button class="preset-del" onclick="deletePreset(' + idx + ')">Ã¥ÂÂ Ã©ÂÂ¤</button>' +
        '</div>';
      }).join("");
    }

    function applyPreset(idx) {
      const p = presets[idx];
      document.getElementById("f_url").value = p.target_url || "";
      document.getElementById("f_model").value = p.model_name || "";
      if (p.target_key) document.getElementById("f_key").value = p.target_key;
      document.querySelector(".config-box").scrollIntoView({ behavior: "smooth" });
    }

    async function saveConfig(event) {
      event.preventDefault();
      const payload = {
        target_url: document.getElementById("f_url").value.trim(),
        target_key: document.getElementById("f_key").value.trim(),
        gateway_api_key: document.getElementById("f_gateway_key").value.trim(),
        model_name: document.getElementById("f_model").value.trim(),
        bark_key: document.getElementById("f_bark").value.trim(),
        custom_icon: document.getElementById("f_icon").value.trim(),
        day_wake_after: document.getElementById("f_day_wake_after").value.trim(),
        night_wake_after: document.getElementById("f_night_wake_after").value.trim(),
        day_check_interval: document.getElementById("f_day_check_interval").value.trim(),
        night_check_interval: document.getElementById("f_night_check_interval").value.trim(),
        wake_day_start_hour: document.getElementById("f_wake_day_start_hour").value.trim(),
        wake_day_end_hour: document.getElementById("f_wake_day_end_hour").value.trim(),
        weather_enabled: document.getElementById("f_weather_enabled").value,
        weather_location_name: document.getElementById("f_weather_location_name").value.trim(),
        weather_lat: document.getElementById("f_weather_lat").value.trim(),
        weather_lon: document.getElementById("f_weather_lon").value.trim(),
        weather_units: document.getElementById("f_weather_units").value
      };

      if (!payload.target_url || !payload.model_name) {
        alert("Ã¨Â¯Â·Ã¥Â¡Â«Ã¥ÂÂ API Ã¥ÂÂ°Ã¥ÂÂÃ¥ÂÂÃ¦Â¨Â¡Ã¥ÂÂÃ¥ÂÂÃ§Â§Â°");
        return;
      }

      try {
        const resp = await fetch("/admin/save", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
          body: JSON.stringify(payload)
        });
        const result = await resp.json();
        if (result.success) {
          document.getElementById("f_key").value = "";
          document.getElementById("f_gateway_key").value = "";
          document.getElementById("f_bark").value = "";
          alert("Ã©ÂÂÃ§Â½Â®Ã¥Â·Â²Ã¤Â¿ÂÃ¥Â­ÂÃ¯Â¼ÂÃ§ÂÂ°Ã¥ÂÂ¨Ã¥ÂÂ¯Ã¤Â»Â¥Ã§ÂÂ¹Ã¥ÂÂ»Ã©ÂÂÃ¥ÂÂ¯Ã¦ÂÂÃ©ÂÂ®Ã¨Â®Â©Ã¦ÂÂ°Ã©ÂÂÃ§Â½Â®Ã§ÂÂÃ¦ÂÂÃ£ÂÂ");
        } else {
          alert("Ã¤Â¿ÂÃ¥Â­ÂÃ¥Â¤Â±Ã¨Â´Â¥Ã¯Â¼Â" + (result.error || "Ã¦ÂÂªÃ§ÂÂ¥Ã©ÂÂÃ¨Â¯Â¯"));
        }
      } catch (e) {
        alert("Ã¨Â¯Â·Ã¦Â±ÂÃ¥Â¤Â±Ã¨Â´Â¥Ã¯Â¼Â" + e.message);
      }
    }

    async function savePreset() {
      const name = document.getElementById("presetName").value.trim();
      const target_url = document.getElementById("f_url").value.trim();
      const target_key = document.getElementById("f_key").value.trim();
      const model_name = document.getElementById("f_model").value.trim();
      if (!name) { alert("Ã¨Â¯Â·Ã¥Â¡Â«Ã¥ÂÂÃ©Â¢ÂÃ¨Â®Â¾Ã¥ÂÂÃ§Â§Â°"); return; }
      if (!target_url || !model_name) { alert("Ã¨Â¯Â·Ã¥ÂÂÃ¥Â¡Â«Ã¥ÂÂ API Ã¥ÂÂ°Ã¥ÂÂÃ¥ÂÂÃ¦Â¨Â¡Ã¥ÂÂÃ¥ÂÂÃ§Â§Â°"); return; }

      const resp = await fetch("/admin/presets/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
        body: JSON.stringify({ name, target_url, target_key, model_name })
      });
      const r = await resp.json();
      if (r.success) {
        const existing = presets.findIndex(p => p.name === name);
        const entry = { name, target_url, target_key, model_name };
        if (existing >= 0) presets[existing] = entry;
        else presets.push(entry);
        renderPresets();
        document.getElementById("presetName").value = "";
        alert("Ã©Â¢ÂÃ¨Â®Â¾Ã¥Â·Â²Ã¤Â¿ÂÃ¥Â­ÂÃ¯Â¼Â" + name);
      } else {
        alert("Ã¤Â¿ÂÃ¥Â­ÂÃ¥Â¤Â±Ã¨Â´Â¥Ã¯Â¼Â" + (r.error || "Ã¦ÂÂªÃ§ÂÂ¥Ã©ÂÂÃ¨Â¯Â¯"));
      }
    }

    async function deletePreset(idx) {
      const p = presets[idx];
      if (!confirm("Ã¥ÂÂ Ã©ÂÂ¤Ã©Â¢ÂÃ¨Â®Â¾Ã£ÂÂ" + p.name + "Ã£ÂÂÃ¯Â¼Â")) return;
      await fetch("/admin/presets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
        body: JSON.stringify({ name: p.name })
      });
      presets.splice(idx, 1);
      renderPresets();
    }

    async function restartServices() {
      if (!confirm("Ã§Â¡Â®Ã¥Â®ÂÃ¨Â¦ÂÃ©ÂÂÃ¥ÂÂ¯ Gateway Ã¥ÂÂ wake_up Ã¥ÂÂÃ¯Â¼Â")) return;
      try {
        const resp = await fetch("/admin/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
          body: "{}"
        });
        const result = await resp.json();
        if (result.success) {
          alert("Ã©ÂÂÃ¥ÂÂ¯Ã¦ÂÂÃ¥ÂÂÃ¯Â¼ÂÃ©Â¡ÂµÃ©ÂÂ¢Ã§Â¨ÂÃ¥ÂÂÃ¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ·Ã¦ÂÂ°Ã£ÂÂ");
          setTimeout(() => location.reload(), 3000);
        } else {
          alert("Ã©ÂÂÃ¥ÂÂ¯Ã¥Â¤Â±Ã¨Â´Â¥Ã¯Â¼Â" + (result.error || "Ã¦ÂÂªÃ§ÂÂ¥Ã©ÂÂÃ¨Â¯Â¯"));
        }
      } catch (e) {
        alert("Ã¨Â¯Â·Ã¦Â±ÂÃ¥Â¤Â±Ã¨Â´Â¥Ã¯Â¼Â" + e.message);
      }
    }

    renderPresets();
  </script>
</body>
</html>`;

  reply.type("text/html").send(html);
});
// ========================
// Ã§Â®Â¡Ã§ÂÂÃ¤Â¿ÂÃ¥Â­Â POST /admin/save
// ========================
app.post("/admin/save", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const {
      target_url,
      target_key,
      gateway_api_key,
      model_name,
      bark_key,
      custom_icon,
      day_wake_after,
      night_wake_after,
      day_check_interval,
      night_check_interval,
      wake_day_start_hour,
      wake_day_end_hour,
      weather_enabled,
      weather_location_name,
      weather_lat,
      weather_lon,
      weather_units
    } = req.body || {};

    if (!target_url || !model_name) {
      return reply.code(400).send({ error: "target_url / model_name Ã¥Â¿ÂÃ¥Â¡Â«" });
    }

    const finalTargetKey = target_key || readEnvValue("TARGET_API_KEY");
    const finalGatewayKey = gateway_api_key || readEnvValue("GATEWAY_API_KEY");
    const finalBarkKey = bark_key || readEnvValue("BARK_KEY");

    // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-06-26Ã¯Â¼ÂÃ¥ÂÂ¬Ã¥Â¼ÂÃ§ÂÂÃ¦ÂÂÃ¥ÂÂ¤Ã©ÂÂÃ§Â­ÂÃ§ÂÂ¥Ã¥ÂÂÃ¥Â¤Â©Ã¦Â°ÂÃ¤Â¿Â¡Ã¦ÂÂ¯Ã¥Â¼ÂÃ¦ÂÂ¾Ã¥ÂÂ°Ã§Â®Â¡Ã§ÂÂÃ©Â¡ÂµÃ¯Â¼ÂÃ¤Â¿ÂÃ¥Â­ÂÃ¦ÂÂ¶Ã¥ÂÂÃ¨Â½Â»Ã©ÂÂÃ¦Â Â¡Ã©ÂªÂÃ¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ§Â©ÂºÃ¥ÂÂ¼Ã¦ÂÂÃ¨Â¿ÂÃ¨Â¡ÂÃ¤Â¸Â­Ã§ÂÂÃ¥ÂÂ¤Ã©ÂÂÃ¨ÂÂÃ¥Â¥ÂÃ¥ÂÂÃ¥ÂÂÃ£ÂÂ
    // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼ÂGATEWAY_API_KEY Ã¦ÂÂ¯Ã¥ÂÂ¬Ã¥Â¼Â /v1 Ã§ÂÂÃ¥Â®Â¢Ã¦ÂÂ·Ã§Â«Â¯Ã©ÂÂ´Ã¦ÂÂ keyÃ¯Â¼ÂÃ¤Â¸ÂÃ¨ÂÂ½Ã¥ÂÂÃ¤Â¸ÂÃ¦Â¸Â¸ TARGET_API_KEY Ã¦Â·Â·Ã¥ÂÂ¨Ã¤Â¸ÂÃ¨ÂµÂ·Ã¥Â±ÂÃ§Â¤ÂºÃ¦ÂÂÃ¨Â¿ÂÃ¥ÂÂÃ£ÂÂ
    writeEnvUpdates({
      TARGET_API_URL: target_url,
      TARGET_API_KEY: finalTargetKey,
      GATEWAY_API_KEY: finalGatewayKey,
      MODEL_NAME: model_name,
      BARK_KEY: finalBarkKey,
      CUSTOM_ICON_URL: custom_icon || "",
      DAY_WAKE_AFTER_MINUTES: normalizePositiveInteger(day_wake_after, "DAY_WAKE_AFTER_MINUTES", "60"),
      NIGHT_WAKE_AFTER_MINUTES: normalizePositiveInteger(night_wake_after, "NIGHT_WAKE_AFTER_MINUTES", "120"),
      DAY_CHECK_INTERVAL_MINUTES: normalizePositiveInteger(day_check_interval, "DAY_CHECK_INTERVAL_MINUTES", "10"),
      NIGHT_CHECK_INTERVAL_MINUTES: normalizePositiveInteger(night_check_interval, "NIGHT_CHECK_INTERVAL_MINUTES", "120"),
      WAKE_DAY_START_HOUR: normalizeHour(wake_day_start_hour, "WAKE_DAY_START_HOUR", "10", 0, 23),
      WAKE_DAY_END_HOUR: normalizeHour(wake_day_end_hour, "WAKE_DAY_END_HOUR", "24", 1, 24),
      WEATHER_ENABLED: normalizeBooleanString(weather_enabled, "WEATHER_ENABLED", "false"),
      WEATHER_LOCATION_NAME: weather_location_name || "",
      WEATHER_LAT: weather_lat || "",
      WEATHER_LON: weather_lon || "",
      WEATHER_UNITS: normalizeWeatherUnits(weather_units),
      ADMIN_USER: readEnvValue("ADMIN_USER"),
      ADMIN_PASSWORD: readEnvValue("ADMIN_PASSWORD")
    });
    console.log("\nÃ¢ÂÂ .env Ã¥Â·Â²Ã¦ÂÂ´Ã¦ÂÂ°Ã¯Â¼ÂÃ¥ÂÂ¯Ã©ÂÂÃ¨Â¿ÂÃ§Â®Â¡Ã§ÂÂÃ©Â¡ÂµÃ©ÂÂÃ¥ÂÂ¯Ã¦ÂÂÃ¥ÂÂ¡\n");

    if (wantsJsonResponse(req)) {
      return reply.send({ success: true });
    }

    reply.type("text/html").send(`<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ã¥Â·Â²Ã¤Â¿ÂÃ¥Â­Â</title></head>
<body style="text-align:center;font-family:-apple-system,sans-serif;padding:40px;">
  <h2>Ã¢ÂÂ Ã©ÂÂÃ§Â½Â®Ã¥Â·Â²Ã¤Â¿ÂÃ¥Â­Â</h2>
  <p>Ã§ÂÂ°Ã¥ÂÂ¨Ã¥ÂÂ¯Ã¤Â»Â¥Ã¨Â¿ÂÃ¥ÂÂÃ§Â®Â¡Ã§ÂÂÃ©Â¡ÂµÃ¯Â¼ÂÃ§ÂÂ¹Ã¥ÂÂ»Ã©ÂÂÃ¥ÂÂ¯Ã¦ÂÂÃ©ÂÂ®Ã¨Â®Â©Ã¦ÂÂ°Ã©ÂÂÃ§Â½Â®Ã§ÂÂÃ¦ÂÂÃ£ÂÂ</p>
  <a href="/admin">Ã¢ÂÂ Ã¨Â¿ÂÃ¥ÂÂÃ¨Â®Â¾Ã§Â½Â®</a>
</body></html>`);
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// Ã¤Â¿ÂÃ¥Â­ÂÃ©Â¢ÂÃ¨Â®Â¾Ã¦ÂÂ¹Ã¦Â¡Â
// ========================
app.post("/admin/presets/save", { preHandler: basicAuth }, async (req, reply) => {
  const { name, target_url, target_key, model_name } = req.body || {};
  if (!name || !target_url || !model_name) {
    return reply.code(400).send({ error: "name / target_url / model_name Ã¥Â¿ÂÃ¥Â¡Â«" });
  }
  const presets = loadPresets();
  const existing = presets.findIndex(p => p.name === name);
  const entry = { name, target_url, target_key: target_key || "", model_name };
  if (existing >= 0) presets[existing] = entry;
  else presets.push(entry);
  savePresets(presets);
  reply.send({ success: true });
});

// ========================
// Ã¥ÂÂ Ã©ÂÂ¤Ã©Â¢ÂÃ¨Â®Â¾Ã¦ÂÂ¹Ã¦Â¡Â
// ========================
app.post("/admin/presets/delete", { preHandler: basicAuth }, async (req, reply) => {
  const { name } = req.body || {};
  const presets = loadPresets().filter(p => p.name !== name);
  savePresets(presets);
  reply.send({ success: true });
});

// ========================
// Ã¥Â¿ÂÃ¨Â·Â³Ã¦ÂÂ¥Ã¥ÂÂ£
// ========================
app.post("/internal/heartbeat", async (req, reply) => {
  wakeUpLastHeartbeat = Date.now();
  reply.send({ status: "ok" });
});

// ========================
// Ã§Â®Â¡Ã§ÂÂÃ©Â¡ÂµÃ¤Â¸ÂÃ©ÂÂ®Ã©ÂÂÃ¥ÂÂ¯
// ========================
app.post("/admin/restart", { preHandler: basicAuth }, async (req, reply) => {
  const restartCommand = readRestartCommand();

  // Ã§Â«ÂÃ¥ÂÂ³Ã¥ÂÂÃ¥Â¤ÂÃ¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ©ÂÂÃ¥ÂÂ¯Ã¦ÂÂ¶Ã¨Â¿ÂÃ¦ÂÂ¥Ã¤Â¸Â­Ã¦ÂÂ­
  reply.send({ success: true, output: `Ã©ÂÂÃ¥ÂÂ¯Ã¦ÂÂÃ¤Â»Â¤Ã¥Â·Â²Ã¥ÂÂÃ©ÂÂÃ¯Â¼Â${restartCommand}` });
  
  // Ã§Â¨ÂÃ¥ÂÂÃ©ÂÂÃ¥ÂÂ¯Ã£ÂÂÃ©Â»ÂÃ¨Â®Â¤Ã¥ÂÂªÃ©ÂÂÃ¥ÂÂ¯Ã¦ÂÂ¬Ã©Â¡Â¹Ã§ÂÂ®Ã§ÂÂÃ¤Â¸Â¤Ã¤Â¸ÂªÃ¨Â¿ÂÃ§Â¨ÂÃ¯Â¼ÂÃ¥ÂÂ¯Ã©ÂÂÃ¨Â¿Â RESTART_COMMAND Ã¨ÂÂªÃ¥Â®ÂÃ¤Â¹ÂÃ£ÂÂ
  const { exec } = require("child_process");
  exec(restartCommand, (err, stdout, stderr) => {
    if (err) {
      console.error("Ã©ÂÂÃ¥ÂÂ¯Ã¥Â¤Â±Ã¨Â´Â¥:", stderr);
    } else {
      console.log("Ã¦ÂÂÃ¥ÂÂ¡Ã¥Â·Â²Ã©ÂÂÃ¥ÂÂ¯:", stdout);
    }
  });
});

// ========================
// Ã¦ÂµÂÃ¨Â¯Â Bark
// ========================
app.get("/test-bark", async (req, reply) => {
  const formattedTime = formatDateTimeInTimeZone(new Date(), TIME_ZONE);
  appendSpecialEvent(`Ã¯Â¼Â${formattedTime} Ã¥ÂÂÃ¥ÂÂÃ§Â»ÂÃ§ÂÂ¨Ã¦ÂÂ·Ã¥ÂÂÃ¤ÂºÂ BarkÃ¯Â¼ÂÃ¨Â¿ÂÃ¦ÂÂ¯Ã¤Â¸ÂÃ¦ÂÂ¡Ã¦ÂµÂÃ¨Â¯ÂÃ¦ÂÂ¨Ã©ÂÂÃ£ÂÂÃ¯Â¼Â`);
  reply.send({ success: true });
});

// ========================
// Ã¥ÂÂ¯Ã¥ÂÂ¨Ã¦ÂÂÃ¥ÂÂ¡
// ========================
app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Ã¢ÂÂ Gateway Ã¨Â¿ÂÃ¨Â¡ÂÃ¥ÂÂ¨ ${address}`);
});
