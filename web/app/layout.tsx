import type { Metadata } from "next";
import { Familjen_Grotesk, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { WalletProvider } from "@/components/wallet";
import { MotionProvider } from "@/components/motion";
import { LAUNCH_ROUTER } from "@/lib/clientConfig";

/*
 * Three roles, three families: Familjen Grotesk for headings (the only voice
 * with a character), Plex Sans for anything read as prose, Plex Mono for data.
 */
const familjen = Familjen_Grotesk({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-familjen",
});

const plexSans = IBM_Plex_Sans({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-plex-sans",
});

const plexMono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: {
    default: "multiply.cash: coins backed by Lighter perps",
    template: "%s · multiply.cash",
  },
  description:
    "Coins with liquidity locked forever on Robinhood Chain. Trading fees fund a leveraged perp on Lighter; profits buy back and burn.",
  icons: { icon: "/logo-transparent.png" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${familjen.variable} ${plexSans.variable} ${plexMono.variable}`}
    >
      <body className="min-h-screen">
        <MotionProvider>
          <WalletProvider>
            <Nav />
            {/* width is the page's decision: the market view is wide, prose is not */}
            <main className="w-full pb-16">{children}</main>
            <Footer router={LAUNCH_ROUTER} />
          </WalletProvider>
        </MotionProvider>
      </body>
    </html>
  );
}
