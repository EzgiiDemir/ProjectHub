import type { NextConfig } from 'next';

const api = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  experimental: {
    // proxy.ts makes Next buffer request bodies (default cap 10 MB). Project imports upload up to 300 MB
    // (API limit) through the /api rewrite in development; in production the reverse proxy bypasses Next.
    proxyClientMaxBodySize: '310mb',
  },
  poweredByHeader: false,
  transpilePackages: ['@projecthub/contracts'],
  // The browser talks to one origin; API and Git traffic are forwarded to the API service.
  // (In production the reverse proxy routes /api and /git directly; these rewrites are the fallback.)
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` },
      { source: '/git/:path*', destination: `${api}/git/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
