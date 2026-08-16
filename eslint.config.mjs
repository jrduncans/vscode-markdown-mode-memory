import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['dist/**', 'node_modules/**']
	},
	eslint.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				project: ['./tsconfig.json', './tsconfig.test.json'],
				tsconfigRootDir: import.meta.dirname
			}
		}
	},
	{
		files: ['test/**/*.ts'],
		rules: {
			'@typescript-eslint/no-floating-promises': 'off'
		}
	}
);
