const path = require('path');
// Anchor the tailwind config explicitly — start-all spawns Next.js from the
// monorepo root so the default cwd-based discovery would miss the config.
module.exports = {
  plugins: {
    tailwindcss: { config: path.join(__dirname, 'tailwind.config.js') },
    autoprefixer: {},
  },
};
