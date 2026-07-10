// Single source of truth for the server version: package.json. The prior
// pattern (hardcoded string in telemetry.ts) drifted within one release
// (0.5.1 reported while 0.6.0 shipped) — never hardcode the version again.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const SERVER_VERSION: string = require("../package.json").version;
