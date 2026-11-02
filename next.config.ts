import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  // The docs build links pages with a trailing slash (/docs/guide/): pass them through as is.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      // VitePress docs (org/docs), a separate Vercel project proxied under /docs (same domain).
      // Target the docs project's production domain, which follows every deploy of its main branch.
      // The docs project serves the site at its root as well as under /docs.
      { source: "/docs/:path*", destination: "https://principalmarket-docs.vercel.app/:path*" },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
