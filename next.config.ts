import type { NextConfig } from "next";

// V16 fix — baseline security headers for every response.
// CSP notes: Next.js App Router requires 'unsafe-inline' scripts for the
// hydration payload (nonce-based CSP is not practical without middleware
// rewriting every document); 'unsafe-eval' is only added in development
// for React refresh. frame-ancestors stays 'self' so the internal preview
// embedding keeps working while foreign sites cannot frame the app.
const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  // ssh2 must stay a Node runtime dependency (ADMS setup wizard SSH/SFTP);
  // without this Next tries to bundle it for the edge and fails.
  serverExternalPackages: ["ssh2"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Hide the Next.js DevTools indicator ("N" button) that appears in dev mode
  devIndicators: false,
  // Do not advertise the framework version (V16 fix).
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
