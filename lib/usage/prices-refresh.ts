import type { Db } from "../../db";
import { pricesFetchedAt, replaceModelPrices } from "../../db/usage";
import { fetchGlooPrices } from "./pricing";

/** Same cadence as the OpenRouter catalog sweep. */
const PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 0047: refresh Gloo's public price table when it has never been fetched
 * or the newest row is older than a day. A failed fetch keeps the rows
 * already stored and never throws — the models page must still render.
 */
export async function ensureModelPrices(db: Db, now = Date.now()): Promise<void> {
  const at = pricesFetchedAt(db, "gloo");
  if (at !== null && now - at < PRICE_MAX_AGE_MS) return;
  const fetched = await fetchGlooPrices();
  if (!fetched.ok) {
    console.error(`[usage] gloo prices: ${fetched.error}`);
    return;
  }
  try {
    replaceModelPrices(db, "gloo-v2-models", [...fetched.prices.values()]);
  } catch (err) {
    console.error("[usage] gloo prices persist failed", err);
  }
}
