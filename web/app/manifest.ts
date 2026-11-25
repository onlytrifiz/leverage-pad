import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "multiply.cash",
    short_name: "multiply",
    description: "Tokens fueled by perps.",
    start_url: "/",
    display: "standalone",
    background_color: "#0d1d15",
    theme_color: "#0d1d15",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
