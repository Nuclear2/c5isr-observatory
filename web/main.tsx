import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ArchiveViewer from './ArchiveViewer';
import './styles.css';

const archiveMode = new URLSearchParams(window.location.search).get('view') === 'archive';
createRoot(document.getElementById('root')!).render(<StrictMode>{archiveMode ? <ArchiveViewer /> : <App />}</StrictMode>);
