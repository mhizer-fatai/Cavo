import { Navigate, Routes, Route } from 'react-router-dom'
import HomePage from './pages/Home'
import PayPage from './pages/Pay'
import DashboardPage from './pages/Dashboard'
import ProfilePage from './pages/Profile'
import { useCavoAuth } from './context/AuthContext'

function AuthCallbackPage() {
  const { user } = useCavoAuth()
  return user ? <Navigate to="/dashboard" replace /> : <Navigate to="/" replace />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/pay/:linkId" element={<PayPage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/u/:username" element={<ProfilePage />} />
    </Routes>
  )
}
