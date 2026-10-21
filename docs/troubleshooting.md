# Troubleshooting

Common failure modes and resolutions when integrating the Stellar Agent Guard SDK.

## Simulation returns `undetermined`

The pre-flight interceptor could not conclusively evaluate the candidate action. Verify the Soroban RPC endpoint is reachable and that the target contract exists on the configured network.

## Authorization entries not signed

Ensure the invoke pipeline receives a valid agent key and that the custom account `__check_auth` policy admits the call. Blocked calls are rejected client-side before broadcast.

## No telemetry events emitted

Confirm the `GuardTelemetryListener` is subscribed before the invoke pipeline runs. Simulation diagnostics are only available during the pre-flight window.

## Agent Key Rotation and Recovery

See the [Agent Key Rotation and Recovery runbook](concepts/custom-account-signing.md#operator-runbook-agent-key-rotation-and-recovery) for procedures to rotate the agent key of a custom account and recover from rotation failures.
