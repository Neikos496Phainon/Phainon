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

// æ¹æ³¨ 2026-07-11ï¼æ¥è®°åªæ¥åæ¨¡åæ¾å¼è¾åºç [DIARY] åï¼é¿åææ®éæ¨éåå®¹è¯¯åè¿æ¬å°æ¥è®°ã
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
    console.log("æ¨¡ååäºæ¥è®°ï¼ä½ DIARY_ENABLED=falseï¼æ¬æ¬¡ä¸ä¿å­");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
  const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
  fs.appendFileSync(diaryFile, entry, "utf-8");
  console.log(`å·²ä¿å­æ¥è®°ï¼${diaryFile}`);
  return true;
}

// æ¹æ³¨ 2026-07-11ï¼æ¨éå±æ©å±ä¸º Bark/ntfyï¼é»è®¤ä»èµ° Barkï¼ä¿æ¤æ§é¨ç½²ä¸æ¹ .env ä¹è½ç»§ç»­è¿è¡ã
async function sendPushNotification({ title, body }) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC æªéç½®" };

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
    return { ok: false, providerLabel: provider || "æªç¥æ¸ é", reason: `ä¸æ¯æç PUSH_PROVIDERï¼${provider}` };
  }

  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key æªéç½®" };
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
        if (part.image_url || type.includes("image")) return "[å¾ç]";
        if (part.file || type.includes("file")) return "[æä»¶]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[å¾ç]";
    if (content.file || type.includes("file")) return "[æä»¶]";
  }

  return "[éææ¬åå®¹]";
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
    0: "æ´æ",
    1: "å¤§è´æ´æ",
    2: "å±é¨å¤äº",
    3: "é´å¤©",
    45: "æé¾",
    48: "é¾å",
    51: "å°æ¯æ¯é¨",
    53: "ä¸­ç­æ¯æ¯é¨",
    55: "è¾å¼ºæ¯æ¯é¨",
    61: "å°é¨",
    63: "ä¸­é¨",
    65: "å¤§é¨",
    71: "å°éª",
    73: "ä¸­éª",
    75: "å¤§éª",
    80: "éµé¨",
    81: "è¾å¼ºéµé¨",
    82: "å¼ºéµé¨",
    95: "é·æ´",
    96: "é·æ´ä¼´å°å°é¹",
    99: "é·æ´ä¼´å¤§å°é¹"
  };
  return table[code] || `å¤©æ°ä»£ç  ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("å·²å¯ç¨ WEATHER_ENABLEDï¼ä½ WEATHER_LAT / WEATHER_LON æªæ­£ç¡®éç½®ï¼è·³è¿å¤©æ°æ³¨å¥");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "å½åä½ç½®";
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
      "## å¤©æ°ä¿¡æ¯",
      `- ä½ç½®ï¼${location}`,
      `- å½åï¼${weatherCodeText(current.weather_code)}ï¼${current.temperature_2m}${unitsInfo.temperature_2m || "Â°C"}ï¼ä½æ ${current.apparent_temperature}${unitsInfo.apparent_temperature || "Â°C"}`,
      `- æ¹¿åº¦ï¼${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- éé¨ï¼${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- é£éï¼${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- æ¥åº/æ¥è½ï¼${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.log("å¤©æ°æ³¨å¥å¤±è´¥ï¼è·³è¿æ¬æ¬¡å¤©æ°ä¿¡æ¯:", err.message);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("æªæ¾å° enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json æ ¼å¼éè¯¯ï¼é¡¶å±ä¸æ¯æ°ç»");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("è¯»å enhanced_messages.json å¤±è´¥:", err.message);
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
  const match = text.match(/ï¼?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:ï¼](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      const content = normalizeContentToText(msg.content);
      // æ¹æ³¨ 2026-07-15ï¼å¼å®¹ Kelivo æ¶é´åç¼ "YYYY-MM-DDHH:mm"ï¼
      // æ§ç "YYYY-MM-DD HH:mm" ä»ç¶å¯ç¨ï¼é¿åæ ç©ºæ ¼æ¶é´å¯¼è´ wake-up è¯¯å¤æ²¡æç¨æ·æ¶é´ã
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
  // ä¼åè¯»åç¬ç«çæç¤ºè¯æä»¶ï¼æ¨èæ¹å¼ï¼
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // å¦ææä»¶ä¸å­å¨ï¼å°è¯ä»ç¯å¢åéè¯»åï¼å¼å®¹æ§éç½®ï¼
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // é»è®¤çæºçæ¬ï¼å¼æºéç¨ï¼ï¼å¯èªè¡ä¿®æ¹æç¤ºè¯
  return `
## æé«ä¼åçº§è§å
1. è¿æ¯ä¸æ¬¡åå°èªå¨å¤éï¼ä¸æ¯ç¨æ·åèµ·çå¯¹è¯ãä½ æ²¡ææ¶å°ä»»ä½æ°æ¶æ¯ã
2. ä½ çå¯ä¸ä»»å¡æ¯å³å®æ¯å¦ä¸»å¨èç³»ç¨æ·ãä¸è½çæå¯¹è¯åå¤ã
3. è¾åºæ ¼å¼å¿é¡»ä¸¥æ ¼éµå®ä»¥ä¸äºéä¸ã

## å¤éä¿¡æ¯
- å½åæ¶é´ï¼${currentTime}
- è·ç¦»ç¨æ·æåä¸æ¡æ¶æ¯ï¼${diffMinutes} åé
${weatherContext ? `\n${weatherContext}\n` : ""}

## è¾åºæ ¼å¼
- å¦ææ³èç³»ç¨æ·ï¼ç´æ¥åä½ æ³è¯´çè¯ãç³»ç»ä¼èªå¨æåæææºæ¨éåéãå¯ä»¥æ¯ä¸å¥è¯ï¼ä¹å¯ä»¥ç¬¬ä¸è¡ä½ä¸ºæ é¢ãç¬¬äºè¡ä½ä¸ºæ­£æã
- å¦æä¸æ³èç³»ï¼åªè¾åºï¼[NO_ACTION]ï¼å¯éå¸¦ç®ç­åå ï¼10å­ä»¥åï¼ã
- å¦æä½ æ³åæ¥è®°ï¼å¯ä»¥é¢å¤è¾åº [DIARY]...[/DIARY]ãåªææ³åæ¶æåï¼ä¸å¿æ¯æ¬¡é½åã
`;
}

async function runWakeUp() {
  console.log("\n==========================");
  console.log("å¼å§èªå¨å¤é");
  console.log("==========================\n");

  const messages = loadTimelineMessages();
  if (!messages) return;

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("æªæ¾å°ç¨æ·æ¶é´");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  if (!shouldWake(lastUserTime)) {
    console.log("\næä¸éè¦å¤é\n");
    return;
  }

  const weatherContext = await fetchWeatherContext();
  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes, weatherContext);
  const cleanMessages = stripPosition(messages);

  const historyText = cleanMessages
    .filter(msg => msg.role !== "system")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("è®°å¿åºä½¿ç¨ç­ç¥");
    })
    .map(msg => {
      const userDisplay = process.env.USER_DISPLAY_NAME || "ç¨æ·";
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
      // æ¹æ³¨ 2026-07-15ï¼Claude/é¨å New API ééå¨ä¼æ system æ½æç¬ç«å­æ®µï¼
      // å¤éè¯·æ±å¦æå¨æ¯ systemï¼ä¸æ¸¸ messages ä¼åç©ºï¼å æ­¤æè¿è®°å½å¿é¡»ä½ä¸º user ä»»å¡è¾å¥åéã
      role: "user",
      content: `ä»¥ä¸æ¯ä½ ä¸ç¨æ·æè¿çèå¤©è®°å½ï¼ä»ä¾åå¿ååèã

è¿äºåå®¹ä¸æ¯æ­£å¨åççå®æ¶å¯¹è¯ã
ç¨æ·å¹¶æ²¡æç»ä½ åæ¶æ¯ã

ä½ ç°å¨å¤äºåå°èªä¸»å¤éç¶æã

æè¿è®°å½ï¼

${historyText}`
    }
  ];

  // æ¹æ³¨ 2026-07-15ï¼wake-up prompt ä¼åå«æè¿èå¤©è®°å½ï¼
  // é»è®¤æ¥å¿åªåæè¦ï¼é¿åå¬å¼é¨ç½²æ¶æå®æ´ä¸ä¸æå·è¿ pm2 æ¥å¿ã
  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("ç¼ºå° TARGET_API_URL / TARGET_API_KEY / MODEL_NAMEï¼è·³è¿æ¬æ¬¡å¤é");
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
    throw new Error(`æ¨¡åè¿åçä¸æ¯ JSONï¼HTTP ${response.status}ï¼ï¼${responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`æ¨¡åè¯·æ±å¤±è´¥ï¼HTTP ${response.status}ï¼ï¼${responseText.slice(0, 300)}`);
  }

  const rawAiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  console.log("\nWake Result Summary:\n");
  console.log(JSON.stringify({ choices: Array.isArray(data.choices) ? data.choices.length : 0, ai_text_chars: rawAiText.length }));

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = appendDiaryEntry(diaryResult.diaryContent);
  const aiText = diaryResult.remainingText;

  let eventContent;

  if (!aiText) {
    console.log("\nAI æªè¿åæ¨éåå®¹ï¼æ¬æ¬¡ä¸åéæ¨é\n");
    eventContent = diarySaved
      ? `ï¼${getLocalTimeString()} èªå¨å¤éï¼æ¬æ¬¡æªåéæ¨éï½åå ï¼åªåæ¥è®°ï¼`
      : `ï¼${getLocalTimeString()} èªå¨å¤éï¼æ¬æ¬¡æªåéæ¨éï½åå ï¼æ¨¡åç©ºåå¤ï¼`;
  // å¤æ­ AI æ¯å¦æç¡®è¦éé»
  } else if (aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/)) {
    const noActionMatch = aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/);
    // AI éæ©ä¸åéæ¨é
    console.log("\nAI éæ©ä¸åéæ¨é\n");
    let reason = (noActionMatch[1] || "").trim();
    if (reason.startsWith("åå ï¼") || reason.startsWith("åå :")) {
      reason = reason.replace(/^åå [ï¼:]\s*/, "").trim();
    }
    eventContent = reason
      ? `ï¼${getLocalTimeString()} èªå¨å¤éï¼æ¬æ¬¡æªåéæ¨éï½åå ï¼${reason}ï¼`
      : `ï¼${getLocalTimeString()} èªå¨å¤éï¼æ¬æ¬¡æªåéæ¨éï¼`;
  } else {
    // æ²¡æ [NO_ACTION] å°±è§ä¸ºæ³åæ¨é
    console.log("\nAI éæ©åéæ¨é\n");
    let barkText = aiText;

    // å¦æ AI è¿æ¯åäº [BARK] ... [/BARK] æ ç­¾ï¼å°±å¥æ
    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }

    // æ¸æ´âæ é¢ï¼âãâæ­£æï¼âåç¼ï¼å¦ææï¼
    barkText = barkText
      .replace(/^æ é¢[ï¼:]\s*/gm, "")
      .replace(/^æ­£æ[ï¼:]\s*/gm, "");

    // æè¡å¤ç
    const lines = barkText.split("\n").filter(line => line.trim() !== "");

    let title, body;
    if (lines.length === 0) {
      console.log("\næ¨éåå®¹æ¸æ´åä¸ºç©ºï¼æ¬æ¬¡ä¸åéæ¨é\n");
      eventContent = `ï¼${getLocalTimeString()} èªå¨å¤éï¼æ¬æ¬¡æªåéæ¨éï½åå ï¼æ¨éåå®¹ä¸ºç©ºï¼`;
    } else if (lines.length === 1) {
      title = "æ¥èªAI";
      body = lines[0].trim();
    } else if (lines.length === 2) {
      title = lines[0].trim();
      body = lines[1].trim();
    } else {
      // â¥3 è¡ï¼ç¬¬ä¸è¡æ é¢ï¼å©ä½ç¨ç©ºæ ¼æ¼æ¥ææ­£æ
      title = lines[0].trim();
      body = lines.slice(1).map(l => l.trim()).join(" ");
    }

    if (!eventContent) {
      // ä¿æ¤ï¼æªæ­è¿é¿æ­£æï¼å¼å®¹ Bark å ntfy çç§»å¨ç«¯å±ç¤ºã
      const safeBody = body.length > 500 ? body.substring(0, 497) + "..." : body;
      // è¥æ é¢ä¸ºç©ºæä»¥æ°å­å¼å¤´ï¼å ä¸ªåç¼ï¼å¯èªè¡ä¿®æ¹
      let safeTitle = title || "æ¥èªä¼´ä¾£";
      if (/^\d/.test(safeTitle)) safeTitle = "æ¥èªä¼´ä¾£ï½" + safeTitle;

      const pushResult = await sendPushNotification({ title: safeTitle, body: safeBody });
      if (!pushResult.ok) {
        console.log(`\n${pushResult.providerLabel} æ¨éå¤±è´¥ï¼æ¬æ¬¡ä¸åéæ¨é\n`);
        eventContent = `ï¼${getLocalTimeString()} èªå¨å¤éï¼æ¬æ¬¡æªåéæ¨éï½åå ï¼${pushResult.providerLabel} æ¨éå¤±è´¥ï¼${pushResult.reason}ï¼`;
      } else {
        eventContent = `ï¼${getLocalTimeString()} ååç»ç¨æ·åäº${pushResult.providerLabel}æ¨éï¼${safeTitle}ï½${safeBody}ï¼`;
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
      throw new Error(`Gateway è¿å HTTP ${eventResponse.status}`);
    }
    console.log("\nå·²éè¿ Gateway è®°å½å¤éäºä»¶\n");
  } catch (err) {
    console.error("\nè®°å½å¤éäºä»¶å¤±è´¥ï¼Gateway æ¯å¦è¿è¡ï¼ï¼:\n", err.message);
  }
}

// ä»ç¬¬ä¸ä¸ªææåæ å¼å§ï¼ææè·¯å¾é½æååä¸å¤ãæ­¤éå¼å·²éå®ã
function getCheckIntervalMs() {
  // æ¹æ³¨ 2026-06-26ï¼å¬å¼çåè®¸ç¨æ·å¨ç®¡çé¡µè°æ´å¤éæ£æ¥é¢çï¼é»è®¤å¼ä¿ææ§çç½å¤©10åéãå¤é´2å°æ¶ã
  return getCheckIntervalMinutes(new Date()) * 60 * 1000;
}

async function scheduleNextCheck() {
  try {
    // åéå¿è·³
    try {
      await fetch(HEARTBEAT_URL, { method: "POST" });
    } catch {}
    await runWakeUp();
  } catch (err) {
    console.error("å¤éæ£æ¥åºé:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// æ½®æ°´è®°å¾ç¬¬ä¸æ¬¡æ²¡è¿ç¤ç³çæ¶é´ãä¹åæ¯ä¸æ¬¡æ¶¨è½ï¼é½æ¯åä¸çæµ·å¨ç¡®è®¤è¾¹çã
// å¯å¨ç¬¬ä¸æ¬¡æ£æ¥ï¼å»¶è¿10ç§ï¼
setTimeout(scheduleNextCheck, 10_000);

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime å·²å¯å¨ï¼å¨æé´éï¼");
console.log("==================================\n");
