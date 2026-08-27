const WMO = {
  0:  ['☀️', 'Clear'],
  1:  ['🌤️', 'Mostly Clear'],
  2:  ['⛅', 'Partly Cloudy'],
  3:  ['☁️', 'Overcast'],
  45: ['🌫️', 'Foggy'],
  48: ['🌫️', 'Foggy'],
  51: ['🌦️', 'Light Drizzle'],
  53: ['🌦️', 'Drizzle'],
  55: ['🌧️', 'Heavy Drizzle'],
  61: ['🌧️', 'Light Rain'],
  63: ['🌧️', 'Rain'],
  65: ['🌧️', 'Heavy Rain'],
  71: ['🌨️', 'Light Snow'],
  73: ['🌨️', 'Snow'],
  75: ['❄️', 'Heavy Snow'],
  80: ['🌦️', 'Showers'],
  81: ['🌧️', 'Rain Showers'],
  82: ['🌧️', 'Heavy Showers'],
  95: ['⛈️', 'Thunderstorm'],
  96: ['⛈️', 'Thunderstorm'],
  99: ['⛈️', 'Thunderstorm'],
};

const HOURS_AHEAD = 12;

function formatHour(iso) {
  const h = parseInt(iso.slice(11, 13), 10);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period}`;
}

async function fetchWeather(lat, lon, timezone) {
  const tz  = encodeURIComponent(timezone || 'America/New_York');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weathercode` +
    `&hourly=temperature_2m,weathercode` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=fahrenheit&timezone=${tz}&forecast_days=2`;

  const res  = await fetch(url);
  const json = await res.json();

  const [icon] = WMO[json.current.weathercode] ?? ['🌡️', 'Unknown'];

  const hourlyTimes = json.hourly?.time ?? [];
  const hourlyTemp  = json.hourly?.temperature_2m ?? [];
  const hourlyCode  = json.hourly?.weathercode ?? [];
  const currentHour = json.current.time.slice(0, 13);
  let startIdx = hourlyTimes.findIndex(t => t.slice(0, 13) >= currentHour);
  if (startIdx === -1) startIdx = 0;

  const hours = [];
  for (let i = startIdx; i < Math.min(startIdx + HOURS_AHEAD, hourlyTimes.length); i++) {
    const [hIcon] = WMO[hourlyCode[i]] ?? ['🌡️', 'Unknown'];
    hours.push({
      label: i === startIdx ? 'Now' : formatHour(hourlyTimes[i]),
      temp: Math.round(hourlyTemp[i]),
      icon: hIcon,
    });
  }

  return {
    icon,
    current: Math.round(json.current.temperature_2m),
    high: Math.round(json.daily.temperature_2m_max[0]),
    low: Math.round(json.daily.temperature_2m_min[0]),
    hours,
  };
}

// Reverse-geocodes the actual configured lat/lon into a "City, State" label so
// staff can visually catch a wrong/stale weather_lat/weather_lon on the school
// record (e.g. it was set to a neighboring town) — the forecast temp/high/low
// alone can't reveal that, since nearby towns often read almost identically.
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=12`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const json = await res.json();
  const addr = json.address ?? {};
  const place = addr.city || addr.town || addr.village || addr.hamlet || addr.suburb || addr.county;
  if (!place) return null;
  return addr.state ? `${place}, ${addr.state}` : place;
}

export async function loadWeather(elementId, lat, lon, timezone = 'America/New_York') {
  const el = document.getElementById(elementId);
  if (!el || !lat || !lon) return;

  el.innerHTML = `
    <div class="dash-header-weather-wrap">
      <button type="button" class="dash-header-weather" aria-haspopup="true" aria-expanded="false">
        <span class="dash-header-wx-icon">🌡️</span>
        <span>
          <span class="dash-header-wx-temp">--°</span>
          <span class="dash-header-wx-range">H --° · L --°</span>
        </span>
      </button>
      <div class="dash-header-wx-panel" hidden>
        <div class="dash-header-wx-panel-head">
          <span class="dash-header-wx-location" title="Location this forecast is for — verify it matches your campus">Locating…</span>
          <button type="button" class="dash-header-wx-refresh" aria-label="Refresh weather" title="Refresh">⟳</button>
        </div>
        <div class="dash-header-wx-hourly"></div>
        <div class="dash-header-wx-attribution">Weather data by Open-Meteo</div>
      </div>
    </div>
  `;

  const btn        = el.querySelector('.dash-header-weather');
  const panel      = el.querySelector('.dash-header-wx-panel');
  const refreshBtn = el.querySelector('.dash-header-wx-refresh');
  const iconEl     = el.querySelector('.dash-header-wx-icon');
  const tempEl     = el.querySelector('.dash-header-wx-temp');
  const rangeEl    = el.querySelector('.dash-header-wx-range');
  const hourlyEl   = el.querySelector('.dash-header-wx-hourly');
  const locationEl = el.querySelector('.dash-header-wx-location');

  reverseGeocode(lat, lon)
    .then(label => { locationEl.textContent = label ?? `${lat}, ${lon}`; })
    .catch(() => { locationEl.textContent = `${lat}, ${lon}`; });

  async function refresh() {
    refreshBtn.classList.add('is-loading');
    try {
      const data = await fetchWeather(lat, lon, timezone);
      iconEl.textContent  = data.icon;
      tempEl.textContent  = `${data.current}°`;
      rangeEl.textContent = `H ${data.high}° · L ${data.low}°`;
      hourlyEl.innerHTML  = data.hours.map(h => `
        <div class="dash-header-wx-hour">
          <span class="dash-header-wx-hour-label">${h.label}</span>
          <span class="dash-header-wx-hour-icon">${h.icon}</span>
          <span class="dash-header-wx-hour-temp">${h.temp}°</span>
        </div>
      `).join('');
    } catch {
      // Keep last known good data on failure
    } finally {
      refreshBtn.classList.remove('is-loading');
    }
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const opening = panel.hidden;
    panel.hidden = !opening;
    btn.setAttribute('aria-expanded', String(opening));
  });

  panel.addEventListener('click', e => e.stopPropagation());

  document.addEventListener('click', () => {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  });

  refreshBtn.addEventListener('click', e => {
    e.stopPropagation();
    refresh();
  });

  await refresh();
}
