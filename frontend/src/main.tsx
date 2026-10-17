import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'bootstrap/dist/css/bootstrap.min.css'
import './index.css'
import App from './App.tsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CurvesApiContext } from './store/CurvesApiContext'
import { curvesService } from './api'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <CurvesApiContext.Provider value={curvesService}><App /></CurvesApiContext.Provider>
    </QueryClientProvider>
  </StrictMode>,
)
