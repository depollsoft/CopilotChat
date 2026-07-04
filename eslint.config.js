import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ignores: [
      "**/dist/**",
      "**/tsbuild/**",
      "**/node_modules/**",
      "**/.data/**",
      "apps/web/public/sw.js",
      "playwright-report/**",
      "test-results/**",
      "eslint.config.js",
      "scripts/*.mjs",
      "packages/provider/scripts/*.mjs",
      "vitest.config.ts",
      "playwright.config.ts",
      "pnpm-lock.yaml",
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.js", "*.ts", "scripts/*.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": { "attributes": false } }],
      "@typescript-eslint/require-await": "off",
    },
  },
);
