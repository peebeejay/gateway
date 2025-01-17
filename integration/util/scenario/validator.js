const util = require('util');
const child_process = require('child_process');
const { genPort, getInfoKey } = require('../util');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { canConnectTo } = require('../net');
const { instantiateInfo } = require('./scen_info');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const chalk = require('chalk');

async function loadTypes(ctx, version) {
  let contents = await fs.readFile(ctx.__typesFile(version));
  try {
    return {
      ...JSON.parse(contents),
      ...ctx.__types()
    };
  } catch (e) {
    let match = /in JSON at position (\d+)/.exec(e.message);
    if (match) {
      let pos = Number(match[1]);
      let show = (start, end) => contents.slice(start, end).toString().replaceAll("\n", "\\n");
      let colored =
          chalk.green(show(pos - 20, pos)) +
          chalk.red(show(pos, pos + 1)) +
          chalk.green(show(pos + 1, pos + 20));

      ctx.error("JSON Error Around: \n" + chalk.bgWhiteBright(colored));
      throw new Error(`Error Parsing \`types.json\`: ${e.toString()} [around \`${colored}\`]`);
    } else {
      throw new Error(`Error Parsing \`types.json\`: ${e.toString()}`);
    }
  }
}

async function loadRpc(ctx) {
  // TODO: Handle versioning
  let contents = await fs.readFile(ctx.__rpcFile());
  try {
    return JSON.parse(contents);
  } catch (e) {
    let match = /in JSON at position (\d+)/.exec(e.message);
    if (match) {
      let pos = Number(match[1]);
      let show = (start, end) => contents.slice(start, end).toString().replaceAll("\n", "\\n");
      let colored =
          chalk.green(show(pos - 20, pos)) +
          chalk.red(show(pos, pos + 1)) +
          chalk.green(show(pos + 1, pos + 20));

      ctx.error("JSON Error Around: \n" + chalk.bgWhiteBright(colored));
      throw new Error(`Error Parsing \`rpc.json\`: ${e.toString()} [around \`${colored}\`]`);
    } else {
      throw new Error(`Error Parsing \`rpc.json\`: ${e.toString()}`);
    }
  }
}

let validatorInfoMap = {
  'alice': {
    aura_key: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    grandpa_key: "5FA9nQDVg267DEd8m1ZypXLBnvN7SFxYwV7ndqSYGiN9TTpu",
    eth_private_key: "50f05592dc31bfc65a77c4cc80f2764ba8f9a7cce29c94a51fe2d70cb5599374",
    eth_account: "0x6a72a2f14577D9Cd0167801EFDd54a07B40d2b61",
    node_key: '0x0000000000000000000000000000000000000000000000000000000000000001',
    peer_id: '12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp', // I have _no idea_ how this is generated (I just run a node with the node key and grab it)
    spawn_args: ['--alice'],
    color: chalk.blue,
    validator: true,
  },
  'bob': {
    aura_key: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
    grandpa_key: "5GoNkf6WdbxCFnPdAnYYQyCjAKPJgLNxXwPjwTh6DGg6gN3E",
    eth_private_key: "6bc5ea78f041146e38233f5bc29c703c1cec8eaaa2214353ee8adf7fc598f23d",
    eth_account: "0x8AD1b2918C34EE5d3E881A57c68574EA9dbEcB81",
    node_key: '0x0000000000000000000000000000000000000000000000000000000000000002',
    peer_id: '12D3KooWHdiAxVd8uMQR1hGWXccidmfCwLqcMpGwR6QcTP6QRMuD', // I have _no idea_ how this is generated
    spawn_args: ['--bob'],
    color: chalk.green,
    validator: true,
  },
  'charlie': {
    aura_key: "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y",
    grandpa_key: "5DbKjhNLpqX3zqZdNBc9BGb4fHU1cRBaDhJUskrvkwfraDi6",
    eth_private_key: "46848fdbde39184417f511187ebc87e12e3087ac67c630e18836a6813110310d",
    eth_account: "0x714fea791A402f28BFB43B07f6C9A70482A8cF90",
    node_key: '0x0000000000000000000000000000000000000000000000000000000000000003',
    peer_id: '12D3KooWSCufgHzV4fCwRijfH2k3abrpAJxTKxEvN1FDuRXA2U9x', // I have _no idea_ how this is generated
    spawn_args: ['--charlie'],
    color: chalk.orange,
    validator: true,
  }
};

// TODO: Standardize
async function tmpFile(name) {
  folder = await fs.mkdtemp(path.join(os.tmpdir()));
  return path.join(folder, name);
}

class Validator {
  constructor(ctx, name, info, rpcPort, p2pPort, wsPort, nodeKey, peerId, logLevel, spawnOpts, extraArgs, validatorArgs, ethPrivateKey, ethAccount, version, extraVersions, chainSpecFile) {
    this.ctx = ctx;
    this.name = name;
    this.info = info;
    this.rpcPort = rpcPort;
    this.p2pPort = p2pPort;
    this.wsPort = wsPort;
    this.nodeKey = nodeKey;
    this.peerId = peerId;
    this.logLevel = logLevel;
    this.spawnOpts = spawnOpts;
    this.extraArgs = extraArgs;
    this.validatorArgs = validatorArgs;
    this.ethPrivateKey = ethPrivateKey;
    this.ethAccount = ethAccount;
    this.version = version;
    this.extraVersions = extraVersions;
    this.chainSpecFile = chainSpecFile;
    this.wsProvider = null;
    this.api = null;
    this.ps = null;
    this.bootnodes = null;
    this.freezeTimeFile = null;
  }

  async currentTime() {
    return (await this.api.query.cash.lastBlockTimestamp()).toJSON();
  }

  async freezeTime(time) {
    if (!this.freezeTimeFile) {
      throw new Error(`Freeze time not set`);
    }
    await fs.writeFile(this.freezeTimeFile, time.toString());
  }

  async accelerateTime(interval) {
    if (!this.freezeTimeFile) {
      throw new Error(`Freeze time not set`);
    }
    let currentTimeStr = await fs.readFile(this.freezeTimeFile, 'utf8');
    let currentTime = Number(currentTimeStr);
    if (Number.isNaN(currentTime)) {
      throw new Error(`Invalid current time: ${currentTimeStr}`);
    }
    if (currentTime === 0) {
      throw new Error(`Cannot accelerate zero time`);
    }
    await this.freezeTime(currentTime + interval);

    return currentTime + interval;
  }

  asPeer() {
    // Note: we assume loopback address
    return `/ip4/127.0.0.1/tcp/${this.p2pPort}/p2p/${this.peerId}`;
  }

  colorize(text) {
    if (typeof(this.info['color']) === 'function') {
      return this.info['color'](text);
    } else {
      return text;
    }
  }

  async start(peers=[]) {
    this.bootnodes = peers.map((peer) => {
      return ['--reserved-nodes', peer];
    }).flat();

    let env = {
      ...this.spawnOpts,
      ETH_KEY: this.ethPrivateKey,
    };

    let versioning = [];
    if (this.version) {
      versioning = [
        "--wasm-runtime-overrides",
        this.version.releasePath(),
      ];
    }

    let executionArgs = [];
    if (this.ctx.__native()) {
      // TODO: Consider setting native versions better per node
      executionArgs = ['--execution', 'Native'];
    } else {
      // Scen did not specify execution. Only force WASM if we're on a non-current version
      if (!this.version.isCurr()) {
        executionArgs = ['--execution', 'Wasm'];
      }
    }

    if (this.ctx.__freezeTime()) {
      this.freezeTimeFile = await tmpFile("freeze_time.txt");;
      await fs.writeFile(this.freezeTimeFile, this.ctx.__freezeTime().toString());
      env.FREEZE_TIME = this.freezeTimeFile;
    }

    this.ctx.log(`Validator Env: ${JSON.stringify(env)}`);

    let newCliArgs = [];
    if (this.version.supportsNewCliArgs()) {
      newCliArgs = [
        '--eth-rpc-url', this.ctx.eth.web3Url,
        '--eth-key-id', "my_eth_key_id",
        '--miner', `Eth:${this.ethAccount}`,
        '--opf-url', this.ctx.__opfUrl(),
      ];
    } else {
      env['ETH_RPC_URL'] = this.ctx.eth.web3Url;
      env['ETH_KEY_ID'] = "my_eth_key_id";
      env['MINER'] = `Eth:${this.ethAccount}`;
      env['OPF_URL'] = this.ctx.__opfUrl();
    }

    let ps = spawnValidator(this.ctx, this.colorize(this.name), [
      '--chain',
      this.chainSpecFile,
      '--rpc-methods',
      'Unsafe',
      '--rpc-port',
      this.rpcPort,
      '--ws-port',
      this.wsPort,
      '--port',
      this.p2pPort,
      '--tmp',
      '--no-mdns',
      '--node-key',
      this.nodeKey,
      ...newCliArgs,
      '-lruntime=debug,gateway=debug,pallet_cash=debug,ethereum_client=debug',
      '--reserved-only',
      ...versioning,
      ...executionArgs,
      ...this.bootnodes,
      ...this.extraArgs,
      ...this.validatorArgs
    ], { env });

    process.on('exit', () => {
      ps.kill('SIGTERM'); // No matter what, always kill gateway node
    });

    ps.on('error', (err) => {
      this.ctx.__abort(`Failed to spawn validator: ${err}`);
    });

    ps.on('close', (code) => {
      this.ctx.log(`Validator terminated, code=${code}`);
      if (code !== 0) {
        if (this.ctx.__linkValidator()) {
          this.ctx.__abort(`Validator failed unexpectedly with code ${code}`);
        }
      }
    });

    // TODO: Should we make awaiting optional? We could also spawn multiple at the
    //       same time, since this isn't order dependent.
    await this.ctx.until(() => canConnectTo('localhost', this.wsPort), {
      retries: 50,
      message: `Awaiting websocket for validator ${this.name} on port ${this.wsPort}...`
    });

    this.ps = ps;
    await this.buildApi();
  }

  async buildApi() {
    const wsProvider = new WsProvider(`ws://localhost:${this.wsPort}`);
    let types = await loadTypes(this.ctx, this.version);
    for (let version of this.extraVersions) {
      types = {
        ...types,
        ...await loadTypes(this.ctx, version)
      };
    }
    const api = await ApiPromise.create({
      provider: wsProvider,
      types,
      rpc: await loadRpc(this.ctx)
    });

    this.api = api;
    this.wsProvider = wsProvider;
  }

  async setVersion(version) {
    this.version = version;
    this.extraVersions = [];
    await this.teardownApi();
    await this.buildApi();

    // Note: this was the other approach, which didn't seem to have any effect
    // this.api.registry.register(await loadTypes(this.ctx, version));
  }

  async teardownApi() {
    if (this.api) {
      await this.api.disconnect(); // Disconnect from api
      this.api = null;
    }
  }

  async teardown() {
    this.teardownApi();

    if (this.ps) {
      this.ps.kill('SIGTERM'); // Kill gateway node
      this.ps = null;
    }
  }
}

class Validators {
  constructor(validators, ctx) {
    this.validators = validators;
    this.ctx = ctx;
  }

  all() {
    return this.validators;
  }

  count() {
    return this.validators.length;
  }

  quorum() {
    return Math.ceil(this.count() * 2 / 3);
  }

  first() {
    if (this.validators.length === 0) {
      throw new Error(`No validators for scenario`);
    } else {
      return this.validators[0];
    }
  }

  api() {
    return this.first().api;
  }

  tryApi() {
    return this.count() > 0 ? this.api() : null;
  }

  get(name) {
    let validator = this.validators.find((validator) => validator.name === name);
    if (!validator) {
      throw new Error(`Unknown validator for scenario: ${name}`);
    } else {
      return validator;
    }
  }

  async start() {
    let peers = this.validators.map((validator) => validator.asPeer());
    await Promise.all(this.validators.map((validator) => validator.start(peers)));
  }

  async addValidator(name, validatorInfo) {
    let newValidator = buildValidator(name, validatorInfo, this.ctx);
    await Promise.all(this.all().map((validator) => validator.api.rpc.system.addReservedPeer(newValidator.asPeer())));
    let existingPeers = this.validators.map((validator) => validator.asPeer());
    await newValidator.start(existingPeers);
    this.validators.push(newValidator);
    return newValidator;
  }

  async teardown() {
    await Promise.all(this.validators.map(async (validator) => {
      await validator.teardown();
    }));
  }
}

function spawnValidator(ctx, name, args = [], opts = {}) {
  ctx.log(`Starting validator node ${ctx.__target()} with args ${JSON.stringify(args)}`)

  let proc = child_process.spawn(ctx.__target(), args, opts);

  proc.stdout.on('data', (data) => {
    ctx.log(`${name} [stdout]: ${data}`);
  });

  proc.stderr.on('data', (data) => {
    ctx.error(`${name} [stdout]: ${data}`);
  });

  proc.on('close', (code) => {
    ctx.log(`${name} child process exited with code ${code}`);
  });

  return proc;
}

function buildValidator(validatorName, validatorInfo, ctx) {
  ctx.log(`Starting Validator ${validatorName}...`);

  let rpcPort = validatorInfo.rpc_port || genPort();
  let p2pPort = validatorInfo.p2p_port || genPort();
  let wsPort = validatorInfo.ws_port || genPort();
  let nodeKey = getInfoKey(validatorInfo, 'node_key', `validator ${validatorName}`);
  let peerId = getInfoKey(validatorInfo, 'peer_id', `validator ${validatorName}`);

  let logLevel = ctx.__logLevel();
  let spawnOpts = logLevel !== 'info' ? { RUST_LOG: logLevel } : {};
  let extraArgs = logLevel !== 'info' ? [`-lruntime=${logLevel}`] : [];
  let validatorArgs = validatorInfo.spawn_args || [];

  let ethPrivateKey = getInfoKey(validatorInfo, 'eth_private_key', `validator ${validatorName}`);
  let ethAccount = getInfoKey(validatorInfo, 'eth_account', `validator ${validatorName}`);
  if (!ctx.chainSpec) {
    throw new Error(`Must initialize chain spec before starting validator`);
  }

  let version = validatorInfo.version ? ctx.versions.mustFind(validatorInfo.version) : null;
  let extraVersions = validatorInfo.extraVersions ? validatorInfo.extraVersions.map((version) => ctx.versions.mustFind(version)) : [];
  let chainSpecFile = ctx.chainSpec.file();

  return new Validator(ctx, validatorName, validatorInfo, rpcPort, p2pPort, wsPort, nodeKey, peerId, logLevel, spawnOpts, extraArgs, validatorArgs, ethPrivateKey, ethAccount, version, extraVersions, chainSpecFile);
}

async function getValidatorsInfo(validatorsInfoHash, ctx) {
  return await instantiateInfo(validatorsInfoHash, 'Validator', 'name', validatorInfoMap);
}

async function buildValidators(validatorsInfoHash, ctx) {
  ctx.log("Starting Validators...");

  let validatorsInfo = await getValidatorsInfo(validatorsInfoHash, ctx);
  let validatorsList = await validatorsInfo.map(([validatorName, validatorInfo]) =>
    buildValidator(validatorName, validatorInfo, ctx));

  let validators = new Validators(validatorsList, ctx);
  await validators.start();

  validators.validatorInfoMap = validatorInfoMap;
  return validators;
}

module.exports = {
  getValidatorsInfo,
  buildValidator,
  buildValidators,
  Validator,
  Validators,
};
