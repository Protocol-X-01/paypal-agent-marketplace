import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "PayPal Operations | Management concept",
  description: "A separate, disconnected aggregate reporting concept with an optional fictional preview.",
  robots: { index: false, follow: false },
};

export default function ManagementLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
