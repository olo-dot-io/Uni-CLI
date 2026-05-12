/**
 * @owner   src/adapters/wttr/weather.ts
 * @does    Register agent-facing wttr current weather and forecast commands.
 * @needs   wttr.in JSON endpoint, bounded forecast days, explicit empty-result errors.
 * @feeds   surface coverage ledger, weather lookup rows, global public weather coverage.
 * @breaks  wttr.in schema drift, non-JSON unknown-location responses, or silent empty rows hide weather failures.
 */

import { cli, Strategy } from "../../registry.js";

const API_BASE = "https://wttr.in";

function requireLocation(value: unknown): string {
  const location = String(value ?? "").trim();
  if (!location) throw new Error("wttr location cannot be empty.");
  return location;
}

export function requireWttrDays(value: unknown): number {
  const raw = value === undefined || value === null || value === "" ? 3 : value;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 3) {
    throw new Error("wttr days must be an integer in [1, 3].");
  }
  return days;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? n : null;
}

export function pickWeatherDescription(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const first = value[0] as { value?: unknown };
  return typeof first.value === "string" ? first.value.trim() : "";
}

function firstArrayItem(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) && value[0] && typeof value[0] === "object"
    ? (value[0] as Record<string, unknown>)
    : null;
}

export function mapCurrentWeatherRow(
  body: Record<string, unknown>,
  fallbackLocation: string,
): Record<string, unknown> {
  const current = firstArrayItem(body.current_condition);
  if (!current)
    throw new Error(
      `wttr current returned no conditions for "${fallbackLocation}".`,
    );
  const area = firstArrayItem(body.nearest_area);
  return {
    location: pickWeatherDescription(area?.areaName) || fallbackLocation,
    region: pickWeatherDescription(area?.region),
    country: pickWeatherDescription(area?.country),
    latitude: stringField(area?.latitude),
    longitude: stringField(area?.longitude),
    observedAt: stringField(current.localObsDateTime),
    tempC: numberField(current.temp_C),
    tempF: numberField(current.temp_F),
    feelsLikeC: numberField(current.FeelsLikeC),
    feelsLikeF: numberField(current.FeelsLikeF),
    description: pickWeatherDescription(current.weatherDesc),
    humidity: numberField(current.humidity),
    cloudCover: numberField(current.cloudcover),
    pressure: numberField(current.pressure),
    precipMm: numberField(current.precipMM),
    visibilityKm: numberField(current.visibility),
    uvIndex: numberField(current.uvIndex),
    windKmph: numberField(current.windspeedKmph),
    windDirection: stringField(current.winddir16Point),
    windDirectionDegree: numberField(current.winddirDegree),
  };
}

export function mapForecastRows(
  body: Record<string, unknown>,
  days: number,
  fallbackLocation: string,
): Array<Record<string, unknown>> {
  const list = Array.isArray(body.weather)
    ? (body.weather as Array<Record<string, unknown>>)
    : [];
  if (list.length === 0) {
    throw new Error(
      `wttr forecast returned no rows for "${fallbackLocation}".`,
    );
  }
  return list.slice(0, days).map((day, index) => {
    const hourly = Array.isArray(day.hourly)
      ? (day.hourly as Array<Record<string, unknown>>)
      : [];
    const noon = hourly[4] ?? hourly[0] ?? {};
    const astro = firstArrayItem(day.astronomy);
    return {
      rank: index + 1,
      date: stringField(day.date),
      minTempC: numberField(day.mintempC),
      maxTempC: numberField(day.maxtempC),
      avgTempC: numberField(day.avgtempC),
      minTempF: numberField(day.mintempF),
      maxTempF: numberField(day.maxtempF),
      avgTempF: numberField(day.avgtempF),
      sunHour: numberField(day.sunHour),
      totalSnowCm: numberField(day.totalSnow_cm),
      uvIndex: numberField(day.uvIndex),
      description: pickWeatherDescription(noon.weatherDesc),
      sunrise: stringField(astro?.sunrise),
      sunset: stringField(astro?.sunset),
    };
  });
}

async function fetchWeather(
  location: string,
  label: string,
): Promise<Record<string, unknown>> {
  const url = new URL(`${API_BASE}/${encodeURIComponent(location)}`);
  url.searchParams.set("format", "j1");
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "unicli-wttr (https://github.com/olo-dot-io/Uni-CLI)",
    },
  });
  if (response.status === 404) throw new Error(`${label} returned no result.`);
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}.`);
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${label} returned non-JSON weather data for "${location}".`,
    );
  }
}

cli({
  site: "wttr",
  name: "current",
  description: "Current weather conditions for a location",
  domain: "wttr.in",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "location",
      type: "str",
      required: true,
      positional: true,
      description: "City, lat/lon, airport code, or domain location",
    },
  ],
  columns: [
    "location",
    "region",
    "country",
    "latitude",
    "longitude",
    "observedAt",
    "tempC",
    "tempF",
    "feelsLikeC",
    "feelsLikeF",
    "description",
    "humidity",
    "cloudCover",
    "pressure",
    "precipMm",
    "visibilityKm",
    "uvIndex",
    "windKmph",
    "windDirection",
    "windDirectionDegree",
  ],
  func: async (_page, kwargs) => {
    const location = requireLocation(kwargs.location);
    return [
      mapCurrentWeatherRow(
        await fetchWeather(location, "wttr current"),
        location,
      ),
    ];
  },
});

cli({
  site: "wttr",
  name: "forecast",
  description: "Multi-day weather forecast for a location",
  domain: "wttr.in",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "location",
      type: "str",
      required: true,
      positional: true,
      description: "City, lat/lon, airport code, or domain location",
    },
    { name: "days", type: "int", default: 3, description: "Forecast days" },
  ],
  columns: [
    "rank",
    "date",
    "minTempC",
    "maxTempC",
    "avgTempC",
    "minTempF",
    "maxTempF",
    "avgTempF",
    "sunHour",
    "totalSnowCm",
    "uvIndex",
    "description",
    "sunrise",
    "sunset",
  ],
  func: async (_page, kwargs) => {
    const location = requireLocation(kwargs.location);
    const days = requireWttrDays(kwargs.days);
    return mapForecastRows(
      await fetchWeather(location, "wttr forecast"),
      days,
      location,
    );
  },
});
