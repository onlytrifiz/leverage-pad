import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Familjen_Grotesk, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Nav, { BottomBar } from "@/components/Nav";
import Footer from "@/components/Footer";
import { WalletProvider } from "@/components/wallet";
import { MotionProvider } from "@/components/motion";
import { LAUNCH_ROUTER } from "@/lib/clientConfig";
import { IntroProvider } from "@/components/intro/intro-context";
import { INTRO_BOOT_SCRIPT } from "@/components/intro/boot";

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

// cover: the page runs under the notch and the home indicator, and the bottom bar and the
// intro pad themselves with env(safe-area-inset-*), which is zero without it
export const viewport: Viewport = { viewportFit: "cover" };

// icons and share images are files next to this one (favicon, icon, apple-icon, opengraph-image)

export const metadata: Metadata = {
  // share images need absolute URLs; www is the host the bare domain redirects to
  metadataBase: new URL("https://www.multiply.cash"),
  title: {
    default: "multiply.cash: tokens fueled by perps",
    template: "%s · multiply.cash",
  },
  description:
    "Every token runs a leveraged perp on the asset its creator picks. When it wins, it buys the token back and burns it.",
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${familjen.variable} ${plexSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      {/* on a phone the body reserves the bottom bar's height, safe area included */}
      <body className="min-h-screen pb-[calc(84px+env(safe-area-inset-bottom))] sm:pb-0">
        {/* first paint for a first-time visitor is the intro's night, not a flash of the market */}
        <Script id="intro-boot" strategy="beforeInteractive">
          {INTRO_BOOT_SCRIPT}
        </Script>
        <MotionProvider>
          <WalletProvider>
            <IntroProvider>
              <Nav />
              {/* width is the page's decision: the market view is wide, prose is not */}
              <main className="w-full pb-16">{children}</main>
              <Footer router={LAUNCH_ROUTER} />
              <BottomBar />
            </IntroProvider>
          </WalletProvider>
        </MotionProvider>
      </body>
    </html>
  );
}
