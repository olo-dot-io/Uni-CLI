import { describe, expect, it } from "vitest";
import {
  mapCurrentWeatherRow,
  mapForecastRows,
  pickWeatherDescription,
  requireWttrDays,
} from "./weather.js";

describe("wttr agent-facing weather commands", () => {
  it("validates forecast days", () => {
    expect(requireWttrDays(undefined)).toBe(3);
    expect(requireWttrDays("2")).toBe(2);
    expect(() => requireWttrDays("4")).toThrow("wttr days must");
  });

  it("picks wttr description arrays", () => {
    expect(pickWeatherDescription([{ value: " Sunny " }])).toBe("Sunny");
    expect(pickWeatherDescription([])).toBe("");
  });

  it("maps current weather rows", () => {
    expect(
      mapCurrentWeatherRow(
        {
          nearest_area: [
            {
              areaName: [{ value: "Tokyo" }],
              region: [{ value: "Tokyo" }],
              country: [{ value: "Japan" }],
              latitude: "35.68",
              longitude: "139.76",
            },
          ],
          current_condition: [
            {
              localObsDateTime: "2026-05-12 17:00",
              temp_C: "21",
              temp_F: "70",
              FeelsLikeC: "20",
              weatherDesc: [{ value: "Partly cloudy" }],
              humidity: "55",
              windspeedKmph: "9",
              winddir16Point: "NE",
            },
          ],
        },
        "tokyo",
      ),
    ).toMatchObject({
      location: "Tokyo",
      country: "Japan",
      tempC: 21,
      tempF: 70,
      description: "Partly cloudy",
      humidity: 55,
      windDirection: "NE",
    });
    expect(() => mapCurrentWeatherRow({}, "nowhere")).toThrow("no conditions");
  });

  it("maps forecast rows using noon description and astronomy", () => {
    expect(
      mapForecastRows(
        {
          weather: [
            {
              date: "2026-05-12",
              mintempC: "10",
              maxtempC: "22",
              avgtempC: "16",
              sunHour: "11.5",
              totalSnow_cm: "0",
              uvIndex: "5",
              astronomy: [{ sunrise: "05:00 AM", sunset: "06:30 PM" }],
              hourly: [
                { weatherDesc: [{ value: "Morning" }] },
                {},
                {},
                {},
                { weatherDesc: [{ value: "Clear" }] },
              ],
            },
          ],
        },
        1,
        "tokyo",
      ),
    ).toMatchObject([
      {
        rank: 1,
        date: "2026-05-12",
        minTempC: 10,
        maxTempC: 22,
        description: "Clear",
        sunrise: "05:00 AM",
      },
    ]);
  });
});
