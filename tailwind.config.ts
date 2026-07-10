import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Trading-desk dark palette
        surface: {
          DEFAULT: '#0b0f17',
          raised: '#111827',
          overlay: '#1a2332',
          border: '#232f42',
        },
        // Validated against surface #0b0f17 (lightness band + contrast).
        // caution/severe/bearish form an ordered severity ramp and are always
        // paired with a text label — never color alone.
        bullish: '#16a34a',
        bearish: '#ef4444',
        caution: '#b8860b',
        severe: '#dc4a0b',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        'flash-green': {
          '0%': { backgroundColor: 'rgba(34, 197, 94, 0.25)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-red': {
          '0%': { backgroundColor: 'rgba(239, 68, 68, 0.25)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
      animation: {
        'flash-green': 'flash-green 1.2s ease-out',
        'flash-red': 'flash-red 1.2s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
