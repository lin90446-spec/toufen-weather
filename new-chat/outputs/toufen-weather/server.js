const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORT = Number(process.env.PORT || 4173);
const ROOT = path.join(__dirname, "public");
const CWA = "https://www.cwa.gov.tw";
const AIRTW = "https://airtw.moenv.gov.tw";
const STATION_ID = "C0E73";
const TOWN_ID = "1000505";
const AIR_SITE_ID = "72";
const UVI_STATIONS = ["46757", "46728"];

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

function valueFromWindCell(html) {
  const values = stripTags(html).match(/-?\d+(?:\.\d+)?/g) || [];
  return values.length ? Number(values[values.length - 1]) : null;
}

function parseWindSpeed(html) {
  const headerRow = html.match(/<table[^>]*id=StationTable[^>]*>[\s\S]*?<tr>([\s\S]*?)<\/tr>/i)?.[1] || "";
  const slots = [...headerRow.matchAll(/<th\b[^>]*colspan=3[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((m) => stripTags(m[1]))
    .filter((label) => /^\d{2}\/\d{2}/.test(label));

  const dataRow = html.match(/<tbody[^>]*id=StationData[^>]*>\s*<tr[^>]*>([\s\S]*?)<\/tr>/i)?.[1] || "";
  const cells = [...dataRow.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].slice(2);
  const records = [];

  for (let i = 0; i < Math.min(slots.length, Math.floor(cells.length / 3)); i++) {
    const wd = cells[i * 3];
    const wind = cells[i * 3 + 1];
    const gust = cells[i * 3 + 2];
    records.push({
      slotTime: slots[i],
      windDirection: pick(/(?:title|alt)=['"]([^'"]+)['"]/i, wd[2], "-"),
      windSpeed: valueFromWindCell(wind[2]),
      windTime: pick(/title=['"]([^'"]+)['"]/i, wind[1], slots[i]),
      gust: valueFromWindCell(gust[2]),
      gustTime: pick(/title=['"]([^'"]+)['"]/i, gust[1], slots[i]),
    });
  }

  const maxRecord = (field, timeField) => {
    const valid = records.filter((row) => row[field] !== null);
    if (!valid.length) return { value: "-", time: "-" };
    const best = valid.reduce((acc, row) => (row[field] > acc[field] ? row : acc), valid[0]);
    return { value: best[field], time: best[timeField] || best.slotTime };
  };

  const latest = records[0] || null;
  return {
    updatedAt: pick(/var UpdateTime = '([^']+)'/i, html, ""),
    latest: latest ? {
      windDirection: latest.windDirection,
      windSpeed: latest.windSpeed,
      windTime: latest.windTime,
      gust: latest.gust,
      gustTime: latest.gustTime,
    } : null,
    records,
    maxWind: maxRecord("windSpeed", "windTime"),
    maxGust: maxRecord("gust", "gustTime"),
  };
}

function taipeiLatestHour() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), 0));
  if (Number(parts.minute) <= 6) date.setUTCHours(date.getUTCHours() - 1);
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")} ${String(date.getUTCHours()).padStart(2, "0")}:00`;
}

function asObjectList(list) {
  return Object.assign({}, ...list.map((item) => item || {}));
}

async function fetchAirQuality() {
  const queryTime = taipeiLatestHour();
  const params = new URLSearchParams({
    Type: "GetAQInfo",
    Layer: "EPA",
    QueryTime: queryTime,
    Language: "TW",
  });
  const mapText = await fetchText(`${AIRTW}/gis_ajax.aspx?${params}`, 10 * 60 * 1000);
  const sites = JSON.parse(mapText);
  const site = sites.find((item) => item.SiteID === AIR_SITE_ID) || {};

  const detailParams = new URLSearchParams({
    Target: "air_list",
    SiteID: AIR_SITE_ID,
    Datatime: queryTime,
    Type: "",
  });
  const detailText = await fetchText(`${AIRTW}/ajax.aspx?${detailParams}`, 10 * 60 * 1000);
  const detail = detailText.trim().startsWith("[") ? asObjectList(JSON.parse(detailText)) : {};

  return {
    station: detail.sitename || "頭份",
    time: detail.date || queryTime,
    aqi: site.AQI || detail.AQI || "-",
    condition: site.AQI && site.AQI !== "-1" ? aqiLevel(site.AQI) : "有效數據不足",
    pollutant: site.POLLUTANT || detail.POLLUTANT || "",
    pm25: detail.PM25_FIX || "-",
    pm25Avg: detail.AVPM25 || "-",
    pm10: detail.PM10_FIX || "-",
    o3: detail.O3_FIX || "-",
    sourceUpdated: queryTime,
  };
}

function aqiLevel(value) {
  const aqi = toNumber(value);
  if (aqi === null || aqi < 0) return "有效數據不足";
  if (aqi <= 50) return "良好";
  if (aqi <= 100) return "普通";
  if (aqi <= 150) return "對敏感族群不健康";
  if (aqi <= 200) return "對所有族群不健康";
  if (aqi <= 300) return "非常不健康";
  return "危害";
}

function parseUvi(script) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { timeout: 1000 });

  const timeline = sandbox.Timeline || [];
  const stations = {};
  for (const id of UVI_STATIONS) {
    const info = sandbox.Info_UVI_Stations?.[id] || {};
    const values = (sandbox.UVI?.[id] || []).map((point, i) => ({
      hour: timeline[i] || "",
      value: point?.y ?? null,
      color: point?.color || "",
    }));
    const numericValues = values.filter((item) => Number.isFinite(Number(item.value)));
    const latest = [...numericValues].reverse().find((item) => item.value !== null) || null;
    const max = numericValues.reduce((best, item) => (item.value > best.value ? item : best), numericValues[0] || { value: "-", hour: "-" });
    stations[id] = {
      id,
      name: info.Name?.C || id,
      latest,
      max,
      status: info.uvi_status,
    };
  }
  return {
    timeFrom: sandbox.Time_From || "",
    timeTo: sandbox.Time_To || "",
    stations,
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
  const [stationHtml, plotHtml, forecastHtml, windHtml, uviScript, airQuality] = await Promise.all([
    fetchText(`${CWA}/V8/C/W/Observe/MOD/24hr/${STATION_ID}.html?T=${now}`),
    fetchText(`${CWA}/V8/C/W/Observe/MOD/24plot/Plot24_${STATION_ID}.html?T=${now}`),
    fetchText(`${CWA}/V8/C/W/Town/MOD/3hr/${TOWN_ID}_3hr_PC.html?T=${now}`),
    fetchText(`${CWA}/V8/C/W/WindSpeed/MOD/plot/${STATION_ID}.html?T=${now}`),
    fetchText(`${CWA}/Data/js/OBS_UVI_chart.js?T=${now}`, 10 * 60 * 1000),
    fetchAirQuality().catch((error) => ({ error: error.message })),
  ]);
  const observations = parseStationRows(stationHtml);
  const windSpeed = parseWindSpeed(windHtml);
  const current = observations[0] || null;
  if (current && windSpeed.latest) {
    current.windDirection = windSpeed.latest.windDirection || current.windDirection;
    current.windSpeed = windSpeed.latest.windSpeed ?? current.windSpeed;
    current.gust = windSpeed.latest.gust ?? current.gust;
  }
  const summary = observationSummary(observations);
  summary.maxWind = windSpeed.maxWind;
  summary.maxGust = windSpeed.maxGust;
  return {
    source: {
      station: `${CWA}/V8/C/W/OBS_Station.html?ID=${STATION_ID}`,
      forecast: `${CWA}/V8/C/W/Town/Town.html?TID=${TOWN_ID}`,
      windSpeed: `${CWA}/V8/C/W/WindSpeed/WindSpeed_All.html?CID=10005&StationID=${STATION_ID}`,
      airQuality: `${AIRTW}/CHT/EnvMonitoring/Central/CentralMonitoring.aspx`,
      uvi: `${CWA}/V8/C/W/OBS_UVI.html`,
    },
    updatedAt: new Date().toISOString(),
    current,
    observationSummary: summary,
    observations,
    windSpeed,
    airQuality,
    uvi: parseUvi(uviScript),
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
