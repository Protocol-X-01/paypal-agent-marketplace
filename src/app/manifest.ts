import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PayPal Markets",
    short_name: "Markets",
    description: "Clear crypto market prices and charts with a manual portfolio view.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f7fb",
    theme_color: "#ffffff",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
