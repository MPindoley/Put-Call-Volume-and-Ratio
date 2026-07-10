/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The flow engine and socket.io live in the custom server process; nothing
  // server-side should be bundled for the edge runtime.
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'socket.io'],
  },
};

module.exports = nextConfig;
