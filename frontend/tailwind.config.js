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
          DEFAULT: '#2447D8',
          600: '#1E3FBF',
          50: '#EEF2FF',
        },
        success: {
          DEFAULT: '#16A34A',
          50: '#ECFDF3',
        },
        warning: {
          DEFAULT: '#F59E0B',
          50: '#FFF7E6',
        },
        violet: {
          DEFAULT: '#7C3AED',
          50: '#F3EEFF',
        },
        ink: {
          DEFAULT: '#111827',
          muted: '#6B7280',
        },
        surface: {
          page: '#F4F6FB',
          card: '#FFFFFF',
          line: '#E5E7EB',
        },
        danger: '#DC2626',
      },
      borderRadius: {
        xl: '12px',
        '2xl': '16px',
      },
      boxShadow: {
        sm: '0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
        glow: '0 0 20px rgba(36, 71, 216, 0.25)',
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
