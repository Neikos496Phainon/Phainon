// wake_omb.js — 小白自动唤醒模块：定时读记忆库(Ombre Brain MCP) → Bark 推送
// 用法：与 start.js 一起跑，或在 Dylan 容器内作为独立进程启动
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "wake_omb.config.json");
let fileConfig = {};
try { if (fs.existsSync(CONFIG_PATH)) fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch (e) { console.error("[wake_omb] 配置文件读取失败:", e.message); }

const MCP_URL = process.env.OMBRE_MCP_URL || fileConfig.mcpUrl;
const CLIENT_ID = process.env.OMBRE_CLIENT_ID || fileConfig.clientId;
const REFRESH_TOKEN = process.env.OMBRE_REFRESH_TOKEN || fileConfig.refreshToken;
const BARK_KEY = process.env.BARK_KEY;
const INTERVAL_MIN = Number(process.env.OMBRE_WAKE_INTERVAL_MIN || 60);
const TITLE = process.env.OMBRE_WAKE_TITLE || "小白想你了 💭";

if (!MCP_URL || !CLIENT_ID || !REFRESH_TOKEN || !BARK_KEY) {
  console.error("[wake_omb] 缺少配置：需要 OMBRE_MCP_URL / OMBRE_CLIENT_ID / OMBRE_REFRESH_TOKEN / BARK_KEY");
  process.exit(1);
}

// 用 refresh_token 换 access_token（有效期30天，自动续期）
async function getAccessToken() {
  const authBase = MCP_URL.replace(/\/mcp$/, "");
  const resp = await fetch(authBase + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error("token refresh failed: " + JSON.stringify(data).slice(0, 200));
  return data.access_token;
}

// MCP 调用（initialize → initialized → 业务调用）
async function mcpCall(accessToken, method, params = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": "Bearer " + accessToken
  };
  await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "dylan-wake-omb", version: "1.0.0" } } }) });
  await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const resp = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) });
  return resp.json();
}

function extractText(result) {
  const content = result?.result?.content || result?.content || [];
  return content.filter(c => c.type === "text").map(c => c.text).join("\n");
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
    const lines = text.split("\n").filter(l => l.trim());
    const snippet = lines.slice(0, 10).join("\n").slice(0, 400);
    await sendBark(snippet);
    lastPushAt = Date.now();
    console.log("[wake_omb] 已推送 ", new Date().toLocaleString("zh-CN", { timeZone: process.env.TIME_ZONE || "Asia/Shanghai" }));
  } catch (e) {
    console.error("[wake_omb] error:", e.message);
  }
}

console.log("[wake_omb] 小白自动唤醒模块启动，每", INTERVAL_MIN, "分钟检查一次");
wakeOnce();
setInterval(wakeOnce, Math.max(5, INTERVAL_MIN) * 60 * 1000);
