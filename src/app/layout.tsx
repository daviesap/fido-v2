import type { Metadata, Viewport } from "next";
import { AuthProvider } from "@/components/auth-provider";
import { PwaRegister } from "@/components/pwa-register";
import "react-image-crop/dist/ReactCrop.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fido — Receipt Manager",
  description: "Capture, review, and privately store receipt images.",
  applicationName: "Fido",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Fido", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f2efe7",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><AuthProvider>{children}</AuthProvider><PwaRegister /></body>
    </html>
  );
}
