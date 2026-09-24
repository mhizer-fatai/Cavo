import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  CircleDollarSign,
  Globe,
  KeyRound,
  Link2,
  PiggyBank,
  QrCode,
  Send,
  ShieldCheck,
  TrendingUp,
  Zap,
} from 'lucide-react'
import Navbar from '../components/Navbar'
import WalletButton from '../components/WalletButton'
import { useCavopayAuth } from '../context/AuthContext'

function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            node.classList.add('reveal-visible')
            observer.disconnect()
          }
        })
      },
      { threshold: 0.15 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className={`reveal ${className}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  )
}

const MARQUEE_ITEMS = [
  { icon: <Send size={14} />, label: 'Send USDC in seconds' },
  { icon: <ArrowLeftRight size={14} />, label: 'Swap USDC ⇄ EURC instantly' },
  { icon: <PiggyBank size={14} />, label: 'Earn on idle balances' },
  { icon: <QrCode size={14} />, label: 'Receive via @username' },
  { icon: <Link2 size={14} />, label: 'Payment links & QR checkout' },
  { icon: <ShieldCheck size={14} />, label: 'PIN-protected sends' },
  { icon: <Zap size={14} />, label: 'Sub-second settlement' },
]

const STATS = [
  { icon: <Zap size={18} />, value: 'Sub-second', label: 'deterministic finality on Arc' },
  { icon: <CircleDollarSign size={18} />, value: 'USDC gas', label: 'predictable, stable fees' },
  { icon: <Link2 size={18} />, value: '@usernames', label: 'human‑readable payment handles' },
  { icon: <ShieldCheck size={18} />, value: '1:1 reserves', label: 'regulated stablecoins only' },
]

const CORE_FEATURES = [
  {
    icon: <Send size={22} />,
    title: 'Send',
    desc: 'Pay any @username or wallet address in USDC or EURC. Every transfer is confirmed with your 4-digit Payment PIN — no seed phrases, no browser extensions.',
  },
  {
    icon: <QrCode size={22} />,
    title: 'Receive',
    desc: 'Claim a permanent @username, share a payment link, or show your QR code. Funds land directly in your built-in Circle wallet on Arc.',
  },
  {
    icon: <ArrowLeftRight size={22} />,
    title: 'Swap',
    desc: 'Convert between USDC and EURC instantly at the best available rate, with your quoted minimum guaranteed. FX without leaving the app.',
  },
  {
    icon: <PiggyBank size={22} />,
    title: 'Earn',
    desc: 'Put idle USDC and EURC to work in savings vaults and watch yield accrue on your dashboard — one tap to deposit, one tap to withdraw.',
  },
]

const WHY_POINTS = [
  { icon: <KeyRound size={18} />, title: 'No seed phrases', desc: 'Sign in with Google or an email code. Your keys live in Circle-backed wallets, not in a screenshot.' },
  { icon: <ShieldCheck size={18} />, title: 'PIN-first security', desc: 'A 4-digit PIN with lockouts, spending limits and one-time approvals guards every send and swap.' },
  { icon: <Link2 size={18} />, title: 'Human payment handles', desc: 'Claim @you once and get paid forever. Shareable links and QR codes do the rest.' },
  { icon: <Zap size={18} />, title: 'Instant settlement', desc: 'Arc finality means balances and history update in seconds, not block confirmations.' },
  { icon: <Globe size={18} />, title: 'Cross-chain by default', desc: 'Deposit USDC from Ethereum, Base, Arbitrum, Optimism or Polygon straight into Arc.' },
  { icon: <TrendingUp size={18} />, title: 'Money that works', desc: 'Hold, move and earn — your stablecoin account is a bank account, not just a wallet.' },
]

const STEPS = [
  { icon: <Link2 size={26} />, title: 'Create your account', desc: 'Sign in, get an in-app Circle wallet automatically, and claim your @username.' },
  { icon: <Send size={26} />, title: 'Fund it your way', desc: 'Receive from any Cavopay user, share a payment link, or bridge USDC from another chain.' },
  { icon: <ArrowLeftRight size={26} />, title: 'Send, swap and earn', desc: 'Move money by handle, convert between currencies, and grow idle balances in vaults.' },
]

export default function HomePage() {
  const { user } = useCavopayAuth()
  const isLoggedIn = !!user?.cavopaySessionToken
  const marqueeItems = [...MARQUEE_ITEMS, ...MARQUEE_ITEMS]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <Navbar />

      <section className="home-hero">
        <div className="container">
          <span className="live-chip">
            <span className="live-dot" />
            Live on Arc Testnet
          </span>
          <h1 className="home-hero-title">
            Send, receive, swap and earn.
            <br />
            <span className="gradient-text">One stablecoin account.</span>
          </h1>
          <p className="hero-sub">
            Cavopay is a neobank for USDC and EURC. A @username instead of a hex address, a PIN instead
            of a seed phrase, and settlement that lands in seconds.
          </p>
          <div className="hero-btns">
            {!isLoggedIn ? (
              <WalletButton className="btn-lg" />
            ) : (
              <Link to="/dashboard" className="btn btn-primary btn-lg">
                Open Dashboard <ArrowRight size={18} />
              </Link>
            )}
            <a href="#what" className="btn btn-secondary btn-lg">
              What is Cavopay?
            </a>
          </div>
        </div>
      </section>

      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {marqueeItems.map((item, index) => (
            <span className="marquee-item" key={index}>
              <span className="marquee-icon">{item.icon}</span>
              {item.label}
              <span className="marquee-sep" />
            </span>
          ))}
        </div>
      </div>

      <section className="home-section" id="what">
        <div className="container">
          <div className="home-about-grid">
            <Reveal>
              <span className="home-kicker">What is Cavopay</span>
              <h2 className="home-h2">A bank account built on stablecoins</h2>
              <p className="home-body">
                Cavopay gives you a payment account for digital dollars and euros. Behind the scenes your
                money lives in Circle-backed wallets on the Arc network — a blockchain built by the issuer
                of USDC for payments. In front, it feels like any modern banking app.
              </p>
              <p className="home-body">
                You hold real USDC and EURC, the world&rsquo;s largest regulated stablecoins. You move them by
                username, link or QR. You swap between currencies instantly. And soon, you put idle balances
                to work — all without touching a seed phrase or paying unpredictable gas fees.
              </p>
            </Reveal>
            <div className="home-stats-grid">
              {STATS.map((stat, index) => (
                <Reveal key={stat.label} delay={index * 70}>
                  <div className="stat-card">
                    <span className="stat-icon">{stat.icon}</span>
                    <strong>{stat.value}</strong>
                    <span className="stat-label">{stat.label}</span>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="home-section home-section-tint">
        <div className="container">
          <Reveal className="home-center">
            <span className="home-kicker">Everything in one app</span>
            <h2 className="home-h2">Four things your money should do. One place to do it.</h2>
          </Reveal>
          <div className="home-feature-grid">
            {CORE_FEATURES.map((feature, index) => (
              <Reveal key={feature.title} delay={index * 80}>
                <div className="feature-card">
                  <span className="feature-icon">{feature.icon}</span>
                  <div className="feature-title">{feature.title}</div>
                  <p className="feature-desc">{feature.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="home-section">
        <div className="container">
          <Reveal className="home-center">
            <span className="home-kicker">Why Cavopay</span>
            <h2 className="home-h2">Crypto money, without the crypto headaches</h2>
          </Reveal>
          <div className="home-why-grid">
            {WHY_POINTS.map((point, index) => (
              <Reveal key={point.title} delay={(index % 3) * 70}>
                <div className="why-item">
                  <span className="why-icon">{point.icon}</span>
                  <div>
                    <div className="why-title">{point.title}</div>
                    <p className="why-desc">{point.desc}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="home-section home-section-tint">
        <div className="container">
          <Reveal className="home-center">
            <span className="home-kicker">How it works</span>
            <h2 className="home-h2">Up and running in three steps</h2>
          </Reveal>
          <div className="hiw-grid">
            {STEPS.map((step, index) => (
              <Reveal key={step.title} delay={index * 80}>
                <div className="hiw-card card">
                  <div className="hiw-icon">{step.icon}</div>
                  <h3 className="hiw-title">{step.title}</h3>
                  <p className="hiw-desc">{step.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="cta-section">
        <div className="container">
          <Reveal>
            <div className="cta-card">
              <h2 className="cta-title">Your stablecoin account is one sign-in away</h2>
              <p className="cta-desc">Create your Cavopay wallet, claim your @username, and start moving money in seconds.</p>
              {!isLoggedIn ? (
                <WalletButton className="btn-lg" />
              ) : (
                <Link to="/dashboard" className="btn btn-primary btn-lg">
                  Open Dashboard <ArrowRight size={18} />
                </Link>
              )}
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="footer">
        <div className="container footer-inner">
          <div className="footer-left">
            <img src="/cavopay-logo.png" alt="Cavopay" style={{ width: 24, height: 24, borderRadius: 6, marginRight: 8 }} />
            <span style={{ fontWeight: 600, color: 'var(--ink)' }}>Cavopay</span>
          </div>
          <div className="footer-right">
            Built on <a href="https://arc.network" target="_blank" rel="noopener noreferrer">Arc Network</a>
            {' - '}
            <a href="https://testnet.arcscan.app" target="_blank" rel="noopener noreferrer">Explorer</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
