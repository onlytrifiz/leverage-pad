import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // solo il CDN dei token di Lighter: i loro png sono da scheda (fino a 925KB
    // per icona) e vanno ridimensionati prima di finire in un ticker da 16px.
    remotePatterns: [new URL("https://assets.lighter.xyz/fe/token/**")],
  },
  async redirects() {
    // la pagina docs si chiamava /paper: i vecchi link continuano a funzionare
    return [{ source: "/paper", destination: "/docs", permanent: true }];
  },
};

export default nextConfig;
