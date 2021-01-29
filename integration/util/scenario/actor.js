const { Keyring } = require('@polkadot/api');
const { getInfoKey } = require('../util');
const { instantiateInfo } = require('./scen_info');
const { sendAndWaitForEvents} = require('../substrate');
const { lookupBy } = require('../util');

class Actor {
  constructor(name, ethAddress, chainKey, ctx) {
    this.name = name;
    this.__ethAddress = ethAddress;
    this.chainKey = chainKey;
    this.ctx = ctx;
  }

  ethAddress() {
    if (!this.__ethAddress) {
      throw new Error(`Actor ${this.name} does not have a valid eth account`);
    }

    return this.__ethAddress;
  }

  toChainAccount() {
    return { Eth: this.ethAddress() };
  }

  toTrxArg() {
    return `eth:${this.ethAddress()}`;
  }

  async sign(data) {
    return await this.ctx.eth.sign(data, this);
  }

  async runTrxRequest(trxReq) {
    let sig = { Eth: await this.sign(trxReq) };
    let call = this.ctx.api().tx.cash.execTrxRequest(trxReq, sig);

    return await sendAndWaitForEvents(call, this.ctx.api(), false);
  }

  async ethBalance() {
    return await this.ctx.eth.ethBalance(this);
  }

  async tokenBalance(tokenLookup) {
    let token = this.ctx.tokens.get(tokenLookup);
    return await token.getBalance(this);
  }

  async chainBalance(tokenLookup) {
    let token = this.ctx.tokens.get(tokenLookup);
    let weiAmount = await this.ctx.api().query.cash.assetBalances(token.toChainAsset(), this.toChainAccount());
    return token.toTokenAmount(weiAmount);
  }

  async lock(collateral, amount) {
    return this.ctx.starport.lock(this, collateral, amount);
  }

  async extract(collateral, amount) {
    let token = this.ctx.tokens.get(collateral);
    let trxReq = this.ctx.generateTrxReq("extract", amount, token);

    return await this.runTrxRequest(trxReq);
  }

  async extractCash(amount) {
    let trxReq = this.ctx.generateTrxReq("extract-cash", amount);

    return await this.runTrxRequest(trxReq);
  }
}

class Actors {
  constructor(actors, keyring, ctx) {
    this.actors = actors;
    this.keyring = keyring;
    this.ctx = ctx;
  }

  all() {
    return this.actors;
  }

  get(lookup) {
    return lookupBy(Actor, 'name', this.actors, lookup);
  }
}

function actorInfoMap(keyring) {
  return {
    ashley: {
      key_uri: '//Alice'
    },
    bert: {
      key_uri: '//Bob'
    }
  };
}

async function buildActor(actorName, actorInfo, keyring, index, ctx) {
  let ethAddress = ctx.eth.accounts[index+1];
  let chainKey = keyring.addFromUri(getInfoKey(actorInfo, 'key_uri', `actor ${actorName}`))

  return new Actor(actorName, ethAddress, chainKey, ctx);
}

async function getActorsInfo(actorsInfoHash, keyring, ctx) {
  let actorInfoMap = actorInfo(keyring);

  if (Array.isArray(actorsInfoHash)) {
    return actorsInfoHash.map((t) => {
      if (typeof (t) === 'string') {
        if (!actorInfoMap[t]) {
          throw new Error(`Unknown Actor: ${t}`);
        } else {
          return [t, actorInfoMap[t]];
        }
      } else {
        let {
          name,
          ...restActor
        } = t;
        return [name, restActor];
      }
    });
  } else {
    return Object.entries(actorsInfoHash);
  }
}

async function buildActors(actorsInfoHash, defaultActor, ctx) {
  let keyring = new Keyring();

  let actorsInfo = await instantiateInfo(actorsInfoHash, 'Actor', 'name', actorInfoMap(keyring));
  let actors = await Promise.all(actorsInfo.map(([actorName, actorInfo], index) => {
    return buildActor(actorName, actorInfo, keyring, index, ctx);
  }));

  // TODO: Default actor
  return new Actors(actors, keyring, ctx);
}

module.exports = {
  Actor,
  Actors,
  buildActor,
  buildActors
};