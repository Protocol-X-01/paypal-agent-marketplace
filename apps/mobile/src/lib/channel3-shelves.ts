// Category slugs and retailer IDs verified with Channel3 on 2026-11-06.
// Commission rates are deliberately fetched with current offers, never pinned here.
export const CHANNEL3_CURATED_SECTIONS = [
  {
    "id": "audio",
    "title": "Audio",
    "description": "Headphones and personal audio."
  },
  {
    "id": "travel",
    "title": "Travel",
    "description": "Backpacks for work and weekends."
  },
  {
    "id": "workspace",
    "title": "Workspace",
    "description": "Lighting for home and office."
  },
  {
    "id": "kitchen",
    "title": "Kitchen & dining",
    "description": "Cooking, serving and everyday essentials."
  },
  {
    "id": "beauty",
    "title": "Health & beauty",
    "description": "Personal care and beauty finds."
  },
  {
    "id": "fitness",
    "title": "Fitness",
    "description": "Equipment for active routines."
  },
  {
    "id": "toys",
    "title": "Toys & games",
    "description": "Play and discovery for the family."
  },
  {
    "id": "fashion",
    "title": "Clothing",
    "description": "Everyday outfits and wardrobe finds."
  },
  {
    "id": "shoes",
    "title": "Shoes",
    "description": "Footwear for different occasions."
  },
  {
    "id": "computers",
    "title": "Computers",
    "description": "Computers and computing essentials."
  },
  {
    "id": "phones",
    "title": "Phones",
    "description": "Mobile phones across retailers."
  },
  {
    "id": "outdoors",
    "title": "Outdoors",
    "description": "Equipment for outdoor adventures."
  },
  {
    "id": "pets",
    "title": "Pets",
    "description": "Everyday supplies for pets."
  },
  {
    "id": "jewelry",
    "title": "Jewelry",
    "description": "Accessories and gift ideas."
  }
] as const;

export const CHANNEL3_CURATED_RETAILERS = [
  {
    "id": "target",
    "title": "Target",
    "description": "US retailer \u00b7 offers vary by region.",
    "storefronts": [
      "US"
    ]
  },
  {
    "id": "cvs",
    "title": "CVS",
    "description": "US retailer \u00b7 offers vary by region.",
    "storefronts": [
      "US"
    ]
  },
  {
    "id": "walmart",
    "title": "Walmart",
    "description": "US retailer \u00b7 offers vary by region.",
    "storefronts": [
      "US"
    ]
  },
  {
    "id": "bestbuy",
    "title": "Best Buy",
    "description": "US retailer \u00b7 offers vary by region.",
    "storefronts": [
      "US"
    ]
  }
] as const;
