import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
  // controls/actions/docs/interactions/viewport etc. ship in core as of
  // Storybook 9+ (@storybook/addon-essentials and addon-interactions are
  // no longer published for it) - addon-links is the one still separate.
  addons: ["@storybook/addon-links"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
};
export default config;
