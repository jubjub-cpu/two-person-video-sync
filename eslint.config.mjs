import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

const disableTypeChecked = tseslint.configs.disableTypeChecked;

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.output/**",
      "**/.wxt/**",
      "**/coverage/**",
      "**/artifacts/**",
      "**/node_modules/**",
      "**/test-results/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ...disableTypeChecked,
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ...disableTypeChecked.languageOptions,
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        globalThis: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "import-x": importX,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import-x/no-duplicates": "error",
    },
  },
  {
    files: ["**/*.{test,spec}.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    files: ["tests/fixtures/**/*.js"],
    languageOptions: {
      globals: {
        Event: "readonly",
        document: "readonly",
        history: "readonly",
        window: "readonly",
      },
    },
  },
);
