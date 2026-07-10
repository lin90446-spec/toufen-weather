const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORT = Number(process.env.PORT || 4173);
const ROOT = path.join(__dirname, "public");
const CWA = "https://www.cwa.gov.tw";
const AIRTW = "https://airtw.moenv.gov.tw";
const WRA = "https://fhy.wra.gov.tw";
const WRA_API_KEY = "d6dd3cd4-493f-43a3-92b1-8b2db217da96";
const STATION_ID = "C0E73";
const PRESSURE_STATION_ID = "46757";
const TOWN_ID = "1000505";
const AIR_SITE_ID = "72";
const RESERVOIR_ID = "10501";
const UVI_STATIONS = ["46757", "46728"];
const TOUFEN_COORD = { lat: 24.7, lon: 120.9 };
const TYPHOON_TARGET_HOURS = new Set([6, 12, 18, 24, 36, 48]);

const cache = new Map();

function cacheKey(url) {
  return url.replace(/[?&]T=\d+/, "");
}

async function fetchText(url, ttlMs = 5 * 60 * 1000, extraHeaders = {}) {
  const key = cacheKey(url);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.text;

  const res = await fetch(url, {
    headers: {
      "user-agent": "ToufenWeather/1.0 (+local dashboard)",
      "accept-language": "zh-TW,zh;q=0.9",
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error(`CWA fetch failed ${res.status}: ${url}`);
  const text = await res.text();
  cache.set(key, { time: Date.now(), text });
  return text;
}

async function fetchJson(url, ttlMs = 5 * 60 * 1000, extraHeaders = {}) {
  return JSON.parse(await fetchText(url, ttlMs, extraHeaders));
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

function toRad(value) {
  return value * Math.PI / 180;
}

function distanceKm(from, to) {
  const earthRadiusKm = 6371;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDegrees(from, to) {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function compassLabel(degrees) {
  const labels = ["北", "北北東", "東北", "東北東", "東", "東南東", "東南", "南南東", "南", "南南西", "西南", "西南西", "西", "西北西", "西北", "北北西"];
  return labels[Math.round(degrees / 22.5) % labels.length];
}

function relationFromToufen(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const target = { lat, lon };
  const bearing = bearingDegrees(TOUFEN_COORD, target);
  return {
    distanceKm: Math.round(distanceKm(TOUFEN_COORD, target)),
    bearing: Math.round(bearing),
    direction: compassLabel(bearing),
  };
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

function pressureSummary(rows) {
  const current = rows[0] || {};
  return {
    stationId: PRESSURE_STATION_ID,
    stationName: current.stationName || "新竹",
    current: {
      value: current.pressure || "-",
      time: current.time || "-",
    },
    maxPressure: extreme(rows, "pressure", "max"),
    minPressure: extreme(rows, "pressure", "min"),
    points: [...rows].reverse().map((row) => ({
      time: row.time,
      displayTime: row.time,
      pressure: toNumber(row.pressure),
    })).filter((row) => row.pressure !== null),
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

async function fetchReservoir() {
  const headers = { apikey: WRA_API_KEY };
  const [stations, realtime] = await Promise.all([
    fetchJson(`${WRA}/Api/v2/Reservoir/Station`, 30 * 60 * 1000, headers),
    fetchJson(`${WRA}/Api/v2/Reservoir/Info/RealTime`, 10 * 60 * 1000, headers),
  ]);
  const station = stations.Data?.find((item) => item.StationNo === RESERVOIR_ID) || {};
  const info = realtime.Data?.find((item) => item.StationNo === RESERVOIR_ID) || {};
  const percent = toNumber(info.PercentageOfStorage);

  return {
    station: station.StationName || "永和山水庫",
    time: info.Time || "",
    percentage: percent === null ? "-" : Math.round(percent * 10) / 10,
    waterHeight: info.WaterHeight ?? "-",
    effectiveStorage: info.EffectiveStorage ?? "-",
    effectiveCapacity: info.EffectiveCapacity ?? station.EffectiveCapacity ?? "-",
    sourceUpdated: realtime.UpdataTime || "",
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
      pressure: stripTags(byHeader.pre || ""),
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
  const points = times.map((time, i) => ({
    time,
    temp: data.Temp_Data?.[i]?.C ?? null,
    humidity: data.Humi_Data?.[i] ?? null,
    rain: data.Rain_Data_tmp?.[i]?.[1] ?? null,
  }));
  const rain24Total = points.reduce((total, point) => total + (Number(point.rain) || 0), 0);
  return {
    stationId: sandbox.StationID || STATION_ID,
    stationName: sandbox.ST_Name?.C || "頭份",
    timeRange: sandbox.TimeRange || "",
    rain24Total: Math.round(rain24Total * 10) / 10,
    points,
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

function listItems(html) {
  return [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1]));
}

function parsePosition(text) {
  const match = text.match(/北緯\s*([\d.]+)\s*度，東經\s*([\d.]+)\s*度/);
  if (!match) return { lat: null, lon: null };
  return { lat: Number(match[1]), lon: Number(match[2]) };
}

function parseRadius(text, level) {
  const match = text.match(new RegExp(`${level}級風(?:平均)?暴風半徑\\s*([\\d.]+)\\s*公里`));
  if (!match) return null;
  const start = match.index || 0;
  const next = text.slice(start + 1).search(/[七十]級風(?:平均)?暴風半徑/);
  const segment = next >= 0 ? text.slice(start, start + 1 + next) : text.slice(start);
  const quadrants = {};
  for (const q of ["西北", "東北", "西南", "東南"]) {
    const qMatch = segment.match(new RegExp(`${q}側\\s*([\\d.]+)\\s*公里`));
    if (qMatch) quadrants[q] = Number(qMatch[1]);
  }
  return {
    averageKm: Number(match[1]),
    quadrants,
  };
}

function parseTyphoonMetrics(items) {
  const joined = items.join(" ");
  const position = parsePosition(joined);
  const pressure = joined.match(/中心氣壓[：:]?\s*([\d.]+)\s*百帕/);
  const maxWind = joined.match(/近中心最大風速[：:]?\s*(?:近中心最大風速)?每秒\s*([\d.]+)\s*公尺/);
  const gust = joined.match(/瞬間(?:之)?最大陣風[：:]?\s*(?:瞬間最大陣風)?每秒\s*([\d.]+)\s*公尺/);
  return {
    lat: position.lat,
    lon: position.lon,
    pressure: pressure ? Number(pressure[1]) : null,
    maxWind: maxWind ? Number(maxWind[1]) : null,
    gust: gust ? Number(gust[1]) : null,
    radius7: parseRadius(joined, "七"),
    radius10: parseRadius(joined, "十"),
    relation: relationFromToufen(position.lat, position.lon),
  };
}

function parseWarningCurrent(body) {
  const items = listItems(body);
  const metrics = parseTyphoonMetrics(items);
  const positionText = items.find((item) => item.startsWith("中心位置")) || "";
  const movementText = items.find((item) => item.startsWith("前進方向")) || "";
  const movement = movementText.match(/每小時\s*([\d.]+)\s*公里速度，向(.+?)進行/);
  return {
    time: positionText.match(/(\d+日\d+時)/)?.[1] || "",
    movementDirection: movement ? movement[2] : "",
    movementSpeedKmh: movement ? Number(movement[1]) : null,
    ...metrics,
  };
}

function parseWarningForecasts(html, year) {
  const forecasts = [];
  for (const match of html.matchAll(/<a[^>]*>(預測[\s\S]*?小時[\s\S]*?)<\/a>[\s\S]*?<div class="panel-body">\s*<p>([\s\S]*?)<\/p>/gi)) {
    const period = stripTags(match[1]);
    const hourMatch = period.match(/(\d+)(?:-(\d+))?\s*小時/);
    const hour = hourMatch ? Number(hourMatch[2] || hourMatch[1]) : null;
    if (!TYPHOON_TARGET_HOURS.has(hour)) continue;
    const text = stripTags(match[2]);
    const movement = text.match(/^(\S+)\s+時速\s*([\d.]+)\s*公里/);
    const timeText = text.match(/預測\s*(\d{2}月\d{2}日\d{2}時)/)?.[1] || "";
    const probability = text.match(/70%機率半徑\s*([\d.]+)\s*公里/);
    forecasts.push({
      hour,
      period,
      time: timeText ? `${year}年${timeText}` : "",
      movementDirection: movement ? movement[1] : "",
      movementSpeedKmh: movement ? Number(movement[2]) : null,
      probability70Km: probability ? Number(probability[1]) : null,
      ...parseTyphoonMetrics([text]),
    });
  }
  return forecasts;
}

function parseTyphoonWarningScript(script) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { timeout: 1000 });
  if (!sandbox.TY_WARN_LIST?.C?.length || sandbox.TY_WARN_Lv?.ID === "END") return null;

  const year = String(sandbox.File_Time || "").slice(0, 4) || new Date().getFullYear().toString();
  const forecasts = parseWarningForecasts(sandbox.TED_PTA?.C || "", year);
  const typhoons = sandbox.TY_WARN_LIST.C.map((item) => {
    const body = item.TabBody || "";
    const title = stripTags(body.match(/<h3>([\s\S]*?)<\/h3>/i)?.[1] || item.TabName || "");
    const issuedTime = stripTags(body.match(/<p>發布時間：([\s\S]*?)<\/p>/i)?.[1] || "");
    const report = stripTags(body.match(/<span class="gray-bar">([\s\S]*?)<\/span>/i)?.[1] || "");
    const name = title.match(/(?:熱帶性低氣壓|輕度颱風|中度颱風|強烈颱風)\s*([^（\s]+)/)?.[1] || item.TabName?.replace(/^(熱帶性低氣壓|輕度颱風|中度颱風|強烈颱風)\s*/, "") || "";
    return {
      id: sandbox.PTA_TYPHOON || item.ID || "",
      nameZh: name,
      nameEn: title.match(/國際命名\s*([A-Z0-9-]+)/)?.[1] || sandbox.PTA_TYPHOON || "",
      intensity: title.match(/(熱帶性低氣壓|輕度颱風|中度颱風|強烈颱風)/)?.[1] || "",
      number: report.match(/編號第\s*([^\s號]+)\s*號/)?.[1] || "",
      report,
      issuedTime,
      current: parseWarningCurrent(body),
      forecasts,
    };
  }).filter((item) => item.current.lat !== null);

  return {
    source: `${CWA}/V8/C/P/Typhoon/TY_WARN.html`,
    dataSource: "颱風警報單",
    updatedAt: new Date().toISOString(),
    cwaUpdatedAt: (script.match(/\/\/ Update:\s*([^\n]+)/)?.[1] || "").trim(),
    dataTime: sandbox.File_Time || "",
    displayTime: typhoons[0]?.issuedTime ? `發布時間 ${typhoons[0].issuedTime}` : "",
    warningLevel: sandbox.TY_WARN_Lv?.C || "",
    warningArea: sandbox.WarningArea || {},
    movement: sandbox.Movement || "",
    nextIssueTime: sandbox.NoteText?.find((item) => item.includes("下次警報")) || "",
    count: {
      tropicalDepression: 0,
      typhoon: typhoons.length,
    },
    referencePoint: {
      name: "頭份",
      ...TOUFEN_COORD,
    },
    typhoons,
  };
}

function parseTyphoonPanel(panel, typhoonNames, year) {
  const heading = stripTags(panel.match(/<div class="panel-heading">([\s\S]*?)<\/div>\s*<div/i)?.[1] || "");
  const id = Object.keys(typhoonNames).find((key) => heading.includes(key) || heading.includes(typhoonNames[key]?.Name?.C || "")) || "";
  const name = typhoonNames[id]?.Name || {};
  const intensity = heading.match(/(熱帶性低氣壓|輕度颱風|中度颱風|強烈颱風)/)?.[1] || "";
  const number = heading.match(/編號第\s*([^\s]+)\s*號/)?.[1] || "";
  const now = panel.match(/<span class="now">[\s\S]*?<\/span>\s*<p>([\s\S]*?)<\/p>\s*<ul[^>]*>([\s\S]*?)<\/ul>/i);
  const currentItems = now ? listItems(now[2]) : [];
  const current = {
    time: now ? stripTags(now[1]) : "",
    movementDirection: currentItems.find((item) => item.startsWith("過去移動方向"))?.replace("過去移動方向", "").trim() || "",
    movementSpeedKmh: toNumber(currentItems.find((item) => item.startsWith("過去移動時速"))),
    ...parseTyphoonMetrics(currentItems),
  };

  const forecasts = [];
  for (const match of panel.matchAll(/<p>(預測[\s\S]*?小時[\s\S]*?)<\/p>\s*<ul[^>]*>([\s\S]*?)<\/ul>/gi)) {
    const period = stripTags(match[1]);
    const hourMatch = period.match(/(\d+)(?:-(\d+))?\s*小時/);
    const hour = hourMatch ? Number(hourMatch[2] || hourMatch[1]) : null;
    if (!TYPHOON_TARGET_HOURS.has(hour)) continue;
    const items = listItems(match[2]);
    const timeText = items.find((item) => item.startsWith("預測 "))?.replace("預測 ", "").trim() || "";
    const movement = items[0]?.match(/^(\S+)\s+時速\s*([\d.]+)\s*公里/) || null;
    const probability = items.find((item) => item.includes("70%機率半徑"))?.match(/70%機率半徑\s*([\d.]+)\s*公里/);
    forecasts.push({
      hour,
      period,
      time: timeText ? `${year}年${timeText}` : "",
      movementDirection: movement ? movement[1] : "",
      movementSpeedKmh: movement ? Number(movement[2]) : null,
      probability70Km: probability ? Number(probability[1]) : null,
      ...parseTyphoonMetrics(items),
    });
  }

  return {
    id,
    nameZh: name.C || "",
    nameEn: name.E || id,
    intensity,
    number,
    current,
    forecasts,
  };
}

function parseTyphoonScript(script) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { timeout: 1000 });
  const year = String(sandbox.TY_DataTime || "").slice(0, 4) || new Date().getFullYear().toString();
  const html = sandbox.TY_LIST_2?.C || "";
  const panels = html.split('<div class="panel panel-default">').slice(1).map((part) => `<div class="panel panel-default">${part}`);
  return {
    source: `${CWA}/V8/C/P/Typhoon/TY_NEWS.html`,
    updatedAt: new Date().toISOString(),
    cwaUpdatedAt: (script.match(/\/\/ Update:\s*([^\n]+)/)?.[1] || "").trim(),
    dataTime: sandbox.TY_DataTime || "",
    displayTime: sandbox.TY_TIME?.C || "",
    count: {
      tropicalDepression: sandbox.TY_COUNT?.[0] || 0,
      typhoon: sandbox.TY_COUNT?.[1] || 0,
    },
    referencePoint: {
      name: "頭份",
      ...TOUFEN_COORD,
    },
    typhoons: panels.map((panel) => parseTyphoonPanel(panel, sandbox.TYPHOON || {}, year)).filter((item) => item.current.lat !== null),
  };
}

async function typhoonData() {
  const now = Date.now();
  const [warningScript, newsScript] = await Promise.all([
    fetchText(`${CWA}/Data/js/typhoon/TY_WARN-Data.js?T=${now}`, 10 * 60 * 1000).catch(() => ""),
    fetchText(`${CWA}/Data/js/typhoon/TY_NEWS-Data.js?T=${now}`, 10 * 60 * 1000),
  ]);
  const warning = warningScript ? parseTyphoonWarningScript(warningScript) : null;
  if (warning?.typhoons?.length) return warning;
  return {
    dataSource: "颱風消息",
    ...parseTyphoonScript(newsScript),
  };
}

async function apiData() {
  const now = Date.now();
  const [stationHtml, pressureHtml, plotHtml, forecastHtml, windHtml, uviScript, airQuality, reservoir] = await Promise.all([
    fetchText(`${CWA}/V8/C/W/Observe/MOD/24hr/${STATION_ID}.html?T=${now}`),
    fetchText(`${CWA}/V8/C/W/Observe/MOD/24hr/${PRESSURE_STATION_ID}.html?T=${now}`),
    fetchText(`${CWA}/V8/C/W/Observe/MOD/24plot/Plot24_${STATION_ID}.html?T=${now}`),
    fetchText(`${CWA}/V8/C/W/Town/MOD/3hr/${TOWN_ID}_3hr_PC.html?T=${now}`),
    fetchText(`${CWA}/V8/C/W/WindSpeed/MOD/plot/${STATION_ID}.html?T=${now}`),
    fetchText(`${CWA}/Data/js/OBS_UVI_chart.js?T=${now}`, 10 * 60 * 1000),
    fetchAirQuality().catch((error) => ({ error: error.message })),
    fetchReservoir().catch((error) => ({ error: error.message })),
  ]);
  const observations = parseStationRows(stationHtml);
  const pressureRows = parseStationRows(pressureHtml);
  const windSpeed = parseWindSpeed(windHtml);
  const current = observations[0] || null;
  if (current && windSpeed.latest) {
    current.windDirection = windSpeed.latest.windDirection || current.windDirection;
    current.windDirectionTime = windSpeed.latest.slotTime || current.time;
    current.windSpeed = windSpeed.latest.windSpeed ?? current.windSpeed;
    current.windTime = windSpeed.latest.windTime || current.time;
    current.gust = windSpeed.latest.gust ?? current.gust;
    current.gustTime = windSpeed.latest.gustTime || current.time;
  }
  if (current) current.humidityTime = current.time;
  const summary = observationSummary(observations);
  summary.maxWind = windSpeed.maxWind;
  summary.maxGust = windSpeed.maxGust;
  const plot24 = parsePlotScript(plotHtml);
  if (current) current.rain24 = plot24.rain24Total;
  return {
    source: {
      station: `${CWA}/V8/C/W/OBS_Station.html?ID=${STATION_ID}`,
      pressure: `${CWA}/V8/C/W/OBS_Station.html?ID=${PRESSURE_STATION_ID}`,
      forecast: `${CWA}/V8/C/W/Town/Town.html?TID=${TOWN_ID}`,
      windSpeed: `${CWA}/V8/C/W/WindSpeed/WindSpeed_All.html?CID=10005&StationID=${STATION_ID}`,
      airQuality: `${AIRTW}/CHT/EnvMonitoring/Central/CentralMonitoring.aspx`,
      uvi: `${CWA}/V8/C/W/OBS_UVI.html`,
      reservoir: `${WRA}/fhyv2/monitor/reservoir`,
    },
    updatedAt: new Date().toISOString(),
    current,
    observationSummary: summary,
    pressure: pressureSummary(pressureRows),
    observations,
    windSpeed,
    airQuality,
    reservoir,
    uvi: parseUvi(uviScript),
    plot24,
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
    if (url.pathname === "/api/typhoon") return sendJson(res, await typhoonData());

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
