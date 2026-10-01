import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // src/api/generated.ts 는 openapi-typescript 산출물이다. 손으로 고치지 않으므로
  // 린트 대상이 아니다 — 규칙을 맞추려면 생성기를 바꿔야 하는데 그건 계약이 아니다.
  { ignores: ["dist", "node_modules", "src/api/generated.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // 설정 파일은 타입 정보 없이 검사한다.
    files: ["*.config.ts", "eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
