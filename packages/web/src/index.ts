/** @trading/web — operational UI (spec §9.20-§9.21). */

export const PACKAGE_NAME = "@trading/web";

export { buildServer, type ServerDeps } from "./server.js";
export {
  type AuthConfig,
  hashPassword,
  issueSession,
  verifyCredentials,
  verifySession,
} from "./auth.js";
