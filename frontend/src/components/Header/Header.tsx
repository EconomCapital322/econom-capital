import productTitle from '../../assets/images/product-title.svg'
import t1Logo from '../../assets/images/t1-logo.png'
import maiLogo from '../../assets/images/mai-logo.png'
import cross from '../../assets/images/cross.svg'

export function Header() {
  return (
    <header className="app-header">
      <img className="app-header__title" src={productTitle} alt="Econom Capital — Модуль кривых" />
      <div className="brand-lockup" role="img" aria-label="Т1 × МАИ">
        <div className="brand-lockup__t1"><img src={t1Logo} alt="" /></div>
        <img className="brand-lockup__cross" src={cross} alt="" />
        <img className="brand-lockup__mai" src={maiLogo} alt="" />
      </div>
    </header>
  )
}
