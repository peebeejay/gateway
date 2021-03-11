use std::marker::PhantomData;
use std::sync::Arc;
use serde::{Deserialize, Serialize};

use jsonrpc_core::{Error as RpcError, ErrorCode as RpcErrorCode, Result as RpcResult};
use jsonrpc_derive::rpc;

use sp_api::ProvideRuntimeApi;
use sp_blockchain::HeaderBackend;
use sp_runtime::{generic::BlockId, traits::Block as BlockT};

use pallet_cash::{
    chains::{ChainAccount, ChainAsset},
    rates::APR,
    reason::Reason,
    types::{AssetAmount, AssetBalance, AssetInfo},
};
use pallet_cash_runtime_api::CashApi as CashRuntimeApi;
use pallet_oracle::types::AssetPrice;

const RUNTIME_ERROR: i64 = 1;
const CHAIN_ERROR: i64 = 2;

// Note: no 128 bit integers for the moment
//  due to issues with serde/serde_json
pub type ApiAssetAmount = u64;
pub type ApiAssetBalance = i64;
pub type ApiAssetPrice = u64;
pub type ApiAPR = u64;
pub type ApiFactor = u64;
pub type ApiRates = (ApiAPR, ApiAPR);

#[derive(Deserialize, Serialize)]
pub struct ApiAssetData {
    asset: ChainAsset,
    balance: ApiAssetBalance,
    total_supply: ApiAssetAmount,
    total_borrow: ApiAssetAmount,
    supply_rate: ApiAPR,
    borrow_rate: ApiAPR,
    liquidity_factor: ApiFactor,
    price: ApiAssetPrice
}

/// Converts a runtime trap into an RPC error.
fn runtime_err(err: impl std::fmt::Debug) -> RpcError {
    RpcError {
        code: RpcErrorCode::ServerError(RUNTIME_ERROR),
        message: "Runtime trapped".into(),
        data: Some(format!("{:?}", err).into()),
    }
}

/// Converts a chain failure into an RPC error.
fn chain_err(reason: Reason) -> RpcError {
    RpcError {
        code: RpcErrorCode::ServerError(CHAIN_ERROR),
        message: "Chain error".into(),
        data: Some(format!("{:?}", reason).into()),
    }
}

#[rpc]
pub trait GatewayRpcApi<BlockHash> {
    #[rpc(name = "get_liquidity")]
    fn get_liquidity(
        &self,
        account: ChainAccount,
        at: Option<BlockHash>,
    ) -> RpcResult<ApiAssetBalance>;

    #[rpc(name = "get_price")]
    fn get_price(&self, ticker: String, at: Option<BlockHash>) -> RpcResult<ApiAssetPrice>;

    #[rpc(name = "get_rates")]
    fn get_rates(&self, asset: ChainAsset, at: Option<BlockHash>) -> RpcResult<ApiRates>;

    #[rpc(name = "get_assetdata")]
    fn get_assetdata(&self, account: ChainAccount, assets: ChainAsset, at: Option<BlockHash>) -> RpcResult<ApiAssetData>;
}

pub struct GatewayRpcHandler<C, B> {
    client: Arc<C>,
    _block: PhantomData<B>,
}

impl<C, B> GatewayRpcHandler<C, B> {
    pub fn new(client: Arc<C>) -> Self {
        Self {
            client,
            _block: Default::default(),
        }
    }
}

impl<C, B> GatewayRpcApi<B::Hash> for GatewayRpcHandler<C, B>
where
    B: BlockT,
    C: 'static + Send + Sync + ProvideRuntimeApi<B> + HeaderBackend<B>,
    C::Api: CashRuntimeApi<B>,
{
    fn get_liquidity(
        &self,
        account: ChainAccount,
        at: Option<<B as BlockT>::Hash>,
    ) -> RpcResult<ApiAssetBalance> {
        let api = self.client.runtime_api();
        let at = BlockId::hash(at.unwrap_or_else(|| self.client.info().best_hash));
        let result: AssetBalance = api
            .get_liquidity(&at, account)
            .map_err(runtime_err)?
            .map_err(chain_err)?;
        Ok((result as ApiAssetBalance).into())
    }

    fn get_price(
        &self,
        ticker: String,
        at: Option<<B as BlockT>::Hash>,
    ) -> RpcResult<ApiAssetPrice> {
        let api = self.client.runtime_api();
        let at = BlockId::hash(at.unwrap_or_else(|| self.client.info().best_hash));
        let result: AssetPrice = api
            .get_price(&at, ticker)
            .map_err(runtime_err)?
            .map_err(chain_err)?;
        Ok((result as ApiAssetPrice).into()) // XXX try_into, or patch for 128?
    }

    fn get_rates(&self, asset: ChainAsset, at: Option<<B as BlockT>::Hash>) -> RpcResult<ApiRates> {
        let api = self.client.runtime_api();
        let at = BlockId::hash(at.unwrap_or_else(|| self.client.info().best_hash));
        let (borrow_rate, supply_rate): (APR, APR) = api
            .get_rates(&at, asset)
            .map_err(runtime_err)?
            .map_err(chain_err)?;
        Ok((borrow_rate.0 as ApiAPR, supply_rate.0 as ApiAPR)) // XXX try_into?
    }

    fn get_assetdata(&self, account: ChainAccount, asset: ChainAsset, at: Option<<B as BlockT>::Hash>) -> RpcResult<ApiAssetData> {
        let api = self.client.runtime_api();
        let at = BlockId::hash(at.unwrap_or_else(|| self.client.info().best_hash));
        let asset_info: AssetInfo = api
            .get_asset(&at, asset)
            .map_err(runtime_err)?
            .map_err(chain_err)?;

        let account_balance: AssetBalance = api
            .get_account_balance(&at, account, asset)
            .map_err(runtime_err)?
            .map_err(chain_err)?;

        let (total_borrow, total_supply): (AssetAmount, AssetAmount) = api
            .get_market_totals(&at, asset)
            .map_err(runtime_err)?
            .map_err(chain_err)?;

        let (borrow_rate, supply_rate): (APR, APR) = api
            .get_rates(&at, asset)
            .map_err(runtime_err)?
            .map_err(chain_err)?;

        let price: AssetPrice = api
            .get_price_with_ticker(&at, asset_info.ticker)
            .map_err(runtime_err)?
            .map_err(chain_err)?;


        Ok(
            ApiAssetData {
                asset: asset_info.asset,
                balance: (account_balance as ApiAssetBalance).into(),
                total_supply: total_supply as ApiAssetAmount,
                total_borrow: total_borrow as ApiAssetAmount,
                supply_rate: supply_rate.0 as ApiAPR,
                borrow_rate: borrow_rate.0 as ApiAPR,
                liquidity_factor: (asset_info.liquidity_factor.0 as ApiFactor),
                price: (price as ApiAssetPrice).into()
            }
        )
    }
}
