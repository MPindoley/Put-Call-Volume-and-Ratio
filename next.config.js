/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The flow engine and socket.io live in the custom server process; nothing
  // server-side should be bundled for the edge runtime.
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'socket.io'],
  },
  typescript: {
    // Type-check the app against a build-only config that excludes scripts/.
    // The dev/ops smoke + seed scripts are run with tsx and stay covered by
    // `npm run typecheck` (tsconfig.json), but they must never gate a deploy —
    // a stray reference in a smoke script should not fail `next build`.
    tsconfigPath: 'tsconfig.build.json',
  },
};

module.exports = nextConfig;
