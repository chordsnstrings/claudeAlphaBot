/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile workspace packages (shared types and helpers)
  transpilePackages: ["@hydra/shared"],
  experimental: {
    // Server Actions enabled by default in Next 14; nothing else needed.
  },
  eslint: { ignoreDuringBuilds: true }, // tsc is our linter
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
