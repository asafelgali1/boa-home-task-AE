# BOA Home Task – Inventory Sync App

This app is based on the Shopify Node + React template and implements an **inventory synchronization endpoint** between an external warehouse system and Shopify.

## Overview

The app exposes a REST API endpoint that receives a list of SKUs and absolute quantities, 
then updates the corresponding Shopify variants’ inventory levels via the **Shopify GraphQL Admin API**.

## Endpoint

`POST /api/inventory-sync`

### Example request body

```json
{
  "items": [
    { "sku": "20760", "quantity": 5 },
    { "sku": "12345", "quantity": 10 }
  ]
}



{
  "results": [
    { "sku": "20760", "success": true },
    { "sku": "12345", "success": false, "error": "Variant not found" }
  ]
}
