import { Link } from 'react-router-dom'
import { useLocation } from 'react-router-dom'
import { useCavopayAuth } from '../context/AuthContext'
import WalletButton from './WalletButton'

export default function Navbar({ username }: { username?: string }) {
  const { user } = useCavopayAuth()
  const location = useLocation()
  const isLoggedIn = !!user?.cavopaySessionToken
  const isDashboard = location.pathname.startsWith('/dashboard')

  return (
    <nav className="navbar">
      <div className="container navbar-inner">
        <Link to="/" className="nav-logo" style={{ display: 'flex', alignItems: 'center' }}>
          <img src="/cavopay-logo.png" alt="Cavopay" className="brand-logo-img" />
          <img src="/cavopay-wordmark.png" alt="Cavopay" className="brand-wordmark-img" />
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
