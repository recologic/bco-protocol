# Biocoin (BCO) Smart Contracts

**Forest-backed token with elastic supply on TRON.**

Every BCO token represents 1 square meter of verified forest land. Supply expands when new forest deeds are registered and contracts when deeds are deactivated — maintaining a permanent 1:1 backing ratio enforced on-chain.

[![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?logo=solidity)](https://soliditylang.org/)
[![TRON](https://img.shields.io/badge/Network-TRON%20(TRC20)-FF0013?logo=tron)](https://tron.network/)
[![OpenZeppelin](https://img.shields.io/badge/OpenZeppelin-v5.6.1-4E5EE4?logo=openzeppelin)](https://openzeppelin.com/contracts/)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

---

## Deployed Contracts

**Network:** TRON Mainnet

| Contract | Address | Type |
|----------|---------|------|
| Biocoin (BCO) | [`TWyRGyikCy1TGkz9etJr8a3NDQcMx3F28p`](https://tronscan.org/#/contract/TWyRGyikCy1TGkz9etJr8a3NDQcMx3F28p) | Immutable |
| DeedRegistry | [`TPw2dKZcVwqCKDNCQbEwRory1xKqj6zSj1`](https://tronscan.org/#/contract/TPw2dKZcVwqCKDNCQbEwRory1xKqj6zSj1) | UUPS Proxy |
| BCOStaking | [`TLXMq6XnwCyS9z3B8tbuNA82JJfjUnDNFe`](https://tronscan.org/#/contract/TLXMq6XnwCyS9z3B8tbuNA82JJfjUnDNFe) | UUPS Proxy |
| TimelockController | [`TE3noaDjVaai57MZgZnRLK9dtDh1mxXPF1`](https://tronscan.org/#/contract/TE3noaDjVaai57MZgZnRLK9dtDh1mxXPF1) | Immutable |

All contracts are verified on TronScan with public source code.

---

## How It Works

```
                  ┌──────────────────┐
                  │  Biocoin (BCO)   │
                  │  TRC20 Token     │
                  │  IMMUTABLE       │
                  └──┬───────────┬───┘
                     │           │
        mint/burn    │           │
          ┌──────────┘           └──────────┐
          ▼                                 ▼
  ┌───────────────────┐          ┌───────────────────┐
  │  DeedRegistry     │          │  BCOStaking       │
  │  UUPS Proxy       │          │  UUPS Proxy       │
  │                   │          │                   │
  │  Registers forest │          │  Deposit BCO to   │
  │  deeds on-chain   │          │  earn rewards     │
  └───────────────────┘          └───────────────────┘
```

### Core Invariant

```
totalSupply() == totalActiveArea() * 1e18
```

Every BCO in circulation is backed by exactly 1 m² of registered forest. This invariant is enforced at the smart contract level and can be verified by anyone on-chain via `verifyInvariant()`.

### Token Lifecycle

```
Register Deed                              Deactivate Deed
─────────────                              ────────────────
Forest deed verified    ──►  BCO minted    Deed invalidated    ──►  BCO burned
5,000 m² of forest      ──►  5,000 BCO    Company buys BCO     ──►  Supply decreases
Area added to registry  ──►  Sent to       from market and      ──►  Area removed
                              treasury     approves burn              from registry
```

---

## Security

BCOToken is immutable — it cannot be upgraded, frozen, or seized. Holders have full self-custody. Admin transfer requires a 2-step process with 48h delay, and admin renouncement is permanently blocked. Upgrades to DeedRegistry and BCOStaking require a 72h timelock once supply exceeds 1M BCO.

See [SECURITY.md](SECURITY.md) for detailed security design and role architecture.

### Audit

Independent security audit by [CertiK](https://www.certik.com/) — pending.

Static analysis completed with zero critical, high, or medium findings (Slither, Mythril, Aderyn).

### Reporting Vulnerabilities

To report a vulnerability, contact **security@recologic.io**.

---

## Documentation

Detailed documentation is available in the contract source code via [NatSpec](https://docs.soliditylang.org/en/latest/natspec-format.html) comments. Every public function includes `@notice`, `@param`, and `@return` annotations.

- **Website:** [recologic.io](https://recologic.io)

---

## Development

```bash
git clone https://github.com/recologic/bco-protocol.git
cd bco-protocol
npm install
npx hardhat compile
npx hardhat test
```

---

## License

[MIT](LICENSE)

---

<p align="center">
  <strong>REcologic</strong> — Tokenizing forests. Preserving the future.
</p>
