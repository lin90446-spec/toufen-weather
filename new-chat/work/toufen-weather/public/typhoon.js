const TYPHOON_REFRESH_MS = 60 * 60 * 1000;
let typhoonLoading = false;

const byId = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function fmtTime(iso) {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function metric(value, unit = "") {
  return value === null || value === undefined || value === "" ? "--" : `${value}${unit}`;
}

function positionText(item) {
  if (item?.lat === null || item?.lon === null) return "--";
  return `${Number(item.lat).toFixed(1)}N, ${Number(item.lon).toFixed(1)}E`;
}

function relationText(item) {
  const relation = item?.relation;
  if (!relation) return "--";
  const inside = isInStormRadius(item);
  return `
    <span class="${inside ? "storm-inside" : ""}">
      ${relation.direction}方 ${relation.distanceKm} km${inside ? "（暴風圈內）" : ""}
    </span>
  `;
}

function radiusText(radius) {
  if (!radius) return "--";
  const parts = Object.entries(radius.quadrants || {}).map(([key, value]) => `${key}${value}`);
  return `${radius.averageKm} km${parts.length ? ` (${parts.join(" / ")})` : ""}`;
}

function isInStormRadius(item) {
  const distance = Number(item?.relation?.distanceKm);
  const radius = Number(item?.radius7?.averageKm);
  return Number.isFinite(distance) && Number.isFinite(radius) && distance <= radius;
}

function typhoonPathSvg(typhoon, referencePoint) {
  const points = [
    { label: "頭份", lat: referencePoint.lat, lon: referencePoint.lon, type: "home" },
    { label: "現況", lat: typhoon.current.lat, lon: typhoon.current.lon, type: "current" },
    ...typhoon.forecasts.map((item) => ({
      label: `${item.hour}h`,
      lat: item.lat,
      lon: item.lon,
      type: "forecast",
    })),
  ].filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon));

  if (points.length < 2) return "";

  const width = 680;
  const height = 300;
  const pad = 34;
  const lats = points.map((item) => item.lat);
  const lons = points.map((item) => item.lon);
  const minLat = Math.min(...lats) - 0.8;
  const maxLat = Math.max(...lats) + 0.8;
  const minLon = Math.min(...lons) - 0.8;
  const maxLon = Math.max(...lons) + 0.8;
  const x = (lon) => pad + ((lon - minLon) / (maxLon - minLon || 1)) * (width - pad * 2);
  const y = (lat) => pad + ((maxLat - lat) / (maxLat - minLat || 1)) * (height - pad * 2);
  const track = points.filter((item) => item.type !== "home");
  const d = track.map((item, i) => `${i ? "L" : "M"} ${x(item.lon).toFixed(1)} ${y(item.lat).toFixed(1)}`).join(" ");

  return `
    <svg class="typhoon-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="颱風相對頭份位置">
      <line class="grid" x1="${pad}" x2="${width - pad}" y1="${height / 2}" y2="${height / 2}"></line>
      <line class="grid" x1="${width / 2}" x2="${width / 2}" y1="${pad}" y2="${height - pad}"></line>
      <path class="line-typhoon" d="${d}"></path>
      ${points.map((item) => `
        <circle class="typhoon-dot ${item.type}" cx="${x(item.lon)}" cy="${y(item.lat)}" r="${item.type === "home" ? 6 : 5}"></circle>
        <text class="chart-text" x="${x(item.lon) + 8}" y="${y(item.lat) - 8}">${escapeHtml(item.label)}</text>
      `).join("")}
    </svg>
  `;
}

function forecastRows(forecasts) {
  return forecasts.map((item) => `
    <tr>
      <td>${item.hour} 小時</td>
      <td>${escapeHtml(item.time)}</td>
      <td>${positionText(item)}</td>
      <td>${relationText(item)}</td>
      <td>${metric(item.pressure, " hPa")}</td>
      <td>${metric(item.maxWind, " m/s")}</td>
      <td>${radiusText(item.radius7)}</td>
      <td>${metric(item.probability70Km, " km")}</td>
    </tr>
  `).join("");
}

function typhoonCard(typhoon, referencePoint) {
  return `
    <article class="typhoon-card">
      <div class="typhoon-title">
        <div>
          <span class="label">${escapeHtml(typhoon.intensity || "熱帶系統")}</span>
          <h2>${escapeHtml(typhoon.nameZh || typhoon.nameEn)} <small>${escapeHtml(typhoon.nameEn || "")}</small></h2>
        </div>
        <strong>${relationText(typhoon.current)}</strong>
      </div>
      <div class="typhoon-grid">
        <section>
          <span class="label">目前位置</span>
          <strong>${positionText(typhoon.current)}</strong>
          <small>${escapeHtml(typhoon.current.time || "--")}</small>
        </section>
        <section>
          <span class="label">中心氣壓</span>
          <strong>${metric(typhoon.current.pressure, " hPa")}</strong>
          <small>目前分析</small>
        </section>
        <section>
          <span class="label">中心最大風速</span>
          <strong>${metric(typhoon.current.maxWind, " m/s")}</strong>
          <small>陣風 ${metric(typhoon.current.gust, " m/s")}</small>
        </section>
        <section>
          <span class="label">七級暴風半徑</span>
          <strong>${radiusText(typhoon.current.radius7)}</strong>
          <small>十級 ${radiusText(typhoon.current.radius10)}</small>
        </section>
      </div>
      ${typhoon.report || typhoon.issuedTime ? `<p class="typhoon-note">${escapeHtml([typhoon.report, typhoon.issuedTime ? `發布時間 ${typhoon.issuedTime}` : ""].filter(Boolean).join(" / "))}</p>` : ""}
      ${typhoonPathSvg(typhoon, referencePoint)}
      <div class="forecast-wrap">
        <table>
          <thead>
            <tr>
              <th>預測</th>
              <th>時間</th>
              <th>位置</th>
              <th>離頭份</th>
              <th>氣壓</th>
              <th>最大風速</th>
              <th>七級暴風半徑</th>
              <th>70%機率半徑</th>
            </tr>
          </thead>
          <tbody>${forecastRows(typhoon.forecasts)}</tbody>
        </table>
      </div>
    </article>
  `;
}

function renderTyphoon(data) {
  byId("typhoonUpdated").textContent = [data.dataSource || "CWA", data.displayTime || "", data.nextIssueTime || ""].filter(Boolean).join(" / ") || "--";
  byId("typhoonLastUpdated").textContent = `頁面更新 ${fmtTime(data.updatedAt)}`;

  if (!data.typhoons?.length) {
    byId("typhoonContent").innerHTML = `<p class="empty-state">目前中央氣象署未提供颱風或熱帶性低氣壓資料。</p>`;
    return;
  }

  byId("typhoonContent").innerHTML = data.typhoons.map((item) => typhoonCard(item, data.referencePoint)).join("");
}

async function loadTyphoon() {
  if (typhoonLoading) return;
  typhoonLoading = true;
  byId("refreshTyphoon").disabled = true;
  try {
    const apiBase = window.location.protocol === "file:" ? "http://localhost:4174/api/typhoon" : "/api/typhoon";
    const res = await fetch(`${apiBase}?t=${Date.now()}`);
    if (!res.ok) throw new Error("讀取資料失敗");
    renderTyphoon(await res.json());
  } catch (error) {
    byId("typhoonContent").innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  } finally {
    byId("refreshTyphoon").disabled = false;
    typhoonLoading = false;
  }
}

byId("refreshTyphoon").addEventListener("click", loadTyphoon);
loadTyphoon();
setInterval(loadTyphoon, TYPHOON_REFRESH_MS);
