import { describe, expect, it } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("GET /customers/:id/daily-totals", () => {
  it("суммирует оплаченные заказы по дням в таймзоне клиента", async () => {
    // c_1 — Europe/Moscow (UTC+3): 20:30Z ещё 10-е, 21:30Z уже 11-е
    await postWebhook(ctx.app, apiOrder({ amount: 1000, createdAt: "2026-02-10T20:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 250, createdAt: "2026-02-10T21:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: "99", createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-09", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { date: "2026-02-09", total: 0, gross: 0, discount: 0, net: 0 },
        { date: "2026-02-10", total: 1000, gross: 1000, discount: 0, net: 1000 },
        { date: "2026-02-11", total: 349, gross: 349, discount: 0, net: 349 },
    ]);
  });

  it("не учитывает pending и refunded", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 500, gross: 500, discount: 0, net: 500 }]);
  });

  it("учитывает только заказы этого клиента", async () => {
    ctx.api.customers.set("c_2", "Asia/Novosibirsk");
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, customerId: "c_2" }));
    const res = await dailyTotals(ctx.app, "c_2", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 800, gross: 800, discount: 0, net: 800}]);
  });

  it("таймзона клиента берётся из API один раз", async () => {
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    ctx.api.customers.set("c_1", "UTC");
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    const { rows } = await ctx.db.query(`SELECT timezone FROM customers WHERE id = 'c_1'`);
    expect(rows[0].timezone).toBe("Europe/Moscow");
  });

  it("валидирует даты", async () => {
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-30", "2026-03-01")).statusCode).toBe(400);
    expect((await dailyTotals(ctx.app, "c_1", "2026-03-02", "2026-03-01")).statusCode).toBe(400);
  });

  it("неизвестный клиент — 404", async () => {
    const res = await dailyTotals(ctx.app, "nobody", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(404);
  });

    it("учитывает скидки, нулевую оплату и копейки", async () => {
        const orders = [
            { amount: 1000, discountPercent: 10, amountPaid: 900 },
            { amount: 400, discountPercent: 100, amountPaid: 0 },
            { amount: "1.15", discountPercent: 0, amountPaid: "1.15" },
        ];

        for (const order of orders) {
            const response = await postWebhook(ctx.app, apiOrder(order));
            expect(response.statusCode).toBe(200);
        }

        const res = await dailyTotals(
            ctx.app,
            "c_1",
            "2026-02-10",
            "2026-02-10",
        );

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual([
            {
                date: "2026-02-10",
                total: 1401.15,
                gross: 1401.15,
                discount: 500,
                net: 901.15,
            },
        ]);
    });

    it("сохраняет фактическую оплату при синхронизации", async () => {
        ctx.api.pages.set(null, {
            items: [
                apiOrder({
                    amount: 9746,
                    discountPercent: 13,
                    amountPaid: "8479.02",
                }),
            ],
            nextCursor: null,
        });

        const sync = await ctx.app.inject({
            method: "POST",
            url: "/sync",
        });

        expect(sync.statusCode).toBe(200);
        expect(sync.json()).toMatchObject({ applied: 1, invalid: 0 });

        const res = await dailyTotals(
            ctx.app,
            "c_1",
            "2026-02-10",
            "2026-02-10",
        );

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual([
            {
                date: "2026-02-10",
                total: 9746,
                gross: 9746,
                discount: 1266.98,
                net: 8479.02,
            },
        ]);
    });
});
