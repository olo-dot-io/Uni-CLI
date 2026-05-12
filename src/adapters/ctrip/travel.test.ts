import { describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  CTRIP_SUGGEST_COLUMNS,
  assertCtripCheckinBeforeCheckout,
  buildCtripFlightExtractScript,
  buildCtripFlightWaitScript,
  buildCtripHotelWaitScript,
  buildCtripSuggestUrl,
  mapCtripHotelRow,
  mapCtripSuggestRow,
  parseCtripCityId,
  parseCtripIataCode,
  parseCtripIsoDate,
  parseCtripLimit,
  pickCtripCoords,
  pickCtripHotelMapCoords,
} from "./travel.js";

function ok(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function pageMock(evaluateResults: unknown[]) {
  const queue = [...evaluateResults];
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => queue.shift()),
  };
}

const shanghaiCity = {
  id: "2",
  type: "City",
  word: "上海",
  cityId: 2,
  cityName: "上海",
  provinceName: "上海",
  countryName: "中国",
  displayName: "上海, 中国",
  displayType: "城市",
  eName: "Shanghai",
  gdLat: 31.2304,
  gdLon: 121.4737,
};

const landmark = {
  id: "4189051",
  type: "Markland",
  cityId: 1,
  cityName: "北京",
  provinceName: "北京",
  countryName: "中国",
  displayName: "故宫博物院, 北京, 中国",
  displayType: "地标",
  eName: "The Palace Museum",
  commentScore: 4.8,
  gdLat: 39.9177,
  gdLon: 116.397,
};

const hotelSuggestRow = {
  id: "133133582",
  type: "Hotel",
  word: "汉庭酒店上海陆家嘴店",
  cityId: 2,
  cityName: "上海",
  provinceName: "上海",
  countryName: "中国",
  displayName: "汉庭酒店上海陆家嘴店, 上海, 中国",
  displayType: "酒店",
  cStar: 4.2,
};

const hotelEntry = {
  hotelInfo: {
    summary: { hotelId: "106876528" },
    nameInfo: {
      name: "上海外滩滨江珍宝酒店",
      enName: "Shanghai Bund Riverside Treasury Hotel",
    },
    hotelStar: { star: 4 },
    commentInfo: {
      commentScore: "4.7",
      commentDescription: "超棒",
      commenterNumber: "13,966条点评",
    },
    positionInfo: {
      cityName: "上海",
      positionDesc: "北外滩地区 · 近北外滩来福士",
      address: "东大名路988号",
      mapCoordinate: [
        { coordinateType: 3, latitude: "31.25", longitude: "121.51" },
        { coordinateType: 1, latitude: "31.23", longitude: "121.47" },
      ],
    },
  },
  roomInfo: [{ priceInfo: { price: 548, currency: "RMB" } }],
};

const flightRow = {
  airline: "厦门航空",
  flightNo: "MF8561",
  aircraft: "空客321(中)",
  departureTime: "07:50",
  departureAirport: "大兴国际机场",
  arrivalTime: "09:45",
  arrivalAirport: "浦东国际机场",
  terminal: "T2",
  price: 487,
  currency: "¥",
  cabin: "经济舱",
};

describe("ctrip agent-facing travel commands", () => {
  it("validates limits, dates, IATA codes, and city ids", () => {
    expect(parseCtripLimit(undefined)).toBe(15);
    expect(parseCtripLimit("50")).toBe(50);
    expect(() => parseCtripLimit(0)).toThrow("between 1 and 50");
    expect(() => parseCtripLimit("abc")).toThrow("integer");
    expect(parseCtripIsoDate("checkin", "2026-06-15")).toBe("2026-06-15");
    expect(() => parseCtripIsoDate("checkin", "2026-02-30")).toThrow(
      "not a real calendar date",
    );
    expect(parseCtripIataCode("from", " sha ")).toBe("SHA");
    expect(() => parseCtripIataCode("from", "SH")).toThrow("3-letter IATA");
    expect(parseCtripCityId("2")).toBe(2);
    expect(() => parseCtripCityId("shanghai")).toThrow("positive integer");
    expect(() =>
      assertCtripCheckinBeforeCheckout("2026-06-17", "2026-06-15"),
    ).toThrow("must be earlier");
  });

  it("maps suggestion rows without dropping geo or URL metadata", () => {
    expect(pickCtripCoords(shanghaiCity)).toEqual({
      lat: 31.2304,
      lon: 121.4737,
    });
    expect(buildCtripSuggestUrl(landmark)).toBe(
      "https://you.ctrip.com/sight/%E5%8C%97%E4%BA%AC1/4189051.html",
    );
    expect(buildCtripSuggestUrl(hotelSuggestRow)).toBe(
      "https://hotels.ctrip.com/hotels/detail/?hotelid=133133582",
    );
    const row = mapCtripSuggestRow(landmark, 0);
    expect(row).toEqual({
      rank: 1,
      id: "4189051",
      type: "Markland",
      displayType: "地标",
      name: "故宫博物院, 北京, 中国",
      eName: "The Palace Museum",
      cityId: 1,
      cityName: "北京",
      provinceName: "北京",
      countryName: "中国",
      lat: 39.9177,
      lon: 116.397,
      score: 4.8,
      url: "https://you.ctrip.com/sight/%E5%8C%97%E4%BA%AC1/4189051.html",
    });
    for (const column of CTRIP_SUGGEST_COLUMNS) {
      expect(row).toHaveProperty(column);
    }
  });

  it("runs destination and hotel suggestion commands against the public endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        ok({ Result: true, Response: { searchResults: [shanghaiCity] } }),
      )
      .mockResolvedValueOnce(
        ok({ Result: true, Response: { searchResults: [hotelSuggestRow] } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const search = resolveCommand("ctrip", "search")?.command;
      const hotelSuggest = resolveCommand("ctrip", "hotel-suggest")?.command;
      await expect(
        search!.func!({} as never, { query: "上海", limit: 5 }),
      ).resolves.toEqual([
        expect.objectContaining({ cityId: 2, name: "上海, 中国" }),
      ]);
      await expect(
        hotelSuggest!.func!({} as never, { query: "汉庭", limit: 5 }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "133133582",
          type: "Hotel",
        }),
      ]);
      const hotelBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(hotelBody.searchType).toBe("H");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps suggest failures explicit", async () => {
    const search = resolveCommand("ctrip", "search")?.command;
    await expect(
      search!.func!({} as never, { query: " ", limit: 5 }),
    ).rejects.toThrow("Search keyword cannot be empty");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ Result: false })));
    try {
      await expect(
        search!.func!({} as never, { query: "上海", limit: 5 }),
      ).rejects.toThrow("Result=false");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps hotel rows and runs hotel-search browser flow", async () => {
    expect(
      pickCtripHotelMapCoords(hotelEntry.hotelInfo.positionInfo.mapCoordinate),
    ).toEqual({ lat: 31.23, lon: 121.47 });
    expect(mapCtripHotelRow(hotelEntry, 0)).toEqual({
      rank: 1,
      hotelId: "106876528",
      name: "上海外滩滨江珍宝酒店",
      enName: "Shanghai Bund Riverside Treasury Hotel",
      star: 4,
      score: 4.7,
      scoreLabel: "超棒",
      reviewCount: 13966,
      cityName: "上海",
      district: "北外滩地区 · 近北外滩来福士",
      address: "东大名路988号",
      lat: 31.23,
      lon: 121.47,
      price: 548,
      currency: "RMB",
      url: "https://hotels.ctrip.com/hotels/detail/?hotelid=106876528",
    });
    const command = resolveCommand("ctrip", "hotel-search")?.command;
    const page = pageMock(["content", [hotelEntry]]);
    await expect(
      command!.func!(page, {
        city: 2,
        checkin: "2026-06-15",
        checkout: "2026-06-17",
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        rank: 1,
        hotelId: "106876528",
        name: "上海外滩滨江珍宝酒店",
      }),
    ]);
    expect(page.goto).toHaveBeenCalledWith(
      "https://hotels.ctrip.com/hotels/list?city=2&checkin=2026-06-15&checkout=2026-06-17",
    );
  });

  it("classifies hotel-search captcha, timeout, empty, malformed, and anchor failures", async () => {
    const command = resolveCommand("ctrip", "hotel-search")?.command;
    const args = {
      city: 2,
      checkin: "2026-06-15",
      checkout: "2026-06-17",
      limit: 5,
    };
    await expect(command!.func!(pageMock(["captcha"]), args)).rejects.toThrow(
      "captcha",
    );
    await expect(command!.func!(pageMock(["timeout"]), args)).rejects.toThrow(
      "did not expose SSR hotel list",
    );
    await expect(
      command!.func!(pageMock(["content", []]), args),
    ).rejects.toThrow("No hotels");
    await expect(
      command!.func!(pageMock(["content", { hotelList: [] }]), args),
    ).rejects.toThrow("malformed SSR hotel list");
    await expect(
      command!.func!(
        pageMock(["content", [{ hotelInfo: { summary: {}, nameInfo: {} } }]]),
        args,
      ),
    ).rejects.toThrow("required hotelId/name anchors");
  });

  it("runs flight browser flow and filters incomplete rows", async () => {
    const command = resolveCommand("ctrip", "flight")?.command;
    const page = pageMock([
      "content",
      2,
      [{ ...flightRow, departureTime: "" }, flightRow],
    ]);
    await expect(
      command!.func!(page, {
        from: "pek",
        to: "sha",
        date: "2026-06-15",
        limit: 5,
      }),
    ).resolves.toEqual([
      {
        rank: 1,
        airline: "厦门航空",
        flightNo: "MF8561",
        aircraft: "空客321(中)",
        departureTime: "07:50",
        departureAirport: "大兴国际机场",
        arrivalTime: "09:45",
        arrivalAirport: "浦东国际机场",
        terminal: "T2",
        price: 487,
        currency: "¥",
        cabin: "经济舱",
        url: "https://flights.ctrip.com/online/list/oneway-pek-sha?depdate=2026-06-15&cabin=Y_S_C_F&adult=1&child=0&infant=0",
      },
    ]);
    expect(page.goto).toHaveBeenCalledWith(
      "https://flights.ctrip.com/online/list/oneway-pek-sha?depdate=2026-06-15&cabin=Y_S_C_F&adult=1&child=0&infant=0",
    );
  });

  it("classifies flight validation, captcha, timeout, empty, malformed, and parser failures", async () => {
    const command = resolveCommand("ctrip", "flight")?.command;
    await expect(
      command!.func!(pageMock([]), {
        from: "PEK",
        to: "PEK",
        date: "2026-06-15",
        limit: 5,
      }),
    ).rejects.toThrow("must differ");
    const args = { from: "PEK", to: "SHA", date: "2026-06-15", limit: 5 };
    await expect(command!.func!(pageMock(["captcha"]), args)).rejects.toThrow(
      "captcha",
    );
    await expect(command!.func!(pageMock(["timeout"]), args)).rejects.toThrow(
      "did not render flight cards",
    );
    await expect(
      command!.func!(pageMock(["content", 0, []]), args),
    ).rejects.toThrow("No flights");
    await expect(
      command!.func!(pageMock(["content", 1, { rows: [] }]), args),
    ).rejects.toThrow("malformed rows");
    await expect(
      command!.func!(
        pageMock(["content", 2, [{ ...flightRow, departureAirport: "" }]]),
        args,
      ),
    ).rejects.toThrow("required airline/flight/time/airport anchors");
  });

  it("browser extraction scripts retain Ctrip DOM anchors", () => {
    expect(buildCtripHotelWaitScript()).toContain("__NEXT_DATA__");
    expect(buildCtripFlightWaitScript()).toContain(".flight-list > span > div");
    expect(buildCtripFlightExtractScript()).toContain("isFlightNo");
  });
});
