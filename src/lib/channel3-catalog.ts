// Category slugs and retailer IDs verified with Channel3 on 2026-11-06.
// Commission rates are deliberately fetched with current offers, never pinned here.
export const CHANNEL3_CURATED_SECTIONS = [
  {
    "id": "audio",
    "title": "Audio",
    "description": "Headphones and personal audio.",
    "categoryId": "headphones"
  },
  {
    "id": "travel",
    "title": "Travel",
    "description": "Backpacks for work and weekends.",
    "categoryId": "backpacks"
  },
  {
    "id": "workspace",
    "title": "Workspace",
    "description": "Lighting for home and office.",
    "categoryId": "desk-lamps"
  },
  {
    "id": "kitchen",
    "title": "Kitchen & dining",
    "description": "Cooking, serving and everyday essentials.",
    "categoryId": "kitchen-dining"
  },
  {
    "id": "beauty",
    "title": "Health & beauty",
    "description": "Personal care and beauty finds.",
    "categoryId": "health-beauty"
  },
  {
    "id": "fitness",
    "title": "Fitness",
    "description": "Equipment for active routines.",
    "categoryId": "exercise-fitness"
  },
  {
    "id": "toys",
    "title": "Toys & games",
    "description": "Play and discovery for the family.",
    "categoryId": "toys"
  },
  {
    "id": "fashion",
    "title": "Clothing",
    "description": "Everyday outfits and wardrobe finds.",
    "categoryId": "clothing"
  },
  {
    "id": "shoes",
    "title": "Shoes",
    "description": "Footwear for different occasions.",
    "categoryId": "shoes"
  },
  {
    "id": "computers",
    "title": "Computers",
    "description": "Computers and computing essentials.",
    "categoryId": "computers"
  },
  {
    "id": "phones",
    "title": "Phones",
    "description": "Mobile phones across retailers.",
    "categoryId": "mobile-phones"
  },
  {
    "id": "outdoors",
    "title": "Outdoors",
    "description": "Equipment for outdoor adventures.",
    "categoryId": "outdoor-recreation"
  },
  {
    "id": "pets",
    "title": "Pets",
    "description": "Everyday supplies for pets.",
    "categoryId": "pet-supplies"
  },
  {
    "id": "jewelry",
    "title": "Jewelry",
    "description": "Accessories and gift ideas.",
    "categoryId": "jewelry"
  }
] as const;

export const CHANNEL3_CURATED_RETAILERS = [
  {
    "id": "target",
    "title": "Target",
    "description": "US retailer \u00b7 offers vary by region.",
    "websiteId": "QnTm",
    "storefronts": [
      "US"
    ]
  },
  {
    "id": "cvs",
    "title": "CVS",
    "description": "US retailer \u00b7 offers vary by region.",
    "websiteId": "oeWt",
    "storefronts": [
      "US"
    ]
  },
  {
    "id": "walmart",
    "title": "Walmart",
    "description": "US retailer \u00b7 offers vary by region.",
    "websiteId": "BsaX",
    "storefronts": [
      "US"
    ]
  },
  {
    "id": "bestbuy",
    "title": "Best Buy",
    "description": "US retailer \u00b7 offers vary by region.",
    "websiteId": "p1PB",
    "storefronts": [
      "US"
    ]
  }
] as const;

export type Channel3CuratedSection = (typeof CHANNEL3_CURATED_SECTIONS)[number];
export type Channel3CuratedRetailer = (typeof CHANNEL3_CURATED_RETAILERS)[number];

export function findChannel3CuratedSection(id: string | null | undefined): Channel3CuratedSection | undefined {
  return CHANNEL3_CURATED_SECTIONS.find(section => section.id === id);
}

export function findChannel3CuratedRetailer(id: string | null | undefined): Channel3CuratedRetailer | undefined {
  return CHANNEL3_CURATED_RETAILERS.find(retailer => retailer.id === id);
}
