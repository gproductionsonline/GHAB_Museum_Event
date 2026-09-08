// Backend ESLint configuration (audit L-7).
//
// TypeScript note: this project uses TypeScript 7 (the native compiler).
// typescript-eslint's peer range lags behind, so the dependency is installed
// with legacy peer resolution and this config deliberately uses the
// NON-type-checked recommended preset (syntactic rules only — no
// type-aware linting, which does not support tsgo). Type safety is enforced
// by `tsc` via the typecheck/build scripts.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "src/generated/**", // Prisma-generated code
      ".data/**",
      "*.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Deliberate policy decisions (documented, not problem-hiding):
      //
      // no-non-null-assertion: the codebase enables noUncheckedIndexedAccess,
      // so indexed access is `T | undefined` by design and guarded `!`
      // assertions after explicit length/existence checks are the chosen
      // pattern. Revisit only under a stricter policy decision.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
