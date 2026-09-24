# Cavo — Stablecoin Neobank & Payment Account on Arc

> **Settlement Network**: Arc Testnet  
> **Core Assets**: USDC & EURC  

Cavo is a stablecoin-native payment account on Arc that lets users, creators, freelancers, and small businesses send, receive, and manage USDC and EURC through usernames, payment links, QR codes, and Circle-powered in-app wallets.

---

## Key Features

- **Web2 Onboarding**: Sign in with Google Auth or Email OTP — no seed phrases or web3 browser extensions required.
- **Circle In-App Wallets**: Automatic developer-controlled wallet creation for every user.
- **Public `@username` Handles**: Claimable payment handles (e.g. `/u/alex`) for easy stablecoin transfers.
- **Payment Links & QR Checkout**: Sharable checkout links (`/pay/:linkId`) and QR codes for one-off and service payments.
- **In-App Transfers & PIN Security**: Send USDC/EURC directly to usernames or wallet addresses, protected by a 4-digit Payment PIN.
- **Arc Settlement**: Fast finality and USDC-denominated gas powered by Arc Testnet.
- **Cross-Chain Bridge**: Circle App Kit & CCTP integration to bridge USDC from external networks.

---

## Technology Stack

- **Frontend**: React 19, Vite, TypeScript, React Router, Wagmi, Viem, Lucide Icons, QR rendering.
- **Backend**: Node.js, Express, Supabase (PostgreSQL with RLS), Circle Developer Wallet SDK.
- **Smart Contracts**: Solidity, Hardhat, OpenZeppelin payment settlement contracts.

---

## Local Setup & Development

### 1. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

### 2. Backend Setup
```bash
cd backend
npm install
npm run dev
```

### 3. Smart Contracts
```bash
cd contracts
npm install
npx hardhat compile
```

---

## License

MIT License
