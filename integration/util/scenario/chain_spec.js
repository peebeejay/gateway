const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const util = require('util');
const child_process = require('child_process');
const execFile = util.promisify(child_process.execFile);
const { merge } = require('../util');
const { getValidatorsInfo } = require('./validator');

class ChainSpec {
  constructor(chainSpecInfo, chainSpecFile, ctx) {
    this.chainSpecInfo = chainSpecInfo;
    this.chainSpecFile = chainSpecFile;
    this.ctx = ctx;
  }

  file() {
    return this.chainSpecFile;
  }
}

async function baseChainSpec(validatorsInfoHash, tokensInfoHash, ctx) {
  let tokens = ctx.tokens;
  if (!tokens) {
    throw new Error(`Tokens required to build chain spec`);
  }

  let validatorsInfo = await getValidatorsInfo(validatorsInfoHash, ctx);

  // aurakey == validator id, account id
  let session_args = validatorsInfo.map(([_, v]) => [v.aura_key, v.aura_key, {aura: v.aura_key, grandpa: v.grandpa_key}]);
  let validators = validatorsInfo.filter(([_, v]) => v.validator).map(([_, v]) => ({
      substrate_id: Array.from(ctx.actors.keyring.decodeAddress(v.aura_key)), // from ss58 str => byte array
      eth_address: v.eth_account
  }));

  let assets = tokens.all().map((token) => ({
    asset: `Eth:${token.ethAddress()}`,
    decimals: token.decimals,
    symbol: token.symbol.toUpperCase(),
    ticker: token.priceTicker,
    liquidity_factor: Math.floor(token.liquidityFactor * 1e18),
    rate_model: {
      Kink: {
        zero_rate: 0,
        kink_rate: 500,
        kink_utilization: 8000,
        full_rate: 2000
      }
    },
    miner_shares: 0,
    supply_cap: 0
  }));

  let initialYieldConfig = {};
  if (ctx.__initialYield() > 0) {
    initialYieldConfig = {
      cashYield: ctx.__initialYield(),
      lastYieldTimestamp: ctx.__initialYieldStartMS()
    };
  }

  let frameSystem = {};
  if (ctx.__genesisVersion()) {
    let version = ctx.versions.mustFind(ctx.__genesisVersion());
    frameSystem = {
      frameSystem: {
        code: await version.wasm()
      }
    };
  }

  let reporters = ctx.__reporters();

  return {
    name: 'Integration Test Network',
    properties: {
      eth_starport_address: ctx.starport.ethAddress(),
      eth_starport_parent_block: ctx.eth.blockInfo
    },
    genesis: {
      runtime: {
        ...frameSystem,
        palletCash: {
          assets,
          ...initialYieldConfig,
          validators,
        },
        palletSession: {
          keys: session_args
        },
        palletOracle: {
          reporters
        }
      }
    }
  };
}

async function tmpFile(name) {
  folder = await fs.mkdtemp(path.join(os.tmpdir()));
  return path.join(folder, name);
}

// TODO: Some things here probably need to be cleaned up
async function buildChainSpec(chainSpecInfo, validatorsInfoHash, tokenInfoHash, ctx) {
  let chainSpecFile = chainSpecInfo.use_temp ?
    await tmpFile('chainSpec.json') : path.join(__dirname, '..', '..', 'chainSpec.json');
  let target = ctx.__target();
  ctx.log('[CHAINSPEC] Scenario chain_spec.json: ' + chainSpecFile);
  let chainSpecJson;
  try {
    let { error, stdout, stderr } =
      await execFile(target, [
        "build-spec",
        "--disable-default-bootnode",
        "--chain",
        chainSpecInfo.base_chain
      ], { maxBuffer: 100 * 1024 * 1024 }); // 100MB
    chainSpecJson = stdout;
  } catch (e) {
    ctx.__abort(`Failed to spawn validator node. Try running \`cargo build --release\` (Missing ${target}, error=${e})`);
  }

  let originalChainSpec = JSON.parse(chainSpecJson);
  let standardChainSpec = await baseChainSpec(validatorsInfoHash, tokenInfoHash, ctx);
  let finalChainSpec = merge(merge(originalChainSpec, standardChainSpec), chainSpecInfo.props);
  await fs.writeFile(chainSpecFile, JSON.stringify(finalChainSpec, null, 2), 'utf8');

  return new ChainSpec(chainSpecInfo, chainSpecFile, ctx);
}

module.exports = {
  buildChainSpec,
  ChainSpec
};
