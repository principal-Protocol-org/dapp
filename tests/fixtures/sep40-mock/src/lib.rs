//! A deployable SEP-40 price feed for the dApp's local pull-mode proof (spec 0004 D-22): the
//! `MockSep40Feed` of principal 24d980d `contracts/oracle_adapter/src/test.rs`, with the two SEP-40
//! types it uses from `contracts/oracle_adapter/src/lib.rs`, both copied verbatim (the types keep
//! their names and fields, so the XDR is the one the OracleAdapter's `Sep40Client` reads).
//!
//! `set_price` and `clear_price` take no authorization: anyone may set any price. It is a test
//! fixture for the local network only (`scripts/dev-stack/feed-oracle.sh` refuses any other).
#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

/// SEP-40's own asset discriminant (ecosystem/sep-0040.md) -- a feed may quote several assets
/// against one `base()`, so a pull must say which one.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum Sep40Asset {
    Stellar(Address),
    Other(Symbol),
}

/// SEP-40's own return shape, field-for-field: `price` scaled by the feed's own `decimals()`
/// (not necessarily this contract's convention -- `sync_from_feed` rescales), `timestamp` in
/// Unix seconds.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Sep40PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// Minimal SEP-40 feed, for `sync_from_feed` tests only: `set_price`/`clear_price` let a test
/// drive exactly what `lastprice()` returns, including `None` (no data for that asset).
#[contract]
pub struct MockSep40Feed;

#[soroban_sdk::contracttype]
enum MockKey {
    Decimals,
    Price(Sep40Asset),
}

#[contractimpl]
impl MockSep40Feed {
    pub fn initialize(env: Env, decimals: u32) {
        env.storage().instance().set(&MockKey::Decimals, &decimals);
    }

    pub fn set_price(env: Env, asset: Sep40Asset, price: i128, timestamp: u64) {
        env.storage()
            .instance()
            .set(&MockKey::Price(asset), &(price, timestamp));
    }

    pub fn clear_price(env: Env, asset: Sep40Asset) {
        env.storage().instance().remove(&MockKey::Price(asset));
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&MockKey::Decimals).unwrap()
    }

    pub fn lastprice(env: Env, asset: Sep40Asset) -> Option<Sep40PriceData> {
        env.storage()
            .instance()
            .get::<_, (i128, u64)>(&MockKey::Price(asset))
            .map(|(price, timestamp)| Sep40PriceData { price, timestamp })
    }
}
