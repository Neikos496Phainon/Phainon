// wake_omb.js — 小白自动唤醒模块：定时读记忆库(Ombre Brain MCP) → Bark 推送
// 用法：由 start.js 拉起，或在 Dylan 容器内作为独立进程启动
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "wake_omb.config.json");
let fileConfig = {};
try { if (fs.existsSync(CONFIG_PATH)) fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch (e) { console.error("[wake_omb] 配置文件读取失败:", e.message); }

const MCP_URL = process.env.OMBRE_MCP_URL || fileConfig.mcpUrl;
const CLIENT_ID = process.env.OMBRE_CLIENT_ID || fileConfig.clientId;
const BARK_KEY = process.env.BARK_KEY;
const INTERVAL_MIN = Number(process.env.OMBRE_WAKE_INTERVAL_MIN || 60);
const TITLE = process.env.OMBRE_WAKE_TITLE || "小白想你了 💭";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const TOKEN_FILE = path.join(DATA_DIR, "omb_token.json");

// ---- refresh_token 持久化：Ombre Brain 每次刷新都会轮换 refresh_token，
//      静态配置的 token 用一次就作废（invalid_grant / unknown refresh token）。
//      所以刷新后必须把新 token 写进 /data 卷，下次启动/刷新优先读文件。
function loadPersistedToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      if (d.refresh_token) return d.refresh_token;
    }
  } catch (e) { console.error("[wake_omb] token 文件读取失败:", e.message); }
  return null;
}

function savePersistedToken(refreshToken) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: refreshToken, updated_at: new Date().toISOString() }));
  } catch (e) { console.error("[wake_omb] token 持久化失败:", e.message); }
}

let refreshToken = loadPersistedToken() || process.env.OMBRE_REFRESH_TOKEN || fileConfig.refreshToken;

if (!MCP_URL || !CLIENT_ID || !refreshToken || !BARK_KEY) {
  console.error("[wake_omb] 缺少配置：需要 OMBRE_MCP_URL / OMBRE_CLIENT_ID / OMBRE_REFRESH_TOKEN / BARK_KEY");
  process.exit(1);
}

// 用 refresh_token 换 access_token（有效期30天，自动续期）
async function getAccessToken() {
  // 每次刷新前从文件重读，防止进程重启后文件里已有更新鲜的 token
  const persisted = loadPersistedToken();
  if (persisted) refreshToken = persisted;

  const authBase = MCP_URL.replace(/\/mcp$/, "");
  const resp = await fetch(authBase + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error("token refresh failed: " + JSON.stringify(data).slice(0, 200));

  // 关键：轮换后的新 refresh_token 必须持久化，否则下一次刷新直接 invalid_grant
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    refreshToken = data.refresh_token;
    savePersistedToken(refreshToken);
    console.log("[wake_omb] refresh_token 已轮换并持久化到", TOKEN_FILE);
  }
  return data.access_token;
}

// MCP 调用（initialize → initialized → 业务调用）
async function mcpCall(accessToken, method, params = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": "Bearer " + accessToken
  };
  await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wake_omb", version: "1.0.0" } } }) });
  await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const resp = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) });
  return resp.json();
}

function extractText(result) {
  const content = result?.result?.content || result?.content || [];
  return content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

// 洗地机：把 breath 返回的技术元数据全剥掉，只留人话
function cleanForPush(text) {
  const lines = String(text || "").split("\n").map(l => l.trim());
  const out = [];
  let inFloating = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("===")) continue;            // 章节标题
    if (line.startsWith("---")) continue;             // 分隔线
    if (line.startsWith("[权重:")) { inFloating = true; continue; }  // 浮现记忆开始，跳过
    if (inFloating) continue;
    if (line.startsWith("👣")) continue;              // Footprint 行
    if (line.startsWith("💭")) continue;              // meaning 元数据
    if (line.includes("[payload_sha256:")) {          // 核心准则条目：取正文部分
      const idx = line.indexOf("[payload_sha256:");
      const closeIdx = line.indexOf("]", idx);
      const rest = line.slice(closeIdx + 1).trim();
      if (rest && !rest.startsWith("[")) out.push(rest);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

async function sendBark(body) {
  const resp = await fetch("https://api.day.app/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: TITLE, body: body.slice(0, 500), device_key: BARK_KEY })
  });
  if (!resp.ok) console.error("[wake_omb] Bark 推送失败:", await resp.text());
  return resp.ok;
}

let lastPushAt = 0;
async function wakeOnce() {
  try {
    const now = Date.now();
    if (now - lastPushAt < INTERVAL_MIN * 60 * 1000) return; // 防轰炸
    const token = await getAccessToken();
    const result = await mcpCall(token, "tools/call", { name: "breath", arguments: {} });
    const text = extractText(result);
    if (!text) { console.log("[wake_omb] breath 返回空"); return; }
    const snippet = cleanForPush(text).slice(0, 450);
    if (!snippet) { console.log("[wake_omb] 清洗后为空"); return; }
    await sendBark(snippet);
    lastPushAt = Date.now();
    console.log("[wake_omb] 已推送 ", new Date().toLocaleString("zh-CN", { timeZone: process.env.TIME_ZONE || "Asia/Shanghai" }));
  } catch (e) {
    console.error("[wake_omb] error:", e.message);
  }
}

console.log("[wake_omb] 小白自动唤醒模块启动，每", INTERVAL_MIN, "分钟检查一次，token 持久化于", TOKEN_FILE);
wakeOnce();
setInterval(wakeOnce, Math.max(5, INTERVAL_MIN) * 60 * 1000);
