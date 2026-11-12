import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installDevMockBridge } from './devMock.js';
installDevMockBridge();
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing from index.html');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
