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

export async function loadWeather(elementId, lat, lon, timezone = 'America/New_York') {
  const el = document.getElementById(elementId);
  if (!el || !lat || !lon) return;

  try {
    const tz  = encodeURIComponent(timezone || 'America/New_York');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weathercode` +
      `&daily=temperature_2m_max,temperature_2m_min` +
      `&temperature_unit=fahrenheit&timezone=${tz}&forecast_days=1`;

    const res = await fetch(url);
    const json = await res.json();

    const code    = json.current.weathercode;
    const current = Math.round(json.current.temperature_2m);
    const high    = Math.round(json.daily.temperature_2m_max[0]);
    const low     = Math.round(json.daily.temperature_2m_min[0]);
    const [icon]  = WMO[code] ?? ['🌡️', 'Unknown'];
    const href    = `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`;

    el.innerHTML = `
      <a href="${href}" target="_blank" rel="noopener" class="dash-header-weather">
        <span class="dash-header-wx-icon">${icon}</span>
        <span>
          <span class="dash-header-wx-temp">${current}°</span>
          <span class="dash-header-wx-range">H ${high}° · L ${low}°</span>
        </span>
      </a>
    `;
  } catch {
    // Silently fail — weather is non-critical
  }
}
