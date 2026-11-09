import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Keep existing scripts, styles, images and the Channel3 image fetch working
  // until a separately reviewed nonce-based policy can be tested in browsers.
  { key: "Content-Security-Policy", value: "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(), microphone=()" },
];

const paypalSignInFormPolicy = "base-uri 'self'; form-action 'self' https://www.paypal.com https://www.sandbox.paypal.com; frame-ancestors 'none'; object-src 'none'";

if (process.env.NODE_ENV === "production") {
  securityHeaders.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Keep build workers bounded on development and small hosted instances.
  experimental: { cpus: 2, turbopackFileSystemCacheForBuild: false, useTypeScriptCli: false },
  serverExternalPackages: ["better-sqlite3"],
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // A top-level same-origin sign-in POST redirects only to the verified PayPal hosts.
      { source: "/dashboard", headers: [{ key: "Content-Security-Policy", value: paypalSignInFormPolicy }] },
      { source: "/api/auth/paypal/start", headers: [{ key: "Content-Security-Policy", value: paypalSignInFormPolicy }] },
      { source: "/api/auth/native/:path*", headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; base-uri 'none'; form-action 'self' https://www.paypal.com https://www.sandbox.paypal.com; frame-ancestors 'none'; object-src 'none'" }] },
      { source: "/api/auth/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/api/ai/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        condition: { path: /(^|\/)globals\.css$/ },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
