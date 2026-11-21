-- Principal dApp, schema 0008: serves the reads that filter events by contract and topic (the alert check, the oracle page).
create index if not exists events_network_contract_topic on events (network, contract_id, topic, ledger desc);
