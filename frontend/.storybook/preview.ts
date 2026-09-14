import type { Preview } from "@storybook/react";
import React from "react";
import { I18nextProvider } from "react-i18next";
import i18n from "../src/i18n";
import "../scss/main.css";
import "../scss/style.scss";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  decorators: [
    (Story) =>
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(
          "div",
          { style: { background: "var(--progeo-page-bg)", padding: 16 } },
          React.createElement(Story),
        ),
      ),
  ],
};

export default preview;
