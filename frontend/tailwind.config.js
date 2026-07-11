/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        primary: {
          DEFAULT: '#4169E1',
          600: '#3355C9',
          50: '#19224A',
        },
        success: {
          DEFAULT: '#34D399',
          50: '#0E3532',
        },
        warning: {
          DEFAULT: '#FBBF24',
          50: '#3A2E12',
        },
        violet: {
          DEFAULT: '#38BDF8',
          50: '#0C2C42',
        },
        ink: {
          DEFAULT: '#F2F4FA',
          muted: '#98A2B8',
        },
        surface: {
          page: '#0B0E16',
          card: '#141927',
          line: '#272E44',
        },
        danger: '#F87171',
      },
      borderRadius: {
        xl: '12px',
        '2xl': '16px',
      },
      boxShadow: {
        sm: '0 1px 3px 0 rgb(0 0 0 / 0.35), 0 1px 2px -1px rgb(0 0 0 / 0.25)',
        glow: '0 0 20px rgba(65, 105, 225, 0.25)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out',
        shimmer: 'shimmer 2s infinite linear',
      },
    },
  },
  plugins: [],
}
