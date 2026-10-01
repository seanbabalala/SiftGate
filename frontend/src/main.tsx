import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider } from './contexts/AuthContext'
import { App } from './App'
import { i18nReady } from './i18n'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
})

const root = createRoot(document.getElementById('root')!)
// Keep the existing route tree while enabling supported SPA/history navigation blockers.
const router = createBrowserRouter([{ path: '*', element: <ThemeProvider><AuthProvider><App /></AuthProvider></ThemeProvider> }])

function renderApp() {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  )
}

void i18nReady.then(renderApp, renderApp)
