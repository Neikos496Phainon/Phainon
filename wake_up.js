require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { buildNtfyPayload } = require("./ntfy_priority");
const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");

const TIMELINE_PATH = path.join(DATA_DIR, "enhanced_messages.json");
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = resolveTimeZone();
const WEATHER_TIMEOUT_MS = 5000;
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = path.isAbsolute(DIARY_DIR_NAME)
  ? DIARY_DIR_NAME
  : path.join(__dirname, DIARY_DIR_NAME);

function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  return fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function getDiaryDateString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDiaryTimeString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-11Ã¯Â¼ÂÃ¦ÂÂ¥Ã¨Â®Â°Ã¥ÂÂªÃ¦ÂÂ¥Ã¥ÂÂÃ¦Â¨Â¡Ã¥ÂÂÃ¦ÂÂ¾Ã¥Â¼ÂÃ¨Â¾ÂÃ¥ÂÂºÃ§ÂÂ [DIARY] Ã¥ÂÂÃ¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ¦ÂÂÃ¦ÂÂ®Ã©ÂÂÃ¦ÂÂ¨Ã©ÂÂÃ¥ÂÂÃ¥Â®Â¹Ã¨Â¯Â¯Ã¥ÂÂÃ¨Â¿ÂÃ¦ÂÂ¬Ã¥ÂÂ°Ã¦ÂÂ¥Ã¨Â®Â°Ã£ÂÂ
function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  }).trim();
  return {
    diaryContent: diaryBlocks.join("\n\n").trim(),
    remainingText
  };
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true)) {
    console.log("Ã¦Â¨Â¡Ã¥ÂÂÃ¥ÂÂÃ¤ÂºÂÃ¦ÂÂ¥Ã¨Â®Â°Ã¯Â¼ÂÃ¤Â½Â DIARY_ENABLED=falseÃ¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¤Â¸ÂÃ¤Â¿ÂÃ¥Â­Â");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
  const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
  fs.appendFileSync(diaryFile, entry, "utf-8");
  console.log(`Ã¥Â·Â²Ã¤Â¿ÂÃ¥Â­ÂÃ¦ÂÂ¥Ã¨Â®Â°Ã¯Â¼Â${diaryFile}`);
  return true;
}

// Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-11Ã¯Â¼ÂÃ¦ÂÂ¨Ã©ÂÂÃ¥Â±ÂÃ¦ÂÂ©Ã¥Â±ÂÃ¤Â¸Âº Bark/ntfyÃ¯Â¼ÂÃ©Â»ÂÃ¨Â®Â¤Ã¤Â»ÂÃ¨ÂµÂ° BarkÃ¯Â¼ÂÃ¤Â¿ÂÃ¦ÂÂ¤Ã¦ÂÂ§Ã©ÂÂ¨Ã§Â½Â²Ã¤Â¸ÂÃ¦ÂÂ¹ .env Ã¤Â¹ÂÃ¨ÂÂ½Ã§Â»Â§Ã§Â»Â­Ã¨Â¿ÂÃ¨Â¡ÂÃ£ÂÂ
async function sendPushNotification({ title, body }) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC Ã¦ÂÂªÃ©ÂÂÃ§Â½Â®" };

    const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });

    const response = await fetch(server, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    if (!response.ok) {
      return { ok: false, providerLabel: "ntfy", reason: responseText || `HTTP ${response.status}` };
    }
    return { ok: true, providerLabel: "ntfy" };
  }

  if (provider !== "bark") {
    return { ok: false, providerLabel: provider || "Ã¦ÂÂªÃ§ÂÂ¥Ã¦Â¸Â Ã©ÂÂ", reason: `Ã¤Â¸ÂÃ¦ÂÂ¯Ã¦ÂÂÃ§ÂÂ PUSH_PROVIDERÃ¯Â¼Â${provider}` };
  }

  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key Ã¦ÂÂªÃ©ÂÂÃ§Â½Â®" };
  }

  const barkPayload = {
    title,
    body,
    device_key: process.env.BARK_KEY,
    icon: process.env.CUSTOM_ICON_URL
  };

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(barkPayload)
  });

  const responseText = await response.text();
  let result = {};
  try {
    result = JSON.parse(responseText);
  } catch {}
  console.log("\nBark Result:\n", result || responseText);

  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, providerLabel: "Bark" };
}

function isDayTime(date = new Date()) {
  const hour = getHourInTimeZone(date, TIME_ZONE);
  const start = readNumberEnv("WAKE_DAY_START_HOUR", 10, { min: 0, max: 23 });
  const end = readNumberEnv("WAKE_DAY_END_HOUR", 24, { min: 1, max: 24 });
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function getWakeAfterMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_WAKE_AFTER_MINUTES", 60, { min: 1 })
    : readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 120, { min: 1 });
}

function getCheckIntervalMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 10, { min: 1 })
    : readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 120, { min: 1 });
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[Ã¥ÂÂ¾Ã§ÂÂ]";
        if (part.file || type.includes("file")) return "[Ã¦ÂÂÃ¤Â»Â¶]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[Ã¥ÂÂ¾Ã§ÂÂ]";
    if (content.file || type.includes("file")) return "[Ã¦ÂÂÃ¤Â»Â¶]";
  }

  return "[Ã©ÂÂÃ¦ÂÂÃ¦ÂÂ¬Ã¥ÂÂÃ¥Â®Â¹]";
}

function summarizeWakeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let chars = 0;
  for (const msg of list) {
    roles[msg?.role || ""] = (roles[msg?.role || ""] || 0) + 1;
    chars += normalizeContentToText(msg?.content).length;
  }
  return { total: list.length, roles, text_chars: chars };
}

function weatherCodeText(code) {
  const table = {
    0: "Ã¦ÂÂ´Ã¦ÂÂ",
    1: "Ã¥Â¤Â§Ã¨ÂÂ´Ã¦ÂÂ´Ã¦ÂÂ",
    2: "Ã¥Â±ÂÃ©ÂÂ¨Ã¥Â¤ÂÃ¤ÂºÂ",
    3: "Ã©ÂÂ´Ã¥Â¤Â©",
    45: "Ã¦ÂÂÃ©ÂÂ¾",
    48: "Ã©ÂÂ¾Ã¥ÂÂ",
    51: "Ã¥Â°ÂÃ¦Â¯ÂÃ¦Â¯ÂÃ©ÂÂ¨",
    53: "Ã¤Â¸Â­Ã§Â­ÂÃ¦Â¯ÂÃ¦Â¯ÂÃ©ÂÂ¨",
    55: "Ã¨Â¾ÂÃ¥Â¼ÂºÃ¦Â¯ÂÃ¦Â¯ÂÃ©ÂÂ¨",
    61: "Ã¥Â°ÂÃ©ÂÂ¨",
    63: "Ã¤Â¸Â­Ã©ÂÂ¨",
    65: "Ã¥Â¤Â§Ã©ÂÂ¨",
    71: "Ã¥Â°ÂÃ©ÂÂª",
    73: "Ã¤Â¸Â­Ã©ÂÂª",
    75: "Ã¥Â¤Â§Ã©ÂÂª",
    80: "Ã©ÂÂµÃ©ÂÂ¨",
    81: "Ã¨Â¾ÂÃ¥Â¼ÂºÃ©ÂÂµÃ©ÂÂ¨",
    82: "Ã¥Â¼ÂºÃ©ÂÂµÃ©ÂÂ¨",
    95: "Ã©ÂÂ·Ã¦ÂÂ´",
    96: "Ã©ÂÂ·Ã¦ÂÂ´Ã¤Â¼Â´Ã¥Â°ÂÃ¥ÂÂ°Ã©ÂÂ¹",
    99: "Ã©ÂÂ·Ã¦ÂÂ´Ã¤Â¼Â´Ã¥Â¤Â§Ã¥ÂÂ°Ã©ÂÂ¹"
  };
  return table[code] || `Ã¥Â¤Â©Ã¦Â°ÂÃ¤Â»Â£Ã§Â Â ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("Ã¥Â·Â²Ã¥ÂÂ¯Ã§ÂÂ¨ WEATHER_ENABLEDÃ¯Â¼ÂÃ¤Â½Â WEATHER_LAT / WEATHER_LON Ã¦ÂÂªÃ¦Â­Â£Ã§Â¡Â®Ã©ÂÂÃ§Â½Â®Ã¯Â¼ÂÃ¨Â·Â³Ã¨Â¿ÂÃ¥Â¤Â©Ã¦Â°ÂÃ¦Â³Â¨Ã¥ÂÂ¥");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "Ã¥Â½ÂÃ¥ÂÂÃ¤Â½ÂÃ§Â½Â®";
  const units = (process.env.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## Ã¥Â¤Â©Ã¦Â°ÂÃ¤Â¿Â¡Ã¦ÂÂ¯",
      `- Ã¤Â½ÂÃ§Â½Â®Ã¯Â¼Â${location}`,
      `- Ã¥Â½ÂÃ¥ÂÂÃ¯Â¼Â${weatherCodeText(current.weather_code)}Ã¯Â¼Â${current.temperature_2m}${unitsInfo.temperature_2m || "ÃÂ°C"}Ã¯Â¼ÂÃ¤Â½ÂÃ¦ÂÂ ${current.apparent_temperature}${unitsInfo.apparent_temperature || "ÃÂ°C"}`,
      `- Ã¦Â¹Â¿Ã¥ÂºÂ¦Ã¯Â¼Â${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- Ã©ÂÂÃ©ÂÂ¨Ã¯Â¼Â${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- Ã©Â£ÂÃ©ÂÂÃ¯Â¼Â${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- Ã¦ÂÂ¥Ã¥ÂÂº/Ã¦ÂÂ¥Ã¨ÂÂ½Ã¯Â¼Â${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.log("Ã¥Â¤Â©Ã¦Â°ÂÃ¦Â³Â¨Ã¥ÂÂ¥Ã¥Â¤Â±Ã¨Â´Â¥Ã¯Â¼ÂÃ¨Â·Â³Ã¨Â¿ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¥Â¤Â©Ã¦Â°ÂÃ¤Â¿Â¡Ã¦ÂÂ¯:", err.message);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("Ã¦ÂÂªÃ¦ÂÂ¾Ã¥ÂÂ° enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json Ã¦Â Â¼Ã¥Â¼ÂÃ©ÂÂÃ¨Â¯Â¯Ã¯Â¼ÂÃ©Â¡Â¶Ã¥Â±ÂÃ¤Â¸ÂÃ¦ÂÂ¯Ã¦ÂÂ°Ã§Â»Â");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("Ã¨Â¯Â»Ã¥ÂÂ enhanced_messages.json Ã¥Â¤Â±Ã¨Â´Â¥:", err.message);
    return null;
  }
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function getLocalTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function shouldWake(lastUserTime) {
  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  return diffMinutes >= getWakeAfterMinutes(now);
}

function parseTimelineTimestamp(value) {
  const text = String(value || "");
  const match = text.match(/Ã¯Â¼Â?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:Ã¯Â¼Â](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      const content = normalizeContentToText(msg.content);
      // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼ÂÃ¥ÂÂ¼Ã¥Â®Â¹ Kelivo Ã¦ÂÂ¶Ã©ÂÂ´Ã¥ÂÂÃ§Â¼Â "YYYY-MM-DDHH:mm"Ã¯Â¼Â
      // Ã¦ÂÂ§Ã§ÂÂ "YYYY-MM-DD HH:mm" Ã¤Â»ÂÃ§ÂÂ¶Ã¥ÂÂ¯Ã§ÂÂ¨Ã¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ¦ÂÂ Ã§Â©ÂºÃ¦Â Â¼Ã¦ÂÂ¶Ã©ÂÂ´Ã¥Â¯Â¼Ã¨ÂÂ´ wake-up Ã¨Â¯Â¯Ã¥ÂÂ¤Ã¦Â²Â¡Ã¦ÂÂÃ§ÂÂ¨Ã¦ÂÂ·Ã¦ÂÂ¶Ã©ÂÂ´Ã£ÂÂ
      const parsed = parseTimelineTimestamp(content);
      if (parsed) return parsed;
    }
  }
  return null;
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "") {
  // Ã¤Â¼ÂÃ¥ÂÂÃ¨Â¯Â»Ã¥ÂÂÃ§ÂÂ¬Ã§Â«ÂÃ§ÂÂÃ¦ÂÂÃ§Â¤ÂºÃ¨Â¯ÂÃ¦ÂÂÃ¤Â»Â¶Ã¯Â¼ÂÃ¦ÂÂ¨Ã¨ÂÂÃ¦ÂÂ¹Ã¥Â¼ÂÃ¯Â¼Â
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // Ã¥Â¦ÂÃ¦ÂÂÃ¦ÂÂÃ¤Â»Â¶Ã¤Â¸ÂÃ¥Â­ÂÃ¥ÂÂ¨Ã¯Â¼ÂÃ¥Â°ÂÃ¨Â¯ÂÃ¤Â»ÂÃ§ÂÂ¯Ã¥Â¢ÂÃ¥ÂÂÃ©ÂÂÃ¨Â¯Â»Ã¥ÂÂÃ¯Â¼ÂÃ¥ÂÂ¼Ã¥Â®Â¹Ã¦ÂÂ§Ã©ÂÂÃ§Â½Â®Ã¯Â¼Â
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // Ã©Â»ÂÃ¨Â®Â¤Ã§ÂÂÃ¦ÂÂºÃ§ÂÂÃ¦ÂÂ¬Ã¯Â¼ÂÃ¥Â¼ÂÃ¦ÂºÂÃ©ÂÂÃ§ÂÂ¨Ã¯Â¼ÂÃ¯Â¼ÂÃ¥ÂÂ¯Ã¨ÂÂªÃ¨Â¡ÂÃ¤Â¿Â®Ã¦ÂÂ¹Ã¦ÂÂÃ§Â¤ÂºÃ¨Â¯Â
  return `
## Ã¦ÂÂÃ©Â«ÂÃ¤Â¼ÂÃ¥ÂÂÃ§ÂºÂ§Ã¨Â§ÂÃ¥ÂÂ
1. Ã¨Â¿ÂÃ¦ÂÂ¯Ã¤Â¸ÂÃ¦Â¬Â¡Ã¥ÂÂÃ¥ÂÂ°Ã¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¤Â¸ÂÃ¦ÂÂ¯Ã§ÂÂ¨Ã¦ÂÂ·Ã¥ÂÂÃ¨ÂµÂ·Ã§ÂÂÃ¥Â¯Â¹Ã¨Â¯ÂÃ£ÂÂÃ¤Â½Â Ã¦Â²Â¡Ã¦ÂÂÃ¦ÂÂ¶Ã¥ÂÂ°Ã¤Â»Â»Ã¤Â½ÂÃ¦ÂÂ°Ã¦Â¶ÂÃ¦ÂÂ¯Ã£ÂÂ
2. Ã¤Â½Â Ã§ÂÂÃ¥ÂÂ¯Ã¤Â¸ÂÃ¤Â»Â»Ã¥ÂÂ¡Ã¦ÂÂ¯Ã¥ÂÂ³Ã¥Â®ÂÃ¦ÂÂ¯Ã¥ÂÂ¦Ã¤Â¸Â»Ã¥ÂÂ¨Ã¨ÂÂÃ§Â³Â»Ã§ÂÂ¨Ã¦ÂÂ·Ã£ÂÂÃ¤Â¸ÂÃ¨ÂÂ½Ã§ÂÂÃ¦ÂÂÃ¥Â¯Â¹Ã¨Â¯ÂÃ¥ÂÂÃ¥Â¤ÂÃ£ÂÂ
3. Ã¨Â¾ÂÃ¥ÂÂºÃ¦Â Â¼Ã¥Â¼ÂÃ¥Â¿ÂÃ©Â¡Â»Ã¤Â¸Â¥Ã¦Â Â¼Ã©ÂÂµÃ¥Â®ÂÃ¤Â»Â¥Ã¤Â¸ÂÃ¤ÂºÂÃ©ÂÂÃ¤Â¸ÂÃ£ÂÂ

## Ã¥ÂÂ¤Ã©ÂÂÃ¤Â¿Â¡Ã¦ÂÂ¯
- Ã¥Â½ÂÃ¥ÂÂÃ¦ÂÂ¶Ã©ÂÂ´Ã¯Â¼Â${currentTime}
- Ã¨Â·ÂÃ§Â¦Â»Ã§ÂÂ¨Ã¦ÂÂ·Ã¦ÂÂÃ¥ÂÂÃ¤Â¸ÂÃ¦ÂÂ¡Ã¦Â¶ÂÃ¦ÂÂ¯Ã¯Â¼Â${diffMinutes} Ã¥ÂÂÃ©ÂÂ
${weatherContext ? `\n${weatherContext}\n` : ""}

## Ã¨Â¾ÂÃ¥ÂÂºÃ¦Â Â¼Ã¥Â¼Â
- Ã¥Â¦ÂÃ¦ÂÂÃ¦ÂÂ³Ã¨ÂÂÃ§Â³Â»Ã§ÂÂ¨Ã¦ÂÂ·Ã¯Â¼ÂÃ§ÂÂ´Ã¦ÂÂ¥Ã¥ÂÂÃ¤Â½Â Ã¦ÂÂ³Ã¨Â¯Â´Ã§ÂÂÃ¨Â¯ÂÃ£ÂÂÃ§Â³Â»Ã§Â»ÂÃ¤Â¼ÂÃ¨ÂÂªÃ¥ÂÂ¨Ã¦ÂÂÃ¥ÂÂÃ¦ÂÂÃ¦ÂÂÃ¦ÂÂºÃ¦ÂÂ¨Ã©ÂÂÃ¥ÂÂÃ©ÂÂÃ£ÂÂÃ¥ÂÂ¯Ã¤Â»Â¥Ã¦ÂÂ¯Ã¤Â¸ÂÃ¥ÂÂ¥Ã¨Â¯ÂÃ¯Â¼ÂÃ¤Â¹ÂÃ¥ÂÂ¯Ã¤Â»Â¥Ã§Â¬Â¬Ã¤Â¸ÂÃ¨Â¡ÂÃ¤Â½ÂÃ¤Â¸ÂºÃ¦Â ÂÃ©Â¢ÂÃ£ÂÂÃ§Â¬Â¬Ã¤ÂºÂÃ¨Â¡ÂÃ¤Â½ÂÃ¤Â¸ÂºÃ¦Â­Â£Ã¦ÂÂÃ£ÂÂ
- Ã¥Â¦ÂÃ¦ÂÂÃ¤Â¸ÂÃ¦ÂÂ³Ã¨ÂÂÃ§Â³Â»Ã¯Â¼ÂÃ¥ÂÂªÃ¨Â¾ÂÃ¥ÂÂºÃ¯Â¼Â[NO_ACTION]Ã¯Â¼ÂÃ¥ÂÂ¯Ã©ÂÂÃ¥Â¸Â¦Ã§Â®ÂÃ§ÂÂ­Ã¥ÂÂÃ¥ÂÂ Ã¯Â¼Â10Ã¥Â­ÂÃ¤Â»Â¥Ã¥ÂÂÃ¯Â¼ÂÃ£ÂÂ
- Ã¥Â¦ÂÃ¦ÂÂÃ¤Â½Â Ã¦ÂÂ³Ã¥ÂÂÃ¦ÂÂ¥Ã¨Â®Â°Ã¯Â¼ÂÃ¥ÂÂ¯Ã¤Â»Â¥Ã©Â¢ÂÃ¥Â¤ÂÃ¨Â¾ÂÃ¥ÂÂº [DIARY]...[/DIARY]Ã£ÂÂÃ¥ÂÂªÃ¦ÂÂÃ¦ÂÂ³Ã¥ÂÂÃ¦ÂÂ¶Ã¦ÂÂÃ¥ÂÂÃ¯Â¼ÂÃ¤Â¸ÂÃ¥Â¿ÂÃ¦Â¯ÂÃ¦Â¬Â¡Ã©ÂÂ½Ã¥ÂÂÃ£ÂÂ
`;
}

async function runWakeUp() {
  console.log("\n==========================");
  console.log("Ã¥Â¼ÂÃ¥Â§ÂÃ¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂ");
  console.log("==========================\n");

  const messages = loadTimelineMessages();
  if (!messages) return;

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("Ã¦ÂÂªÃ¦ÂÂ¾Ã¥ÂÂ°Ã§ÂÂ¨Ã¦ÂÂ·Ã¦ÂÂ¶Ã©ÂÂ´");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  if (!shouldWake(lastUserTime)) {
    console.log("\nÃ¦ÂÂÃ¤Â¸ÂÃ©ÂÂÃ¨Â¦ÂÃ¥ÂÂ¤Ã©ÂÂ\n");
    return;
  }

  const weatherContext = await fetchWeatherContext();
  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes, weatherContext);
  const cleanMessages = stripPosition(messages);

  const historyText = cleanMessages
    .filter(msg => msg.role !== "system")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("Ã¨Â®Â°Ã¥Â¿ÂÃ¥ÂºÂÃ¤Â½Â¿Ã§ÂÂ¨Ã§Â­ÂÃ§ÂÂ¥");
    })
    .map(msg => {
      const userDisplay = process.env.USER_DISPLAY_NAME || "Ã§ÂÂ¨Ã¦ÂÂ·";
      const aiDisplay = process.env.AI_DISPLAY_NAME || "AI";
      const role = msg.role === "user" ? userDisplay : aiDisplay;
      let content = normalizeContentToText(msg.content);
      if (content.includes("## Memories")) {
        content = content.split("## Memories")[0];
      }
      return `[${role}] ${content}`;
    })
    .join("\n\n");

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    {
      role: "system",
      content: [wakePrompt, cleanSP].filter(Boolean).join("\n\n")
    },
    {
      // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼ÂClaude/Ã©ÂÂ¨Ã¥ÂÂ New API Ã©ÂÂÃ©ÂÂÃ¥ÂÂ¨Ã¤Â¼ÂÃ¦ÂÂ system Ã¦ÂÂ½Ã¦ÂÂÃ§ÂÂ¬Ã§Â«ÂÃ¥Â­ÂÃ¦Â®ÂµÃ¯Â¼Â
      // Ã¥ÂÂ¤Ã©ÂÂÃ¨Â¯Â·Ã¦Â±ÂÃ¥Â¦ÂÃ¦ÂÂÃ¥ÂÂ¨Ã¦ÂÂ¯ systemÃ¯Â¼ÂÃ¤Â¸ÂÃ¦Â¸Â¸ messages Ã¤Â¼ÂÃ¥ÂÂÃ§Â©ÂºÃ¯Â¼ÂÃ¥ÂÂ Ã¦Â­Â¤Ã¦ÂÂÃ¨Â¿ÂÃ¨Â®Â°Ã¥Â½ÂÃ¥Â¿ÂÃ©Â¡Â»Ã¤Â½ÂÃ¤Â¸Âº user Ã¤Â»Â»Ã¥ÂÂ¡Ã¨Â¾ÂÃ¥ÂÂ¥Ã¥ÂÂÃ©ÂÂÃ£ÂÂ
      role: "user",
      content: `Ã¤Â»Â¥Ã¤Â¸ÂÃ¦ÂÂ¯Ã¤Â½Â Ã¤Â¸ÂÃ§ÂÂ¨Ã¦ÂÂ·Ã¦ÂÂÃ¨Â¿ÂÃ§ÂÂÃ¨ÂÂÃ¥Â¤Â©Ã¨Â®Â°Ã¥Â½ÂÃ¯Â¼ÂÃ¤Â»ÂÃ¤Â¾ÂÃ¥ÂÂÃ¥Â¿ÂÃ¥ÂÂÃ¥ÂÂÃ¨ÂÂÃ£ÂÂ

Ã¨Â¿ÂÃ¤ÂºÂÃ¥ÂÂÃ¥Â®Â¹Ã¤Â¸ÂÃ¦ÂÂ¯Ã¦Â­Â£Ã¥ÂÂ¨Ã¥ÂÂÃ§ÂÂÃ§ÂÂÃ¥Â®ÂÃ¦ÂÂ¶Ã¥Â¯Â¹Ã¨Â¯ÂÃ£ÂÂ
Ã§ÂÂ¨Ã¦ÂÂ·Ã¥Â¹Â¶Ã¦Â²Â¡Ã¦ÂÂÃ§Â»ÂÃ¤Â½Â Ã¥ÂÂÃ¦Â¶ÂÃ¦ÂÂ¯Ã£ÂÂ

Ã¤Â½Â Ã§ÂÂ°Ã¥ÂÂ¨Ã¥Â¤ÂÃ¤ÂºÂÃ¥ÂÂÃ¥ÂÂ°Ã¨ÂÂªÃ¤Â¸Â»Ã¥ÂÂ¤Ã©ÂÂÃ§ÂÂ¶Ã¦ÂÂÃ£ÂÂ

Ã¦ÂÂÃ¨Â¿ÂÃ¨Â®Â°Ã¥Â½ÂÃ¯Â¼Â

${historyText}`
    }
  ];

  // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-07-15Ã¯Â¼Âwake-up prompt Ã¤Â¼ÂÃ¥ÂÂÃ¥ÂÂ«Ã¦ÂÂÃ¨Â¿ÂÃ¨ÂÂÃ¥Â¤Â©Ã¨Â®Â°Ã¥Â½ÂÃ¯Â¼Â
  // Ã©Â»ÂÃ¨Â®Â¤Ã¦ÂÂ¥Ã¥Â¿ÂÃ¥ÂÂªÃ¥ÂÂÃ¦ÂÂÃ¨Â¦ÂÃ¯Â¼ÂÃ©ÂÂ¿Ã¥ÂÂÃ¥ÂÂ¬Ã¥Â¼ÂÃ©ÂÂ¨Ã§Â½Â²Ã¦ÂÂ¶Ã¦ÂÂÃ¥Â®ÂÃ¦ÂÂ´Ã¤Â¸ÂÃ¤Â¸ÂÃ¦ÂÂÃ¥ÂÂ·Ã¨Â¿Â pm2 Ã¦ÂÂ¥Ã¥Â¿ÂÃ£ÂÂ
  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("Ã§Â¼ÂºÃ¥Â°Â TARGET_API_URL / TARGET_API_KEY / MODEL_NAMEÃ¯Â¼ÂÃ¨Â·Â³Ã¨Â¿ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¥ÂÂ¤Ã©ÂÂ");
    return;
  }

  const response = await fetch(process.env.TARGET_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TARGET_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME,
      messages: wakeMessages,
      temperature: 0.8,
      top_p: 0.95,
      stream: false
    })
  });

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Ã¦Â¨Â¡Ã¥ÂÂÃ¨Â¿ÂÃ¥ÂÂÃ§ÂÂÃ¤Â¸ÂÃ¦ÂÂ¯ JSONÃ¯Â¼ÂHTTP ${response.status}Ã¯Â¼ÂÃ¯Â¼Â${responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`Ã¦Â¨Â¡Ã¥ÂÂÃ¨Â¯Â·Ã¦Â±ÂÃ¥Â¤Â±Ã¨Â´Â¥Ã¯Â¼ÂHTTP ${response.status}Ã¯Â¼ÂÃ¯Â¼Â${responseText.slice(0, 300)}`);
  }

  const rawAiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  console.log("\nWake Result Summary:\n");
  console.log(JSON.stringify({ choices: Array.isArray(data.choices) ? data.choices.length : 0, ai_text_chars: rawAiText.length }));

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = appendDiaryEntry(diaryResult.diaryContent);
  const aiText = diaryResult.remainingText;

  let eventContent;

  if (!aiText) {
    console.log("\nAI Ã¦ÂÂªÃ¨Â¿ÂÃ¥ÂÂÃ¦ÂÂ¨Ã©ÂÂÃ¥ÂÂÃ¥Â®Â¹Ã¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¤Â¸ÂÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂ\n");
    eventContent = diarySaved
      ? `Ã¯Â¼Â${getLocalTimeString()} Ã¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¦ÂÂªÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂÃ¯Â½ÂÃ¥ÂÂÃ¥ÂÂ Ã¯Â¼ÂÃ¥ÂÂªÃ¥ÂÂÃ¦ÂÂ¥Ã¨Â®Â°Ã¯Â¼Â`
      : `Ã¯Â¼Â${getLocalTimeString()} Ã¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¦ÂÂªÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂÃ¯Â½ÂÃ¥ÂÂÃ¥ÂÂ Ã¯Â¼ÂÃ¦Â¨Â¡Ã¥ÂÂÃ§Â©ÂºÃ¥ÂÂÃ¥Â¤ÂÃ¯Â¼Â`;
  // Ã¥ÂÂ¤Ã¦ÂÂ­ AI Ã¦ÂÂ¯Ã¥ÂÂ¦Ã¦ÂÂÃ§Â¡Â®Ã¨Â¦ÂÃ©ÂÂÃ©Â»Â
  } else if (aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/)) {
    const noActionMatch = aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/);
    // AI Ã©ÂÂÃ¦ÂÂ©Ã¤Â¸ÂÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂ
    console.log("\nAI Ã©ÂÂÃ¦ÂÂ©Ã¤Â¸ÂÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂ\n");
    let reason = (noActionMatch[1] || "").trim();
    if (reason.startsWith("Ã¥ÂÂÃ¥ÂÂ Ã¯Â¼Â") || reason.startsWith("Ã¥ÂÂÃ¥ÂÂ :")) {
      reason = reason.replace(/^Ã¥ÂÂÃ¥ÂÂ [Ã¯Â¼Â:]\s*/, "").trim();
    }
    eventContent = reason
      ? `Ã¯Â¼Â${getLocalTimeString()} Ã¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¦ÂÂªÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂÃ¯Â½ÂÃ¥ÂÂÃ¥ÂÂ Ã¯Â¼Â${reason}Ã¯Â¼Â`
      : `Ã¯Â¼Â${getLocalTimeString()} Ã¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¦ÂÂªÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂÃ¯Â¼Â`;
  } else {
    // Ã¦Â²Â¡Ã¦ÂÂ [NO_ACTION] Ã¥Â°Â±Ã¨Â§ÂÃ¤Â¸ÂºÃ¦ÂÂ³Ã¥ÂÂÃ¦ÂÂ¨Ã©ÂÂ
    console.log("\nAI Ã©ÂÂÃ¦ÂÂ©Ã¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂ\n");
    let barkText = aiText;

    // Ã¥Â¦ÂÃ¦ÂÂ AI Ã¨Â¿ÂÃ¦ÂÂ¯Ã¥ÂÂÃ¤ÂºÂ [BARK] ... [/BARK] Ã¦Â ÂÃ§Â­Â¾Ã¯Â¼ÂÃ¥Â°Â±Ã¥ÂÂ¥Ã¦ÂÂ
    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }

    // Ã¦Â¸ÂÃ¦Â´ÂÃ¢ÂÂÃ¦Â ÂÃ©Â¢ÂÃ¯Â¼ÂÃ¢ÂÂÃ£ÂÂÃ¢ÂÂÃ¦Â­Â£Ã¦ÂÂÃ¯Â¼ÂÃ¢ÂÂÃ¥ÂÂÃ§Â¼ÂÃ¯Â¼ÂÃ¥Â¦ÂÃ¦ÂÂÃ¦ÂÂÃ¯Â¼Â
    barkText = barkText
      .replace(/^Ã¦Â ÂÃ©Â¢Â[Ã¯Â¼Â:]\s*/gm, "")
      .replace(/^Ã¦Â­Â£Ã¦ÂÂ[Ã¯Â¼Â:]\s*/gm, "");

    // Ã¦ÂÂÃ¨Â¡ÂÃ¥Â¤ÂÃ§ÂÂ
    const lines = barkText.split("\n").filter(line => line.trim() !== "");

    let title, body;
    if (lines.length === 0) {
      console.log("\nÃ¦ÂÂ¨Ã©ÂÂÃ¥ÂÂÃ¥Â®Â¹Ã¦Â¸ÂÃ¦Â´ÂÃ¥ÂÂÃ¤Â¸ÂºÃ§Â©ÂºÃ¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¤Â¸ÂÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂ\n");
      eventContent = `Ã¯Â¼Â${getLocalTimeString()} Ã¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¦ÂÂªÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂÃ¯Â½ÂÃ¥ÂÂÃ¥ÂÂ Ã¯Â¼ÂÃ¦ÂÂ¨Ã©ÂÂÃ¥ÂÂÃ¥Â®Â¹Ã¤Â¸ÂºÃ§Â©ÂºÃ¯Â¼Â`;
    } else if (lines.length === 1) {
      title = "Ã¦ÂÂ¥Ã¨ÂÂªAI";
      body = lines[0].trim();
    } else if (lines.length === 2) {
      title = lines[0].trim();
      body = lines[1].trim();
    } else {
      // Ã¢ÂÂ¥3 Ã¨Â¡ÂÃ¯Â¼ÂÃ§Â¬Â¬Ã¤Â¸ÂÃ¨Â¡ÂÃ¦Â ÂÃ©Â¢ÂÃ¯Â¼ÂÃ¥ÂÂ©Ã¤Â½ÂÃ§ÂÂ¨Ã§Â©ÂºÃ¦Â Â¼Ã¦ÂÂ¼Ã¦ÂÂ¥Ã¦ÂÂÃ¦Â­Â£Ã¦ÂÂ
      title = lines[0].trim();
      body = lines.slice(1).map(l => l.trim()).join(" ");
    }

    if (!eventContent) {
      // Ã¤Â¿ÂÃ¦ÂÂ¤Ã¯Â¼ÂÃ¦ÂÂªÃ¦ÂÂ­Ã¨Â¿ÂÃ©ÂÂ¿Ã¦Â­Â£Ã¦ÂÂÃ¯Â¼ÂÃ¥ÂÂ¼Ã¥Â®Â¹ Bark Ã¥ÂÂ ntfy Ã§ÂÂÃ§Â§Â»Ã¥ÂÂ¨Ã§Â«Â¯Ã¥Â±ÂÃ§Â¤ÂºÃ£ÂÂ
      const safeBody = body.length > 500 ? body.substring(0, 497) + "..." : body;
      // Ã¨ÂÂ¥Ã¦Â ÂÃ©Â¢ÂÃ¤Â¸ÂºÃ§Â©ÂºÃ¦ÂÂÃ¤Â»Â¥Ã¦ÂÂ°Ã¥Â­ÂÃ¥Â¼ÂÃ¥Â¤Â´Ã¯Â¼ÂÃ¥ÂÂ Ã¤Â¸ÂªÃ¥ÂÂÃ§Â¼ÂÃ¯Â¼ÂÃ¥ÂÂ¯Ã¨ÂÂªÃ¨Â¡ÂÃ¤Â¿Â®Ã¦ÂÂ¹
      let safeTitle = title || "Ã¦ÂÂ¥Ã¨ÂÂªÃ¤Â¼Â´Ã¤Â¾Â£";
      if (/^\d/.test(safeTitle)) safeTitle = "Ã¦ÂÂ¥Ã¨ÂÂªÃ¤Â¼Â´Ã¤Â¾Â£Ã¯Â½Â" + safeTitle;

      const pushResult = await sendPushNotification({ title: safeTitle, body: safeBody });
      if (!pushResult.ok) {
        console.log(`\n${pushResult.providerLabel} Ã¦ÂÂ¨Ã©ÂÂÃ¥Â¤Â±Ã¨Â´Â¥Ã¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¤Â¸ÂÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂ\n`);
        eventContent = `Ã¯Â¼Â${getLocalTimeString()} Ã¨ÂÂªÃ¥ÂÂ¨Ã¥ÂÂ¤Ã©ÂÂÃ¯Â¼ÂÃ¦ÂÂ¬Ã¦Â¬Â¡Ã¦ÂÂªÃ¥ÂÂÃ©ÂÂÃ¦ÂÂ¨Ã©ÂÂÃ¯Â½ÂÃ¥ÂÂÃ¥ÂÂ Ã¯Â¼Â${pushResult.providerLabel} Ã¦ÂÂ¨Ã©ÂÂÃ¥Â¤Â±Ã¨Â´Â¥Ã¯Â¼Â${pushResult.reason}Ã¯Â¼Â`;
      } else {
        eventContent = `Ã¯Â¼Â${getLocalTimeString()} Ã¥ÂÂÃ¥ÂÂÃ§Â»ÂÃ§ÂÂ¨Ã¦ÂÂ·Ã¥ÂÂÃ¤ÂºÂ${pushResult.providerLabel}Ã¦ÂÂ¨Ã©ÂÂÃ¯Â¼Â${safeTitle}Ã¯Â½Â${safeBody}Ã¯Â¼Â`;
      }
    }
  }

  try {
    const eventResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: eventContent })
    });
    if (!eventResponse.ok) {
      throw new Error(`Gateway Ã¨Â¿ÂÃ¥ÂÂ HTTP ${eventResponse.status}`);
    }
    console.log("\nÃ¥Â·Â²Ã©ÂÂÃ¨Â¿Â Gateway Ã¨Â®Â°Ã¥Â½ÂÃ¥ÂÂ¤Ã©ÂÂÃ¤ÂºÂÃ¤Â»Â¶\n");
  } catch (err) {
    console.error("\nÃ¨Â®Â°Ã¥Â½ÂÃ¥ÂÂ¤Ã©ÂÂÃ¤ÂºÂÃ¤Â»Â¶Ã¥Â¤Â±Ã¨Â´Â¥Ã¯Â¼ÂGateway Ã¦ÂÂ¯Ã¥ÂÂ¦Ã¨Â¿ÂÃ¨Â¡ÂÃ¯Â¼ÂÃ¯Â¼Â:\n", err.message);
  }
}

// Ã¤Â»ÂÃ§Â¬Â¬Ã¤Â¸ÂÃ¤Â¸ÂªÃ¦ÂÂÃ¦ÂÂÃ¥ÂÂÃ¦Â ÂÃ¥Â¼ÂÃ¥Â§ÂÃ¯Â¼ÂÃ¦ÂÂÃ¦ÂÂÃ¨Â·Â¯Ã¥Â¾ÂÃ©ÂÂ½Ã¦ÂÂÃ¥ÂÂÃ¥ÂÂÃ¤Â¸ÂÃ¥Â¤ÂÃ£ÂÂÃ¦Â­Â¤Ã©ÂÂÃ¥ÂÂ¼Ã¥Â·Â²Ã©ÂÂÃ¥Â®ÂÃ£ÂÂ
function getCheckIntervalMs() {
  // Ã¦ÂÂ¹Ã¦Â³Â¨ 2026-06-26Ã¯Â¼ÂÃ¥ÂÂ¬Ã¥Â¼ÂÃ§ÂÂÃ¥ÂÂÃ¨Â®Â¸Ã§ÂÂ¨Ã¦ÂÂ·Ã¥ÂÂ¨Ã§Â®Â¡Ã§ÂÂÃ©Â¡ÂµÃ¨Â°ÂÃ¦ÂÂ´Ã¥ÂÂ¤Ã©ÂÂÃ¦Â£ÂÃ¦ÂÂ¥Ã©Â¢ÂÃ§ÂÂÃ¯Â¼ÂÃ©Â»ÂÃ¨Â®Â¤Ã¥ÂÂ¼Ã¤Â¿ÂÃ¦ÂÂÃ¦ÂÂ§Ã§ÂÂÃ§ÂÂ½Ã¥Â¤Â©10Ã¥ÂÂÃ©ÂÂÃ£ÂÂÃ¥Â¤ÂÃ©ÂÂ´2Ã¥Â°ÂÃ¦ÂÂ¶Ã£ÂÂ
  return getCheckIntervalMinutes(new Date()) * 60 * 1000;
}

async function scheduleNextCheck() {
  try {
    // Ã¥ÂÂÃ©ÂÂÃ¥Â¿ÂÃ¨Â·Â³
    try {
      await fetch(HEARTBEAT_URL, { method: "POST" });
    } catch {}
    await runWakeUp();
  } catch (err) {
    console.error("Ã¥ÂÂ¤Ã©ÂÂÃ¦Â£ÂÃ¦ÂÂ¥Ã¥ÂÂºÃ©ÂÂ:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// Ã¦Â½Â®Ã¦Â°Â´Ã¨Â®Â°Ã¥Â¾ÂÃ§Â¬Â¬Ã¤Â¸ÂÃ¦Â¬Â¡Ã¦Â²Â¡Ã¨Â¿ÂÃ§Â¤ÂÃ§ÂÂ³Ã§ÂÂÃ¦ÂÂ¶Ã©ÂÂ´Ã£ÂÂÃ¤Â¹ÂÃ¥ÂÂÃ¦Â¯ÂÃ¤Â¸ÂÃ¦Â¬Â¡Ã¦Â¶Â¨Ã¨ÂÂ½Ã¯Â¼ÂÃ©ÂÂ½Ã¦ÂÂ¯Ã¥ÂÂÃ¤Â¸ÂÃ§ÂÂÃ¦ÂµÂ·Ã¥ÂÂ¨Ã§Â¡Â®Ã¨Â®Â¤Ã¨Â¾Â¹Ã§ÂÂÃ£ÂÂ
// Ã¥ÂÂ¯Ã¥ÂÂ¨Ã§Â¬Â¬Ã¤Â¸ÂÃ¦Â¬Â¡Ã¦Â£ÂÃ¦ÂÂ¥Ã¯Â¼ÂÃ¥Â»Â¶Ã¨Â¿Â10Ã§Â§ÂÃ¯Â¼Â
setTimeout(scheduleNextCheck, 10_000);

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime Ã¥Â·Â²Ã¥ÂÂ¯Ã¥ÂÂ¨Ã¯Â¼ÂÃ¥ÂÂ¨Ã¦ÂÂÃ©ÂÂ´Ã©ÂÂÃ¯Â¼Â");
console.log("==================================\n");
