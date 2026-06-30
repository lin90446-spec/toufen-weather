const $ = (id) => document.getElementById(id);

function fmtTime(iso) {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function setText(id, text) {
  $(id).textContent = text || "--";
}

function numeric(value) {
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function tempClass(value) {
  const n = numeric(value);
  if (n === null) return "";
  if (n >= 35) return "temp-hot-bg";
  if (n >= 30) return "temp-hot";
  if (n >= 25) return "temp-warm";
  if (n >= 20) return "temp-mild";
  if (n >= 15) return "temp-cool";
  if (n >= 10) return "temp-cold";
  return "temp-cold-bg";
}

function windClass(value) {
  const n = numeric(value);
  if (n === null) return "";
  if (n >= 33) return "wind-purple";
  if (n >= 25) return "wind-red";
  if (n >= 15) return "wind-orange";
  if (n >= 10) return "wind-yellow";
  return "";
}

function rainClass(value) {
  const n = numeric(value);
  if (n === null || n < 0.1) return "";
  if (n >= 250) return "rain-purple";
  if (n >= 150) return "rain-red";
  if (n >= 50) return "rain-orange";
  if (n >= 25) return "rain-yellow";
  return "rain-blue";
}

function badge(value, className, suffix = "") {
  const text = `${value || "--"}${value && value !== "-" ? suffix : ""}`;
  return `<span class="metric ${className}">${text}</span>`;
}

function drawLine(svg, points, key, unit, className, color) {
  const valid = points.filter((p) => Number.isFinite(Number(p[key])));
  if (!valid.length) {
    svg.innerHTML = `<text x="24" y="110" class="chart-text">目前無資料</text>`;
    return;
  }

  const width = 680;
  const height = 220;
  const pad = { left: 42, right: 18, top: 20, bottom: 38 };
  const values = valid.map((p) => Number(p[key]));
  const min = Math.floor(Math.min(...values) - 1);
  const max = Math.ceil(Math.max(...values) + 1);
  const range = max - min || 1;
  const x = (i) => pad.left + (i / Math.max(valid.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (v) => pad.top + ((max - v) / range) * (height - pad.top - pad.bottom);
  const d = valid.map((p, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(Number(p[key])).toFixed(1)}`).join(" ");
  const ticks = [min, Math.round((min + max) / 2), max];
  const labels = [valid[0], valid[Math.floor(valid.length / 2)], valid[valid.length - 1]];

  svg.innerHTML = `
    ${ticks.map((t) => `<line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(t)}" y2="${y(t)}"></line><text class="chart-text" x="8" y="${y(t) + 4}">${t}${unit}</text>`).join("")}
    <line class="axis" x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}"></line>
    <path class="${className}" d="${d}"></path>
    ${valid.map((p, i) => `<circle class="dot" cx="${x(i)}" cy="${y(Number(p[key]))}" r="3" stroke="${color}"></circle>`).join("")}
    ${labels.map((p, i) => `<text class="chart-text" x="${[pad.left, width / 2 - 34, width - pad.right - 64][i]}" y="${height - 12}">${fmtTime(p.time)}</text>`).join("")}
  `;
}

function drawBars(svg, points) {
  const valid = points.filter((p) => Number.isFinite(Number(p.rain)));
  if (!valid.length) {
    svg.innerHTML = `<text x="24" y="110" class="chart-text">目前無資料</text>`;
    return;
  }

  const width = 680;
  const height = 220;
  const pad = { left: 42, right: 18, top: 20, bottom: 38 };
  const max = Math.max(1, Math.ceil(Math.max(...valid.map((p) => Number(p.rain)))));
  const plotW = width - pad.left - pad.right;
  const barW = Math.max(3, plotW / valid.length - 3);
  const y = (v) => pad.top + ((max - v) / max) * (height - pad.top - pad.bottom);
  const labels = [valid[0], valid[Math.floor(valid.length / 2)], valid[valid.length - 1]];

  svg.innerHTML = `
    <line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(max)}" y2="${y(max)}"></line>
    <line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(max / 2)}" y2="${y(max / 2)}"></line>
    <line class="axis" x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}"></line>
    <text class="chart-text" x="8" y="${y(max) + 4}">${max}mm</text>
    <text class="chart-text" x="8" y="${y(max / 2) + 4}">${max / 2}mm</text>
    ${valid.map((p, i) => {
      const value = Number(p.rain);
      const x = pad.left + i * (plotW / valid.length);
      const barH = height - pad.bottom - y(value);
      return `<rect class="bar-rain ${rainClass(value)}" x="${x}" y="${y(value)}" width="${barW}" height="${Math.max(1, barH)}"></rect>`;
    }).join("")}
    ${labels.map((p, i) => `<text class="chart-text" x="${[pad.left, width / 2 - 34, width - pad.right - 64][i]}" y="${height - 12}">${fmtTime(p.time)}</text>`).join("")}
  `;
}

function render(data) {
  const current = data.current || {};
  const summary = data.observationSummary || {};
  setText("obsTime", `觀測時間 ${current.time || "--"}`);
  setText("currentTemp", current.temp);
  $("currentTemp").className = tempClass(current.temp);
  setText("currentWeather", current.weather);
  setText("windDirection", current.windDirection);
  setText("windSpeed", current.windSpeed);
  $("windSpeed").className = windClass(current.windSpeed);
  setText("gust", current.gust);
  $("gust").className = windClass(current.gust);
  setText("humidity", current.humidity);
  setText("rain", current.rain);
  $("rain").className = rainClass(current.rain);
  setText("timeRange", data.plot24?.timeRange || "--");
  setText("lastUpdated", `頁面更新 ${fmtTime(data.updatedAt)}`);

  setText("maxTemp", `${summary.maxTemp?.value ?? "--"}°C`);
  $("maxTemp").className = tempClass(summary.maxTemp?.value);
  setText("maxTempTime", `觀測時間 ${summary.maxTemp?.time || "--"}`);
  setText("minTemp", `${summary.minTemp?.value ?? "--"}°C`);
  $("minTemp").className = tempClass(summary.minTemp?.value);
  setText("minTempTime", `觀測時間 ${summary.minTemp?.time || "--"}`);
  setText("maxWind", `${summary.maxWind?.value ?? "--"} m/s`);
  $("maxWind").className = windClass(summary.maxWind?.value);
  setText("maxWindTime", `觀測時間 ${summary.maxWind?.time || "--"}`);
  setText("maxGust", `${summary.maxGust?.value ?? "--"} m/s`);
  $("maxGust").className = windClass(summary.maxGust?.value);
  setText("maxGustTime", `觀測時間 ${summary.maxGust?.time || "--"}`);

  const points = data.plot24?.points || [];
  drawLine($("tempChart"), points, "temp", "°C", "line-temp", "#d47a1f");
  drawLine($("humidityChart"), points, "humidity", "%", "line-humidity", "#256d85");
  drawBars($("rainChart"), points);

  $("forecastBody").innerHTML = (data.forecast72 || []).map((f) => `
    <tr class="${f.is24hr ? "within24" : ""}">
      <td>${f.fullTime || f.time}</td>
      <td>${f.weather}</td>
      <td>${badge(f.temp, tempClass(f.temp), "°C")}</td>
      <td>${f.humidity}</td>
      <td>${f.rainChance}</td>
      <td>${f.windDirection}</td>
      <td>${f.windScale} 級 / ${badge(f.windSpeed, windClass(f.windSpeed), " m/s")}</td>
    </tr>
  `).join("");
}

async function load() {
  $("refresh").disabled = true;
  try {
    const res = await fetch(`/api/weather?t=${Date.now()}`);
    if (!res.ok) throw new Error("讀取資料失敗");
    render(await res.json());
  } catch (error) {
    setText("obsTime", error.message);
  } finally {
    $("refresh").disabled = false;
  }
}

$("refresh").addEventListener("click", load);
load();
