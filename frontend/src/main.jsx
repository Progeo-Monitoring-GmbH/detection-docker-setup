import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import i18n from './i18n';
import '../scss/style.scss';

// Keep i18n initialization as a live binding so aggressive tree-shaking
// cannot drop initReactI18next side effects in production builds.
void i18n;

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
