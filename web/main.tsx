import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ArchiveViewer from './ArchiveViewer';
import EvidenceLab from './EvidenceLab';
import './styles.css';

const view = new URLSearchParams(window.location.search).get('view');
const page = view === 'evidence' ? <EvidenceLab /> : view === 'archive' ? <ArchiveViewer /> : <App />;
createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>);
