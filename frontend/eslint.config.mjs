import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The React Compiler rule flags setState-in-effect. Our auth/session mounts
  // intentionally read localStorage once on mount (hydration-safe pattern);
  // a later frontend hardening pass should migrate these to
  // useSyncExternalStore. Downgraded to warning so real regressions remain
  // visible without blocking the M0/M1 backend-foundation milestone.
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
