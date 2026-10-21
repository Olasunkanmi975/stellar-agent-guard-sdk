# Custom Account Signing

Soroban Custom Accounts implement the `CustomAccountInterface`. The contract itself is the address authorizing transactions.

Standard wallets sign transaction envelopes for public key accounts (`G...`). For a custom account (`C...`), the transaction requires a `SorobanAuthorizationEntry` with `AddressCredentials` containing a signature valid for the contract's registered agent key.

The SDK's `invoke()` pipeline manages:
1. Probe simulation to detect necessary authorization entries.
2. Building `SorobanAuthorizationEntry` credentials.
3. Signing auth entries with the agent's signer.
4. Second simulation with attached credentials.
5. Final envelope signing with fee-source keypair and submission.

## The signer seam

Step 3 signs the 32-byte digest the host hands `__check_auth`, and the SDK
depends on that boundary rather than on a concrete key type:

```ts
interface AgentSigner {
  readonly publicKey: string;
  signDigest(digest: Uint8Array): Uint8Array | Promise<Uint8Array>;
}
```

A plain `Keypair` is accepted anywhere an `AgentSigner` is (`PreFlightConfig.agent`,
`GuardAuthorization.agent`, `buildGuardAuthEntry({ signer })`) and is wrapped
automatically — `keypairAgentSigner` / `toAgentSigner` — so single-key callers
are unchanged. This is the seam multi-key agent signing will use when the
contracts repo's v2 decision lands; see
[Multi-Key Agent Signing](multi-key-agent-signing.md).

## Validating the signer identity

The SDK validates `AgentSigner.publicKey` before it is ever used. Two verify-only
forms are supported:

- the registered account StrKey, `G…`, including its version byte and checksum;
- the raw 32-byte Ed25519 public key encoded as 64 hexadecimal characters (the
  form the guard contract stores). A hex key is normalised to its equivalent
  `G…` StrKey for diagnostics.

Validation runs when a signer is adapted (`keypairAgentSigner` / `toAgentSigner`)
and again at the signing boundary (`buildGuardAuthEntry`, and before any RPC in
`enforceCall`). A bad configuration therefore fails with a `SigningError` naming
`signer.publicKey`, before the signer is invoked or a simulation is made, rather
than surfacing later as an opaque `__check_auth` failure.

Secret seeds (`S…`) are explicitly rejected and are never used to derive a
public key. Supply the public identity only; a local `Keypair` still works by
being wrapped, and the `AgentSigner` it produces exposes just the public key
and a `signDigest` function.

```ts
import { Keypair, keypairAgentSigner, validateAgentPublicKey } from "stellar-agent-guard-sdk";

const local = keypairAgentSigner(Keypair.random()); // validated at construction
validateAgentPublicKey(local.publicKey);             // returns the G… form
validateAgentPublicKey(local.publicKey.slice(0, -1) + "A"); // throws SigningError
```

## Operator Runbook: Agent Key Rotation and Recovery

This runbook outlines the procedure for rotating the agent key of a custom account
and recovering from rotation failures. Follow these steps to minimize downtime
and ensure the guard's policy remains enforceable.

### Pre-Rotation Checks

1. **Verify current agent key**: Confirm the current agent key authorized in the
   guard contract matches the key used by your integration.
2. **Check guard policy**: Ensure the guard contract is not paused and that the
   policy allows the rotation transaction (typically a policy update call).
3. **Prepare new agent key**: Generate a new key pair (or use an existing key) and
   record its public key. The SDK does not store secret keys; you must manage
   the secret key securely outside the SDK.
4. **Test connectivity**: Verify that the Soroban RPC endpoint is reachable and
   that you can submit transactions with the current agent key.

### Dry-Run

Perform a dry-run to validate the rotation transaction without broadcasting:

1. Use the SDK's `invoke()` with `dryRun: true` to simulate the policy update
   that sets the new agent key.
2. Inspect the returned simulation events to ensure the transaction would be
   `admissible` (not blocked or undetermined).
3. Confirm that the resource fee is within expected bounds.

### Submission

Submit the key rotation transaction:

1. Invoke the guard contract's function to update the agent key (typically
   `set_agents` or similar, depending on the contract's interface).
2. Use the current agent key to sign the authorization entries for this
   invocation.
3. Submit the transaction via the SDK's `invoke()` function.

### Post-Rotation Verification

After submission, verify the rotation succeeded:

1. **Check transaction status**: Ensure the transaction succeeded on the ledger
   (not failed due to insufficient fees, etc.).
2. **Verify new agent key**: Call the guard contract's `agents()` viewer (or
   equivalent) to confirm the new agent key is now authorized.
3. **Test a harmless operation**: Use the SDK to perform a read-only or
   low-risk operation (e.g., `balance` call) to confirm the new agent key can
   sign auth entries successfully.

### Rollback and Recovery Limits

If the rotation transaction fails or the new agent key does not work as expected:

1. **Do not retry immediately**: A failed rotation may indicate a policy issue
   or network problem. Investigate before retrying.
2. **Rollback procedure**: If the guard contract supports it, submit a
   transaction to restore the previous agent key using the same process.
   Note: Some guard contracts may not allow reverting to a previous key; in
   such cases, you must continue with the new key or follow the contract's
   key management procedure.
3. **Recovery limits**: The SDK does not enforce limits on rotation attempts,
   but be aware of the guard contract's own limits (e.g., rate limits, nonce
   requirements). Excessive failed attempts may temporarily lock the account
   due to nonce increments or policy restrictions.
4. **Operator intervention**: If repeated failures occur, consult the guard
   contract's documentation or contact the contract deployer for assistance.

### Important Security Notes

- The SDK **never reads or stores secret keys**. Secret keys must be managed
  by the caller and provided only when signing (via the `AgentSigner`
  interface).
- Always inject the signer safely: never hardcode secret keys in source code;
  use environment variables, secret managers, or hardware security modules.
- The SDK only uses the public key for verification and the `signDigest`
  method for signing; it does not retain the secret key beyond the signing
  operation.

