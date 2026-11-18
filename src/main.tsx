import { createRoot } from 'react-dom/client'


const root = createRoot(document.getElementById('root')!)
const surface = new URLSearchParams(location.search)
if (surface.has('desktop-pet')) {
  document.documentElement.classList.add('desktop-pet-root')
  void import('./features/desktop-pet/PetWindow').then(({ default: PetWindow }) => root.render(<PetWindow />))
} else if (surface.has('desktop-assistant')) {
  void Promise.all([import('./features/desktop-pet/DesktopAssistantWindow'), import('./styles.css')])
    .then(([{ default: DesktopAssistantWindow }]) => root.render(<DesktopAssistantWindow />))
} else {
  void Promise.all([import('./App'), import('./styles.css')]).then(([{ default: App }]) => root.render(<App />))
}
