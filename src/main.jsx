import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initializeLanguage } from './lib/i18n.js';

initializeLanguage();
createRoot(document.getElementById('root')).render(<App/>);
