// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import serveStatic from "serve-static";

import shopify from "./shopify.js";
import productCreator from "./product-creator.js";
import PrivacyWebhookHandlers from "./privacy.js";

const PORT = parseInt(
  process.env.BACKEND_PORT || process.env.PORT || "3000",
  10
);

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// -------------------- GRAPHQL QUERIES --------------------

// חיפוש variant לפי SKU
const VARIANT_BY_SKU_QUERY = `#graphql
  query VariantBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      nodes {
        id
        sku
        inventoryItem {
          id
          inventoryLevels(first: 5) {
            edges {
              node {
                id
                location {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

// עדכון מלאי אבסולוטי
const INVENTORY_SET_QUANTITIES_MUTATION = `#graphql
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        createdAt
        reason
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// -------------------- SHOPIFY SETUP --------------------

app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers })
);

// אימות לכל ה־API paths
app.use("/api/*", shopify.validateAuthenticatedSession());
app.use(express.json());

// -------------------- ROUTES --------------------

// דוגמה קיימת – ספירת מוצרים
app.get("/api/products/count", async (_req, res) => {
  const client = new shopify.api.clients.Graphql({
    session: res.locals.shopify.session,
  });

  const countData = await client.request(`
    query shopifyProductCount {
      productsCount {
        count
      }
    }
  `);

  res.status(200).send({ count: countData.data.productsCount.count });
});

// דוגמה קיימת – יצירת מוצרים לדוגמה
app.post("/api/products", async (_req, res) => {
  let status = 200;
  let error = null;

  try {
    await productCreator(res.locals.shopify.session);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.log(`Failed to process products/create: ${errorMessage}`);
    status = 500;
    error = errorMessage;
  }
  res.status(status).send({ success: status === 200, error });
});

// -------------------- NEW ENDPOINT: INVENTORY SYNC --------------------

app.post("/api/inventory-sync", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const client = new shopify.api.clients.Graphql({ session });

    const body = req.body;

    if (!body?.items || !Array.isArray(body.items)) {
      return res.status(400).json({ error: "Field 'items' must be an array" });
    }

    const results = [];

    for (const rawItem of body.items) {
      const sku = rawItem?.sku;
      const quantity = rawItem?.quantity;

      if (sku == null || quantity == null) {
        results.push({
          sku,
          success: false,
          error: "Missing 'sku' or 'quantity'",
        });
        continue;
      }

      try {
        // 1️ חיפוש ה-variant לפי SKU
        const variantResp = await client.request(VARIANT_BY_SKU_QUERY, {
          variables: { query: `sku:${sku}` },
        });

        const variants = variantResp?.data?.productVariants?.nodes || [];
        if (variants.length === 0) {
          throw new Error(`No variant found for sku ${sku}`);
        }

        const variant = variants[0];
        const inventoryItem = variant.inventoryItem;
        const levels = inventoryItem.inventoryLevels?.edges || [];
        if (levels.length === 0) {
          throw new Error(`No inventory levels for sku ${sku}`);
        }

        const inventoryItemId = inventoryItem.id;
        const locationId = levels[0].node.location.id;

        // 2️ עדכון כמות אבסולטית
        const updateResp = await client.request(
          INVENTORY_SET_QUANTITIES_MUTATION,
          {
            variables: {
              input: {
                name: "available",
                reason: "correction",
                ignoreCompareQuantity: true,
                quantities: [
                  {
                    inventoryItemId,
                    locationId,
                    quantity: Number(quantity),
                  },
                ],
              },
            },
          }
        );

        const userErrors =
          updateResp?.data?.inventorySetQuantities?.userErrors || [];

        if (userErrors.length > 0) {
          throw new Error(
            userErrors.map((/** @type {any} */ e) => e.message).join(", ")
          );
        }

        results.push({ sku, success: true });
      } catch (/** @type {any} */ err) {
        console.error("Failed to update inventory for sku", sku, err);
        results.push({
          sku,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return res.status(200).json({ results });
  } catch (/** @type {any} */ e) {
    console.error("Error in /api/inventory-sync:", e);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------- STATIC + SERVER --------------------

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  return res
    .status(200)
    .set("Content-Type", "text/html")
    .send(
      readFileSync(join(STATIC_PATH, "index.html"))
        .toString()
        .replace("%VITE_SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY || "")
    );
});

app.listen(PORT, () => {
  console.log(` Server running on http://localhost:${PORT}`);
});

