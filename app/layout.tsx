import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("http://localhost:3000"),
  title: "弹幕播放器",
  description: "本地视频与 XML、ASS 弹幕同步播放器。",
  icons: {
    icon: "/app-icon.png",
    shortcut: "/app-icon.png",
  },
  openGraph: {
    title: "弹幕播放器",
    description: "XML · ASS · 精准同步",
    images: [{ url: "/og.png", width: 1729, height: 910, alt: "弹幕播放器" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "弹幕播放器",
    description: "XML · ASS · 精准同步",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
