/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  experimental: { serverActions: { bodySizeLimit: '4mb' } },
  serverExternalPackages: ['better-sqlite3'],
};
module.exports = nextConfig;
