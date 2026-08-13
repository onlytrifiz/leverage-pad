import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Nav from "@/components/Nav";
import { WalletProvider } from "@/components/wallet";

const plexMono = IBM_Plex_Mono({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "multiply.cash — coins backed by Lighter perps",
  description:
    "Coins with liquidity locked forever on Robinhood Chain. Trading fees fund a leveraged perp on Lighter; profits buy back and burn.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={plexMono.variable}>
      <body className="min-h-screen">
        <WalletProvider>
          <Nav />
          <main className="mx-auto w-full max-w-[1200px] px-4 pb-16">{children}</main>
          <footer className="border-t border-line">
            <div className="lbl mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-2 px-4 py-5">
              <span>multiply.cash · liquidity locked forever · fees → perp → buyback &amp; burn</span>
              <span>uniswap v3 · lighter · robinhood chain</span>
            </div>
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
