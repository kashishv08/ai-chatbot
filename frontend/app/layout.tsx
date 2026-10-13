import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chat Console",
  description: "A chat interface for testing live inference and cached responses.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
