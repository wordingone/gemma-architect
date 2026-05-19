// Shared port constants — import instead of hardcoding literals.
// Override via env vars for CI or non-standard host setups.
export const CDP_PORT = Number(process.env.CDP_PORT ?? "9222");
export const DEV_PORT = Number(process.env.DEV_PORT ?? "5175");
export const CDP_BASE = `http://localhost:${CDP_PORT}`;
export const DEV_BASE = `http://localhost:${DEV_PORT}`;
export const DEV_URL  = `http://localhost:${DEV_PORT}/`;
