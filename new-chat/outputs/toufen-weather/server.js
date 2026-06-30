const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORT = Number(process.env.PORT || 4173);
const ROOT = path.join(__dirname, "public");
const CWA = "https://www.cwa.gov.tw";
const STATION_ID = "C0E73";
const TOWN_ID = "1000505";

const cache = new Map();

function cacheKey(url) {
  return url.replace(/[?&]T=\d+/, "");
}

async function fetchText(url, ttlMs = 5 * 60 * 1000) {
  const key = cacheKey(url);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.text;

  const res = await fetch(url, {
    headers: {
      "user-agent": "ToufenWeather/1.0 (+local dashboard)",
      "accept-language": "zh-TW,zh;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`CWA fetch failed ${res.status}: ${url}`);
  const text = await res.text();
  cache.set(key, { time: Date.now(), text });
  return text;
}

function stripTags(html) {
  return html
    .replace(/<br[^>]*>/gi, " ")
    .replace(/&le;/g, "<=")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(regex, text, fallback = "-") {
  const match = text.match(regex);
  return match ? stripTags(match[1]) : fallback;
}

function toNumber(value) {
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function extreme(rows, field, mode) {
  const valid = rows
    .map((row) => ({ time: row.time, value: toNumber(row[field]) }))
    .filter((row) => row.value !== null);
  if (!valid.length) return { value: "-", time: "-" };

  return valid.reduce((best, row) => {
    if (mode === "min") return row.value < best.value ? row : best;
    return row.value > best.value ? row : best;
  }, valid[0]);
}

function observationSummary(rows) {
  return {
    maxTemp: extreme(rows, "temp", "max"),
    minTemp: extreme(rows, "temp", "min"),
    maxWind: extreme(rows, "windSpeed", "max"),
    maxGust: extreme(rows, "gust", "max"),
  };
}

function parseStationRows(html) {
  return [...html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)].map((match) => {
    const attrs = match[1];
    const row = match[2];
    const cells = [...row.matchAll(/<(?:th|td)\b([^>]*)>([\s\S]*?)<\/(?:th|td)>/gi)];
    const byHeader = {};
    for (const cell of cells) {
      const header = pick(/headers="([^"]+)"/i, cell[1], "");
      if (header) byHeader[header] = cell[2];
    }
    return {
      time: stripTags(byHeader.time || ""),
      temp: pick(/<span class="tem-C[^"]*">([\s\S]*?)<\/span>/i, byHeader.temp || ""),
      weather: pick(/(?:title|alt)="([^"]+)"/i, byHeader.weather || ""),
      windDirection: pick(/<span class="wind">([\s\S]*?)<\/span>/i, byHeader["w-1"] || ""),
      windSpeed: pick(/<span class="wind_2[^"]*">([\s\S]*?)<\/span>/i, byHeader["w-2"] || ""),
      gust: pick(/<span class="wind_2[^"]*">([\s\S]*?)<\/span>/i, byHeader["w-3"] || ""),
      humidity: stripTags(byHeader.hum || ""),
      rain: stripTags(byHeader.rain || ""),
      stationName: pick(/data-cstname="([^"]+)"/i, attrs, "頭份"),
      countyId: pick(/data-countyid="([^"]+)"/i, attrs, "10005"),
    };
  }).filter((row) => row.time);
}

function parsePlotScript(html) {
  const sandbox = {};
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] || "";
  const trimmed = script.replace(/var TempUnit[\s\S]*$/m, "");
  vm.createContext(sandbox);
  vm.runInContext(trimmed, sandbox, { timeout: 1000 });

  const data = sandbox.Plot_Station_Data || {};
  const times = (data.Time || []).map((ms) => new Date(ms).toISOString());
  return {
    stationId: sandbox.StationID || STATION_ID,
    stationName: sandbox.ST_Name?.C || "頭份",
    timeRange: sandbox.TimeRange || "",
    points: times.map((time, i) => ({
      time,
      temp: data.Temp_Data?.[i]?.C ?? null,
      humidity: data.Humi_Data?.[i] ?? null,
      rain: data.Rain_Data_tmp?.[i]?.[1] ?? null,
    })),
  };
}

function parseForecast(html) {
  const rowNames = {
    PC3_T: "temp",
    PC3_RH: "humidity",
    PC3_Po: "rainChance",
    PC3_BF: "windScale",
    PC3_MS: "windSpeed",
    PC3_WD: "windDirection",
  };
  const rows = {};
  for (const [id, key] of Object.entries(rowNames)) {
    const rowHtml = html.match(new RegExp(`<tr[^>]*>\\s*<th id="${id}"[\\s\\S]*?<\\/tr>`, "i"))?.[0] || "";
    rows[key] = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => {
      if (key === "temp") return pick(/<span class="tem-C[^"]*">([\s\S]*?)<\/span>/i, m[1]);
      if (key === "windScale") return pick(/<span class="wind_1[^"]*">([\s\S]*?)<\/span>/i, m[1], stripTags(m[1]));
      if (key === "windSpeed") return pick(/<span class="wind_2[^"]*">([\s\S]*?)<\/span>/i, m[1], stripTags(m[1]));
      return stripTags(m[1]);
    });
  }

  const dateHeader = html.match(/<thead>[\s\S]*?<tr>([\s\S]*?)<\/tr>/i)?.[1] || "";
  const dayLabels = {};
  for (const m of dateHeader.matchAll(/<th\b[^>]*id="(PC3_D\d+)"[^>]*>([\s\S]*?)<\/th>/gi)) {
    dayLabels[m[1]] = stripTags(m[2]).replace("星期", "週");
  }

  const timeRow = html.match(/<tr class="time"[\s\S]*?<\/tr>/i)?.[0] || "";
  const times = [...timeRow.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)]
    .map((m) => {
      const id = pick(/id="([^"]+)"/i, m[1], "");
      const time = pick(/<span[^>]*>([\s\S]*?)<\/span>/i, m[2], "");
      return {
        id,
        time,
        date: dayLabels[id.match(/^(PC3_D\d+)/)?.[1]] || "",
        is24hr: /is24hr/.test(m[0]),
      };
    })
    .filter((slot) => slot.id !== "PC3_Ti" && slot.time);

  const weatherRow = html.match(/<tr>\s*<th id="PC3_Wx"[\s\S]*?<\/tr>/i)?.[0] || "";
  const weather = [...weatherRow.matchAll(/alt="天氣圖示，([^"]+)"/g)].map((m) => m[1]);

  return times.map((slot, i) => ({
    time: slot.time,
    date: slot.date,
    fullTime: [slot.date, slot.time].filter(Boolean).join(" "),
    is24hr: slot.is24hr,
    temp: rows.temp[i] || "-",
    weather: weather[i] || "-",
    humidity: rows.humidity[i] || "-",
    rainChance: rows.rainChance[i] || "-",
    windDirection: rows.windDirection[i] || "-",
    windScale: rows.windScale[i] || "-",
    windSpeed: rows.windSpeed[i] || "-",
  }));
}

async function apiData() {
  const now = Date.now();
  const [stationHtml, plotHtml, forecastHtml] = await Promise.all([
    fetchText(`${CWA}/V8/C/W/Observe/MOD/24hr/${STATION_ID}.html?T=${now}`),
    fetchText(`${CWA}/V8/C/W/Observe/MOD/24plot/Plot24_${STATION_ID}.html?T=${now}`),
    fetchText(`${CWA}/V8/C/W/Town/MOD/3hr/${TOWN_ID}_3hr_PC.html?T=${now}`),
  ]);
  const observations = parseStationRows(stationHtml);
  return {
    source: {
      station: `${CWA}/V8/C/W/OBS_Station.html?ID=${STATION_ID}`,
      forecast: `${CWA}/V8/C/W/Town/Town.html?TID=${TOWN_ID}`,
    },
    updatedAt: new Date().toISOString(),
    current: observations[0] || null,
    observationSummary: observationSummary(observations),
    observations,
    plot24: parsePlotScript(plotHtml),
    forecast72: parseForecast(forecastHtml),
  };
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
  }[ext] || "application/octet-stream";
  fs.createReadStream(filePath)
    .on("open", () => res.writeHead(200, { "content-type": type }))
    .on("error", () => {
      res.writeHead(404);
      res.end("Not found");
    })
    .pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/api/weather") return sendJson(res, await apiData());

    const safePath = path.normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(ROOT, safePath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    sendFile(res, filePath);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Toufen weather dashboard: http://localhost:${PORT}`);
});
