import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".inside-harness/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "test/architecture/fixtures/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
