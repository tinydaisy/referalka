import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: '#25455D',
        'brand-dark': '#0a1520',
        gold: '#FFCFA4',
      },
      fontFamily: {
        sans: ['Roboto', 'sans-serif'],
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(45deg, #25455D, #0a1520)',
      },
    },
  },
  plugins: [],
}

export default config
