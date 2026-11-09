import type { Metadata } from "next";
import Script from "next/script";
import localFont from "next/font/local";
import "./globals.css";
import { AppearanceProvider } from "./components/theme-preference";

const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-geist-sans",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "Courier New", "monospace"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "PayPal Markets | Clear crypto market context",
  description:
    "A mobile-first crypto market dashboard with reference prices, market metrics, charts, a manual portfolio view, and Channel3 product discovery.",
  applicationName: "PayPal Markets",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Script id="paypal-markets-appearance" strategy="beforeInteractive">
          {`try{var p=localStorage.getItem("paypal-markets-theme-v1");if(p==="light"||p==="dark"){document.documentElement.dataset.theme=p;document.documentElement.style.colorScheme=p}}catch{}`}
        </Script>
        <AppearanceProvider>{children}</AppearanceProvider>
      </body>
    </html>
  );
}
