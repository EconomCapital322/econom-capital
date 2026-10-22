import productTitle from '../../assets/images/project-wordmark.svg'
import t1Mark from '../../assets/images/t1-mark.svg'

export function Header() {
  return (
    <header className="app-header">
      <img className="app-header__title" src={productTitle} alt="Econom Capital — Модуль кривых" />
      <img className="app-header__logo" src={t1Mark} alt="Т1" />
    </header>
  )
}
