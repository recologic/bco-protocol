# Security

## Reporting Vulnerabilities

To report a vulnerability, contact **security@recologic.io**. Do not open public issues for security reports.

## Design Principles

- **Immutable token** — BCOToken cannot be upgraded. Maximum trust for holders.
- **No freeze or seizure** — No address blocking, no confiscation. Full self-custody.
- **Admin renounce blocked** — `beginDefaultAdminTransfer(address(0))` always reverts. Governance can never be permanently lost.
- **2-step admin transfer (48h delay)** — Prevents accidental lockout and key compromise.
- **Progressive timelock (72h)** — Upgrades require TimelockController approval once supply exceeds 1M BCO.
- **Rate limiting** — Deed registration capped per day and per deed to prevent abuse.
- **On-chain proof of reserve** — `verifyInvariant()` is a public view function anyone can call.
- **On-chain issuer identity** — Company name, registration and country stored permanently on-chain.
- **Staker fund protection** — `excessBCO()` ensures admin can only recover tokens not committed to stakers.
- **Pull over push** — Stakers explicitly claim rewards. No auto-distribution.

## Standards

| Standard | Usage |
|----------|-------|
| EIP-20 | TRC20/ERC20 token |
| EIP-1822 | UUPS proxy pattern |
| EIP-2612 | Gasless approvals (permit) |
| EIP-1153 | Transient storage reentrancy guards |
| EIP-7572 | Contract metadata (`contractURI()`) |

## Roles

| Role | Contract | Permissions |
|------|----------|-------------|
| `DEFAULT_ADMIN_ROLE` | All | Manage roles, configure parameters |
| `MINTER_ROLE` | BCOToken | Mint tokens (DeedRegistry only) |
| `BURNER_ROLE` | BCOToken | Burn tokens (DeedRegistry only) |
| `PAUSER_ROLE` | All | Emergency pause/unpause |
| `UPGRADER_ROLE` | Registry, Staking | UUPS upgrades (via TimelockController) |
| `REGISTRAR_ROLE` | DeedRegistry | Register/deactivate deeds |
| `REWARD_MANAGER_ROLE` | BCOStaking | Manage reward periods |

## Audit

Independent security audit by [CertiK](https://www.certik.com/) — pending.

### Static Analysis

- **Slither** — 0 Critical / 0 High / 0 Medium
- **Mythril** — 0 issues
- **Aderyn** — 0 actionable findings
