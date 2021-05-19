use crate::chains::Polygon;
use crate::{
    chains::{Chain, ChainBlock, ChainBlockNumber, ChainBlocks, ChainId, Ethereum},
    debug,
    reason::Reason,
    Config, MaticStarportAddress,
};
use codec::{Decode, Encode};
use ethereum_client::{EthereumBlock, EthereumClientError};
use frame_support::storage::StorageValue;
use our_std::RuntimeDebug;
use types_derive::Types;

/// Type for errors coming from event ingression.
#[derive(Copy, Clone, Eq, PartialEq, Encode, Decode, RuntimeDebug, Types)]
pub enum EventError {
    NoRpcUrl,
    NoStarportAddress,
    EthereumClientError(EthereumClientError),
    ErrorDecodingHex,
    PolygonClientError(EthereumClientError),
}

/// Fetch a block from the underlying chain.
pub fn fetch_chain_block<T: Config>(
    chain_id: ChainId,
    number: ChainBlockNumber,
) -> Result<ChainBlock, Reason> {
    match chain_id {
        ChainId::Reserved => Err(Reason::Unreachable),
        ChainId::Eth => Ok(fetch_eth_block(number).map(ChainBlock::Eth)?),
        ChainId::Matic => Ok(fetch_matic_block::<T>(number).map(ChainBlock::Matic)?),
        ChainId::Dot => Err(Reason::Unreachable),
    }
}

/// Fetch more blocks from the underlying chain.
pub fn fetch_chain_blocks<T: Config>(
    chain_id: ChainId,
    from: ChainBlockNumber,
    to: ChainBlockNumber,
) -> Result<ChainBlocks, Reason> {
    match chain_id {
        ChainId::Reserved => Err(Reason::Unreachable),
        ChainId::Eth => Ok(fetch_eth_blocks(from, to)?),
        ChainId::Matic => Ok(fetch_matic_blocks::<T>(from, to)?),
        ChainId::Dot => Err(Reason::Unreachable),
    }
}

/// Fetch a single block from the Etherum Starport.
fn fetch_eth_block(number: ChainBlockNumber) -> Result<EthereumBlock, EventError> {
    let eth_starport_address = runtime_interfaces::config_interface::get_eth_starport_address()
        .ok_or(EventError::NoStarportAddress)?;
    let eth_rpc_url = runtime_interfaces::validator_config_interface::get_eth_rpc_url()
        .ok_or(EventError::NoRpcUrl)?;
    let eth_block = ethereum_client::get_block(&eth_rpc_url, &eth_starport_address, number)
        .map_err(EventError::EthereumClientError)?;
    Ok(eth_block)
}

/// Fetch a single block from the Etherum Starport.
fn fetch_matic_block<T: Config>(number: ChainBlockNumber) -> Result<EthereumBlock, EventError> {
    let matic_starport_address =
        MaticStarportAddress::get().ok_or(EventError::NoStarportAddress)?;
    let matic_starport_address = <Polygon as Chain>::address_string(&matic_starport_address);
    let matic_rpc_url = runtime_interfaces::validator_config_interface::get_matic_rpc_url()
        .ok_or(EventError::NoRpcUrl)?;
    let matic_block = ethereum_client::get_block(&matic_rpc_url, &matic_starport_address, number)
        .map_err(EventError::PolygonClientError)?;
    Ok(matic_block)
}

/// Fetch blocks from the Ethereum Starport, return up to `slack` blocks to add to the event queue.
fn fetch_eth_blocks(
    from: ChainBlockNumber,
    to: ChainBlockNumber,
) -> Result<ChainBlocks, EventError> {
    debug!("Fetching Eth Blocks [{}-{}]", from, to);
    let mut acc: Vec<<Ethereum as Chain>::Block> = vec![];
    for block_number in from..to {
        match fetch_eth_block(block_number) {
            Ok(block) => {
                acc.push(block);
            }
            Err(EventError::EthereumClientError(EthereumClientError::NoResult)) => {
                break; // done
            }
            Err(err) => {
                return Err(err);
            }
        }
    }
    Ok(ChainBlocks::Eth(acc))
}

/// Fetch blocks from the Polygon Starport, return up to `slack` blocks to add to the event queue.
fn fetch_matic_blocks<T: Config>(
    from: ChainBlockNumber,
    to: ChainBlockNumber,
) -> Result<ChainBlocks, EventError> {
    debug!("Fetching Matic Blocks [{}-{}]", from, to);
    let mut acc: Vec<<Polygon as Chain>::Block> = vec![];
    for block_number in from..to {
        match fetch_matic_block::<T>(block_number) {
            Ok(block) => {
                acc.push(block);
            }
            Err(EventError::PolygonClientError(EthereumClientError::NoResult)) => {
                break; // done
            }
            Err(err) => {
                return Err(err);
            }
        }
    }
    Ok(ChainBlocks::Matic(acc))
}
