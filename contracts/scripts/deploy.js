const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Cavo with account:", deployer.address);

  const network = await ethers.provider.getNetwork();
  console.log("Network chainId:", network.chainId.toString());

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatUnits(balance, 18));

  // Mainnet deployments MUST set these env vars (defaults are Arc TESTNET).
  // Use a multisig/treasury address for FEE_WALLET in production.
  const FEE_WALLET = process.env.FEE_WALLET || deployer.address;
  const FEE_BPS = Number(process.env.FEE_BPS || 50); // 0.5%
  const USDC_ADDRESS =
    process.env.ARC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
  const EURC_ADDRESS =
    process.env.ARC_EURC_ADDRESS || "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
  const EXPLORER = process.env.ARC_EXPLORER_URL || "https://testnet.arcscan.app";

  const Cavo = await ethers.getContractFactory("Cavo");
  const cavo = await Cavo.deploy(FEE_WALLET, FEE_BPS, USDC_ADDRESS, EURC_ADDRESS);
  await cavo.waitForDeployment();

  const address = await cavo.getAddress();
  console.log("Cavo deployed to:", address);
  console.log("   Fee wallet:", FEE_WALLET);
  console.log("   Fee:", FEE_BPS, "bps");
  console.log("   USDC:", USDC_ADDRESS);
  console.log("   EURC:", EURC_ADDRESS);
  console.log("   View on explorer: " + EXPLORER + "/address/" + address);

  // Write address to a file for frontend to import
  const fs = require("fs");
  const deployInfo = {
    address,
    feeWallet: FEE_WALLET,
    feeBps: FEE_BPS,
    usdc: USDC_ADDRESS,
    eurc: EURC_ADDRESS,
    network: network.name,
    chainId: network.chainId.toString(),
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    "./deployment.json",
    JSON.stringify(deployInfo, null, 2)
  );
  console.log("Deployment info saved to deployment.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
