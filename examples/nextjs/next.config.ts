import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
};

export default config;
