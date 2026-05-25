const path = require('path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, 'app/**/*.{ts,tsx}'),
    path.join(__dirname, 'components/**/*.{ts,tsx}'),
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans:  ['Inter', 'system-ui', 'sans-serif'],
        serif: ['"IBM Plex Serif"', 'Georgia', 'serif'],
        mono:  ['"IBM Plex Mono"', 'ui-monospace', 'Menlo', 'monospace'],
      },
      colors: {
        navy:   { DEFAULT: '#0a1628', deep: '#050b16', soft: '#16243d' },
        cream:  { DEFAULT: '#f5f1e8', soft: '#fbf8f1' },
        copper: { DEFAULT: '#c97a48', deep: '#a96033', soft: '#e6c8af' },
        moss:   '#2d6e4f',
        ember:  '#c2382e',
        amber:  '#c98a18',
      },
    },
  },
  plugins: [],
};
