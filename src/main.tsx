import { createRoot } from 'react-dom/client'


const root = createRoot(document.getElementById('root')!)
if (new URLSearchParams(location.search).has('desktop-pet')) {
  document.documentElement.classList.add('desktop-pet-root')
  void import('./features/desktop-pet/PetWindow').then(({ default: PetWindow }) => root.render(<PetWindow />))
} else {
  void Promise.all([import('./App'), import('./styles.css')]).then(([{ default: App }]) => root.render(<App />))
}
