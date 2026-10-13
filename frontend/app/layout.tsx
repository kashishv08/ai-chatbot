import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resilient AI Chatbot",
  description: "Multi-turn AI chatbot with LiteLLM key failover and response caching.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" style={{ height: "100%", overflow: "hidden" }}>
      <body style={{ height: "100%", overflow: "hidden" }}>{children}</body>
    </html>
  );
}
