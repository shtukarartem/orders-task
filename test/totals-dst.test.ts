import { describe, expect, it, vi } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("daily totals across Berlin daylight saving time", () => {
  it("uses the offset at the order timestamp and excludes the next local day", async () => {
    ctx.api.customers.set("c_7", "Europe/Berlin");
    for (const [createdAt, amount] of [
      ["2026-03-28T22:40:00Z", 100], // 23:40 on March 28
      ["2026-03-29T22:40:08Z", 9306], // 00:40 on March 30
      ["2026-03-30T22:40:44Z", 1823], // 00:40 on March 31
      ["2026-03-31T22:15:49Z", 5487], // April 1, outside the requested period
    ] as const) {
      const response = await postWebhook(ctx.app, apiOrder({ customerId: "c_7", createdAt, amount }));
      expect(response.statusCode).toBe(200);
    }

    // Historical totals must not depend on whether the query runs in winter or summer.
    for (const now of ["2026-01-15T12:00:00Z", "2026-07-15T12:00:00Z"]) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      try {
        const response = await dailyTotals(ctx.app, "c_7", "2026-03-27", "2026-03-31");
        expect(response.statusCode).toBe(200);
        expect(response.json().map((day: { date: string; total: number }) => ({ date: day.date, total: day.total }))).toEqual([
          { date: "2026-03-27", total: 0 },
          { date: "2026-03-28", total: 100 },
          { date: "2026-03-29", total: 0 },
          { date: "2026-03-30", total: 9306 },
          { date: "2026-03-31", total: 1823 },
        ]);
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
