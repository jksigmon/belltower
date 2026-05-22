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

export async function loadWeather(elementId, lat, lon) {
  const el = document.getElementById(elementId);
  if (!el || !lat || !lon) return;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,weathercode` +
      `&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=1`;

    const res = await fetch(url);
    const json = await res.json();

    const code = json.daily.weathercode[0];
    const high = Math.round(json.daily.temperature_2m_max[0]);
    const low  = Math.round(json.daily.temperature_2m_min[0]);
    const [icon, label] = WMO[code] ?? ['🌡️', 'Unknown'];
    const href = `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`;

    el.innerHTML = `
      <a href="${href}" target="_blank" rel="noopener" class="dash-weather-link">
        <div class="dash-banner-label">Weather</div>
        <div class="dash-weather-main">${icon} ${label}</div>
        <div class="dash-weather-range">H: ${high}° &nbsp; L: ${low}°</div>
      </a>
    `;
  } catch {
    // Silently fail — weather is non-critical
  }
}
