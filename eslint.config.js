import js from "@eslint/js";
import tseslint from "typescript-eslint";

const tenantBypass = [
  "error",
  {
    object: "pool",
    property: "query",
    message:
      "Use withTenant(). pool.query is forbidden outside src/db/tenant.ts (R12, §4.4.1).",
  },
  {
    object: "pool",
    property: "connect",
    message:
      "Use withTenant(). pool.connect is forbidden outside src/db/tenant.ts (R12, §4.4.1).",
  },
];

export default tseslint.config(
  {
    files: ["web/public/sw.js"],
    languageOptions: {
      globals: {
        self: "readonly",
        caches: "readonly",
        fetch: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    ignores: [
      "dist/**",
      "**/dist/**",
      "node_modules/**",
      "**/node_modules/**",
      "prototype/**",
      // A template fragment injected into a probe page, not a module: its one
      // function is called by the page that embeds it.
      "scripts/layout-probe.js",
      "scripts/fetch-indic-fonts.mjs",
      "docs/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-properties": tenantBypass,
    },
  },
  {
    // Audited exemptions: both run outside any tenant context.
    // The migration runner is the DDL role. pg-boss owns its queue tables.
    files: ["src/db/tenant.ts", "src/db/migrate.ts", "src/platform/jobs/**/*.ts"],
    rules: {
      "no-restricted-properties": "off",
    },
  },
);
