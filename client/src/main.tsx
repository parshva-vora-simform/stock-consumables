import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Stock figures go stale the moment someone else records a movement, so
      // refetching on focus is the right default here rather than a nuisance.
      staleTime: 10_000,
      retry: 1,
    },
  },
});

// React 19: createRoot only — ReactDOM.render is gone.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
