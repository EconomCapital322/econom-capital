import 'bootstrap/dist/css/bootstrap.min.css'
import './assets/styles/tokens.css'
import './assets/styles/ui.css'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createHttpCurvesService } from './api/httpAdapter'
import App from './App'
import type { CurveEmbedding } from './App'
import { CurvesApiContext } from './store/CurvesApiContext'
import './embedded.css'

export function mountCurves(container: HTMLElement) {
  const scope = container.attachShadow({ mode: 'open' })
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'
  stylesheet.href = '/curve-ui/curves.css'
  const content = document.createElement('div')
  content.hidden = true
  stylesheet.addEventListener('load', () => { content.hidden = false }, { once: true })
  stylesheet.addEventListener('error', () => {
    container.append(document.createTextNode('Не удалось загрузить оформление кривых. Обновите страницу.'))
    const slot = document.createElement('slot')
    scope.append(slot)
  }, { once: true })
  scope.append(stylesheet, content)
  const root = createRoot(content)
  const client = new QueryClient()
  const api = createHttpCurvesService()

  return {
    update(embedding: Omit<CurveEmbedding, 'portalTarget'>) {
      root.render(
        <QueryClientProvider client={client}>
          <CurvesApiContext.Provider value={api}>
            <App embedding={{ ...embedding, portalTarget: scope }} />
          </CurvesApiContext.Provider>
        </QueryClientProvider>,
      )
    },
  }
}
