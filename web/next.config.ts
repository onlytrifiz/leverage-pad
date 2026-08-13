import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    // la pagina docs si chiamava /paper: i vecchi link continuano a funzionare
    return [{ source: "/paper", destination: "/docs", permanent: true }];
  },
};

export default nextConfig;
