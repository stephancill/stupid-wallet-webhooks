/**
 * Landing page served at the root of https://wallet-webhooks.stupidtech.net.
 * Kept in the same minimal, no-CSS style as the rest of stupidtech.net. The
 * product API stays on the `/v1` (/operator) routes.
 */

export const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#111"/>
  <path d="M8 16l10-9 2 6h4l-10 10-3-6H8z" fill="#4ade80"/>
</svg>`;

export const siteHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stupid Wallet Webhooks</title>
  <meta property="og:title" content="Stupid Wallet Webhooks">
  <meta property="og:description" content="Signed webhooks for EVM address activity — top-level transactions, native value, and ERC-20 / ERC-721 transfers.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://wallet-webhooks.stupidtech.net">
  <meta property="og:site_name" content="Stupid Technology">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
  <h1>Stupid Wallet Webhooks</h1>

  <p>Signed webhooks for EVM address activity. Point us at an address, tell us which
  chains to watch, and get a cryptographically-signed <code>POST</code> whenever that
  address sends a transaction, moves native value, or is involved in an ERC-20 or
  ERC-721 transfer — so you can trust an event without having to replay it.</p>

  <h2>How it works</h2>
  <ol>
    <li><strong>Create a webhook.</strong> Give us an HTTPS endpoint; we return a one-time
        <code>signingSecret</code> so you can prove events came from us.</li>
    <li><strong>Subscribe an address.</strong> Choose the EVM address and chains (Ethereum,
        Base, Optimism, Arbitrum, …) to watch.</li>
    <li><strong>Get signed events.</strong> From its activation block onward, each matching
        transaction produces one event per address.</li>
    <li><strong>Verify and act.</strong> Dedupe on <code>webhook-id</code> and verify the
        HMAC signature, then trigger your own workflow.</li>
  </ol>

  <h2>What you get</h2>
  <table border="1">
    <thead><tr><th>Capability</th><th>Detail</th></tr></thead>
    <tbody>
      <tr><td>Verified deliveries</td>
          <td>HMAC-SHA256 signature over the exact event body
              (<code>webhook-signature: v1,&lt;hex&gt;</code>, ±5 min replay tolerance)</td></tr>
      <tr><td>Activity</td>
          <td>Top-level txs (incl. zero-value and reverted), incoming native value,
              ERC-20 and ERC-721 <code>Transfer</code>s</td></tr>
      <tr><td>Chains</td>
          <td>Ethereum, Base, Optimism, Arbitrum — more resolvable on request</td></tr>
      <tr><td>Idempotent</td>
          <td>Deterministic <code>webhook-id</code>; dedupe safely (at-least-once)</td></tr>
      <tr><td>Delivery ledger</td>
          <td>30-day history per webhook: every attempt, status, and outcome</td></tr>
    </tbody>
  </table>

  <h2>Example event</h2>
  <p>A signed delivery looks like this (hashes abbreviated):</p>
  <pre><code>{
  "id": "evt_2f3d…",
  "type": "activity.observed",
  "createdAt": "2026-08-30T14:16:35.000Z",
  "data": {
    "chainId": 8453,
    "trackedAddress": "0xa0bfe1a0fc5b83d16e8599fd…e405",
    "initiatedByTrackedAddress": true,
    "blockNumber": "50655024",
    "transaction": {
      "hash": "0x198a0a…698",
      "index": 139,
      "from": "0xa0bfe1a0fc5b83d16e8599fd…e405",
      "to": "0x00000000000000000000000000000000000dEaD",
      "status": "success",
      "value": "100000000000000"
    },
    "effects": []
  }
}</code></pre>
  <p>For an exchange of a token, <code>data.effects</code> carries the decoded
  <code>ERC-20</code> / <code>ERC-721</code> transfer with the asset, counterparty, and
  amount (token ids for ERC-721).</p>

  <h2>What we watch (and what we don't)</h2>
  <ul>
    <li>Every mined top-level transaction <em>from</em> the address (successful, reverted,
        or zero-value).</li>
    <li>Incoming native value on successful transactions.</li>
    <li>ERC-20 and ERC-721 <code>Transfer</code>s where the address is the sender or recipient.</li>
    <li>We do <strong>not</strong> index internal call traces, re-simulate, or add token
        names / prices — events carry raw on-chain values only.</li>
    <li>No historical backfill: activity only begins at each subscription's activation
        block. Shallow reorgs are compensated with an <code>activity.reverted</code> event.</li>
  </ul>

  <h2>The shape of it</h2>
  <pre><code>POST /v1/webhooks        { "url": "https://you.example/hook" }        → signing secret, once
POST /v1/subscriptions  { "address": "0x1f9…", "chainIds":[8453,10,42161], "webhookId":"wh_…" }
GET  /v1/webhook-deliveries</code></pre>

  <h2>Reliability &amp; limits</h2>
  <ul>
    <li>At-least-once delivery; retry with exponential backoff (~24h), then a
        dead-letter queue an operator can replay.</li>
    <li>Defaults: up to <strong>1,000</strong> active subscriptions and
      <strong>20</strong> distinct chains per account.</li>
    <li>Signed test deliveries and a full delivery ledger are part of the API.</li>
  </ul>

  <h2>Skills</h2>
  <p>Agent-ready skills for this product live in the repo:</p>
  <ul>
    <li><a target="_blank" href="https://github.com/stephancill/stupid-wallet-webhooks/tree/main/skills/operator">operator</a>
      — run the live service: provision, health/lag, pause/resume, DLQ replay, deploy, metrics.</li>
    <li><a target="_blank" href="https://github.com/stephancill/stupid-wallet-webhooks/tree/main/skills/subscriber">subscriber</a>
      — set up webhooks, subscribe addresses, and verify signed deliveries.</li>
  </ul>

  <h2>Docs</h2>
  <p>Full reference: <a target="_blank" href="https://github.com/stephancill/stupid-wallet-webhooks/blob/main/docs/api.md">API reference</a>.</p>

  <p>Access is provisioned per account (an operator issues your API key). For access or
  support, contact <a target="_blank" href="mailto:hi@stupidtech.net">hi@stupidtech.net</a>.</p>

  <p>
    <a target="_blank" href="https://github.com/stephancill/stupid-wallet-webhooks">github</a>
    -
    <a target="_blank" href="https://x.com/stephancill">twitter</a>
    -
    <a target="_blank" href="https://stupidtech.net">stupidtech.net</a>
  </p>
</body>
</html>`;