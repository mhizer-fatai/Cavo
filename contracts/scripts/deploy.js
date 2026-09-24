const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Cavo with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatUnits(balance, 18), "USDC");

  // Fee wallet = deployer by default (change before production)
  const FEE_WALLET = deployer.address;
  const FEE_BPS = 50; // 0.5%

  const Cavo = await ethers.getContractFactory("Cavo");
  const payMe = await Cavo.deploy(FEE_WALLET, FEE_BPS);
  await payMe.waitForDeployment();

  const address = await payMe.getAddress();
  console.log("Cavo deployed to:", address);
  console.log("   Fee wallet:", FEE_WALLET);
  console.log("   Fee:", FEE_BPS, "bps (0.5%)");
  console.log("   View on explorer: https://testnet.arcscan.app/address/" + address);

  // Write address to a file for frontend to import
  const fs = require("fs");
  const deployInfo = {
    address,
    feeWallet: FEE_WALLET,
    feeBps: FEE_BPS,
    network: "arc_testnet",
    chainId: 5042002,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    "./deployment.json",
    JSON.stringify(deployInfo, null, 2)
  );
  console.log("📄 Deployment info saved to deployment.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
