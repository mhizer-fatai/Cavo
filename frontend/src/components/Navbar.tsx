import { Link } from 'react-router-dom'
import { useLocation } from 'react-router-dom'
import { useCavoAuth } from '../context/AuthContext'
import WalletButton from './WalletButton'

export default function Navbar({ username }: { username?: string }) {
  const { user } = useCavoAuth()
  const location = useLocation()
  const isLoggedIn = !!user?.cavoSessionToken
  const isDashboard = location.pathname.startsWith('/dashboard')

  return (
    <nav className="navbar">
      <div className="container navbar-inner">
        <Link to="/" className="nav-logo" style={{ display: 'flex', alignItems: 'center' }}>
          <img src="/cavo-logo.png" alt="Cavo" className="brand-logo-img" />
          <img src="/cavo-wordmark.png" alt="Cavo" className="brand-wordmark-img" />
        </Link>
        <div className="nav-right">
          {isDashboard ? (
            <WalletButton username={username} />
          ) : isLoggedIn ? (
            <Link to="/dashboard" className="btn btn-secondary btn-sm">Dashboard</Link>
          ) : (
            <WalletButton />
          )}
        </div>
      </div>
    </nav>
  )
}
