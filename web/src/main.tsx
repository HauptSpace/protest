import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import LaunchPanel from './components/LaunchPanel';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LaunchPanel />
  </StrictMode>,
);
