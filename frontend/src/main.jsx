import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import App from './App';
import i18n from './i18n';
import '../scss/main.css';
import '../scss/style.scss';

// Keep i18n initialization as a live binding so aggressive tree-shaking
// cannot drop initReactI18next side effects in production builds.
void i18n;

ReactDOM.createRoot(document.getElementById('root')).render(
  <I18nextProvider i18n={i18n}>
    <App />
  </I18nextProvider>,
);
