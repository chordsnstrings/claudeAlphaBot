/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile workspace packages (shared types and helpers)
  transpilePackages: ["@hydra/shared"],
  // Produce `.next/standalone/` for a minimal Docker runtime image.
  // The Dockerfile COPYs standalone + static into the final stage.
  output: "standalone",
  experimental: {
    // Server Actions enabled by default in Next 14; nothing else needed.
  },
  eslint: { ignoreDuringBuilds: true }, // tsc is our linter
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
