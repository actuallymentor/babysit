import { eslint_config } from 'airier'

export default [
    ...eslint_config,
    {
        ignores: [ `dist/**` ],
        languageOptions: {
            parserOptions: {
                ecmaFeatures: { jsx: true },
            },
        },
    },
]
